import {get, post, requestBody} from '@loopback/rest';
import axios from 'axios';
import EventEmitter from 'events';
import OpenAI from 'openai';
import {RunSubmitToolOutputsParams} from 'openai/resources/beta/threads/runs/runs';

// In-memory lock set to prevent concurrent thread creation (use Redis or another store for distributed systems)
const threadLocks = new Set<string>();

export const assistantEvents = new EventEmitter();

export class MessageController {
  private openai: OpenAI;
  private readonly TIMEOUT = 30000; // Increased timeout to 30 seconds
  private readonly POLL_INTERVAL = 1000; // 1 second between status checks

  @get('/api/message')
  message(): object {
    return {message: 'Hello from LoopBack'};
  }

  @post('/api/run-assistant', {
    responses: {
      '200': {
        description: 'Assistant Response',
        content: {'application/json': {schema: {type: 'object'}}},
      },
    },
    cors: {
      origin: [
        'https://mixituponline.com',
        'http://localhost:3000',
        'https://glacial-bayou-78142-e7f743daa346.herokuapp.com',
      ],
      methods: ['POST'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
      exposedHeaders: ['Content-Type'],
      credentials: true,
    },
  })
  async runAssistant(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              message: {type: 'string'},
              assistantId: {type: 'string'},
              threadId: {type: 'string'},
              apiKeyName: {type: 'string'},
              wordpressUrl: {type: 'string'},
              zapier_webhook_url: {type: 'string'},
            },
            required: ['message', 'assistantId', 'apiKeyName', 'wordpressUrl', 'zapier_webhook_url'],
          },
        },
      },
    })
    data: {
      message: string;
      assistantId: string;
      threadId?: string;
      apiKeyName: string;
      wordpressUrl: string;
      zapier_webhook_url: string;
    },
  ): Promise<object> {
    try {
      console.log('Received data:', data);
      const startTime = Date.now();

      // Fetch the OpenAI API key from WordPress
      const apiKey = await this.fetchApiKeyFromWordPress(data.wordpressUrl, data.apiKeyName);
      if (!apiKey) {
        throw new Error('API key not found');
      }

      // Initialize OpenAI client
      this.openai = new OpenAI({apiKey, maxRetries: 4});

      // Retrieve or create thread with locking
      const thread = await this.getThreadWithLock(data);

      // Add the user message to the thread
      await this.openai.beta.threads.messages.create(thread.id, {
        role: 'user',
        content: data.message,
      });
      console.log('Added user message to thread.');

      // Start the run
      const initialRun = await this.openai.beta.threads.runs.createAndPoll(thread.id, {
        assistant_id: data.assistantId,
      });
      console.log('Run initiated with status:', initialRun.status);

      // Poll for completion or required actions
      let currentRun = initialRun;
      while (['in_progress', 'queued', 'requires_action'].includes(currentRun.status)) {
        if (Date.now() - startTime > this.TIMEOUT) {
          throw new Error('Operation timeout');
        }

        await new Promise((resolve) => setTimeout(resolve, this.POLL_INTERVAL));
        currentRun = await this.checkRunStatus(
          thread.id,
          currentRun.id,
          startTime,
          data.zapier_webhook_url,
          data.wordpressUrl,
        );
        console.log('Updated run status:', currentRun.status);
      }

      // Retrieve all messages from the thread
      const messages = await this.openai.beta.threads.messages.list(thread.id);
      console.log('All Messages:', JSON.stringify(messages.data, null, 2));

      // Extract the latest assistant message correctly
      const latestAssistantMessage = messages.data
        .filter((msg) => msg.role === 'assistant')
        .sort((a, b) => b.created_at - a.created_at)[0]?.content[0];

      const messageContent =
        latestAssistantMessage && 'text' in latestAssistantMessage
          ? latestAssistantMessage.text.value
          : 'No assistant response available.';

      console.log('Latest Assistant Message:', messageContent);

      // Return all messages and the latest assistant message
      return {
        success: true,
        threadId: thread.id,
        runId: currentRun.id,
        status: currentRun.status,
        allMessages: messages.data, // All messages in the thread
        messages: [messageContent], // Latest assistant message
      };
    } catch (error) {
      console.error('Error running assistant:', error);
      return {error: 'An error occurred while running the assistant'};
    }
  }

  /**
   * Retrieves an existing thread or creates a new one with proper locking to prevent race conditions.
   * @param data The input data containing threadId and assistant information.
   * @returns The retrieved or newly created thread.
   */
  private async getThreadWithLock(data: {
    threadId?: string;
    assistantId: string;
  }): Promise<any> {
    const threadKey = data.assistantId; // Use a unique key per assistant or user session

    // Simple in-memory lock (not suitable for distributed systems)
    while (threadLocks.has(threadKey)) {
      console.log(`Thread lock active for key: ${threadKey}. Waiting...`);
      await new Promise((resolve) => setTimeout(resolve, 100)); // Wait 100ms before retrying
    }

    threadLocks.add(threadKey);
    try {
      if (data.threadId && data.threadId.trim() !== '') {
        try {
          const existingThread = await this.openai.beta.threads.retrieve(data.threadId);
          console.log(`Retrieved existing thread with ID: ${data.threadId}`);
          return existingThread;
        } catch (error) {
          console.warn(
            `Failed to retrieve thread with ID ${data.threadId}. Creating a new thread.`,
            error,
          );
          // Proceed to create a new thread
        }
      }

      // Create a new thread if threadId is not provided or retrieval failed
      const newThread = await this.openai.beta.threads.create();
      console.log(`Created new thread with ID: ${newThread.id}`);
      return newThread;
    } catch (error) {
      console.error('Error in getThreadWithLock:', error);
      throw new Error('Failed to retrieve or create thread');
    } finally {
      threadLocks.delete(threadKey);
      console.log(`Released thread lock for key: ${threadKey}`);
    }
  }

  /**
   * Checks the status of a run and processes tool calls if required.
   * @param threadId The ID of the thread.
   * @param runId The ID of the run.
   * @param startTime The timestamp when the operation started.
   * @param zapier_webhook_url The webhook URL for Zapier.
   * @returns The updated run object.
   */
  private async checkRunStatus(
    threadId: string,
    runId: string,
    startTime: number,
    zapier_webhook_url: string,
    wordpressUrl: string,
  ): Promise<any> {
    try {
      const run = await this.openai.beta.threads.runs.retrieve(threadId, runId);
      console.log('Run status:', run.status);

      if (run.status === 'requires_action') {
        const toolCalls = run.required_action?.submit_tool_outputs.tool_calls;
        console.log('Tool calls:', toolCalls);

        if (toolCalls && toolCalls.length > 0) {
          try {
            const toolOutputs: RunSubmitToolOutputsParams.ToolOutput[] = await Promise.race([
              Promise.all(
                toolCalls.map(async (toolCall) => {
                  console.log('Processing tool call:', toolCall.function.name);
                  try {
                    const args = JSON.parse(toolCall.function.arguments);
                    console.log('Sending request with args:', args);

                    const requestBody = {
                      ...args,
                      webhook_url: zapier_webhook_url,
                      report_type: 'mixituponline',
                      status: 'pending',
                    };

                    console.log('Final request body:', requestBody);

                    const response = await axios.post(
                      '${data.wordpressUrl}/wp-json/brand-voice/v1/submit',
                      requestBody,
                      {
                        timeout: 5000,
                        headers: {
                          'Content-Type': 'application/json',
                          Accept: 'application/json',
                        },
                      },
                    );

                    console.log('Response from server:', response.data);

                    return {
                      tool_call_id: toolCall.id,
                      output: JSON.stringify(response.data),
                    };
                  } catch (error) {
                    if (axios.isAxiosError(error)) {
                      console.error('Axios error details:', {
                        response: error.response?.data,
                        status: error.response?.status,
                        headers: error.response?.headers,
                        config: error.config,
                      });
                    }
                    console.error('Tool call error:', error);
                    return {
                      tool_call_id: toolCall.id,
                      output: JSON.stringify({
                        error: 'Failed to process tool call',
                        details: error.response?.data || error.message,
                      }),
                    };
                  }
                }),
              ),
              new Promise<RunSubmitToolOutputsParams.ToolOutput[]>((_, reject) =>
                setTimeout(() => reject(new Error('Tool calls timeout')), 10000),
              ),
            ]) as RunSubmitToolOutputsParams.ToolOutput[];

            await this.openai.beta.threads.runs.submitToolOutputs(threadId, runId, {
              tool_outputs: toolOutputs,
            });

            console.log('Submitted tool outputs successfully.');

            return await this.openai.beta.threads.runs.retrieve(threadId, runId);
          } catch (error) {
            console.error('Error processing tool calls:', error);
            throw new Error('Failed to process tool calls: ' + error.message);
          }
        }
      }

      if (Date.now() - startTime > this.TIMEOUT - 2000) {
        throw new Error('Operation timeout');
      }

      return run;
    } catch (error) {
      console.error('Error in checkRunStatus:', error);
      throw error;
    }
  }

  /**
   * Fetches the OpenAI API key from WordPress.
   * @param wordpressUrl The base URL of the WordPress site.
   * @param apiKeyName The name of the API key to fetch.
   * @returns The API key as a string or null if not found.
   */
  private async fetchApiKeyFromWordPress(
    wordpressUrl: string,
    apiKeyName: string,
  ): Promise<string | null> {
    console.log('Fetching API key from WordPress:', wordpressUrl, apiKeyName);
    try {
      const response = await axios.get(
        `${wordpressUrl}/wp-json/gpt-chat/v1/api-keys`,
        {
          params: {gpt_chat_api_key_name: apiKeyName},
          timeout: 5000, // Optional: Add a timeout to prevent hanging
        },
      );
      console.log('API key fetch response:', response.data.apiKey);
      return response.data.apiKey || null;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error('Axios error details:', {
          response: error.response?.data,
          status: error.response?.status,
          headers: error.response?.headers,
          config: error.config,
        });
      }
      console.error('Failed to fetch API key from WordPress:', error);
      return null;
    }
  }
}
