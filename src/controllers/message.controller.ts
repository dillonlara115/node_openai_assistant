import {get, post, requestBody} from '@loopback/rest';
import axios from 'axios';
import EventEmitter from 'events';
import OpenAI from 'openai';
import {RunSubmitToolOutputsParams} from 'openai/resources/beta/threads/runs/runs';

export const assistantEvents = new EventEmitter();

export class MessageController {
  private openai: OpenAI;
  private readonly TIMEOUT = 25000; // 25 seconds to stay under Heroku's 30s limit
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
      origin: ['https://mixituponline.com', 'http://localhost:3000', 'https://glacial-bayou-78142-e7f743daa346.herokuapp.com'],
      methods: ['POST'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
      exposedHeaders: ['Content-Type'],
      credentials: true,
    }
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
              zapier_webhook_url: {type: 'string'}
            },
            required: ['message', 'assistantId', 'apiKeyName', 'wordpressUrl', 'zapier_webhook_url'],
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

      let thread;
      let isNewThread = false;

      // Create or retrieve thread
      if (data.threadId && data.threadId !== '') {
        thread = await this.openai.beta.threads.retrieve(data.threadId);
      } else {
        thread = await this.openai.beta.threads.create();
        isNewThread = true;
      }

      // If it's a new thread or a continued one, add the user message
      if (isNewThread || (data.message && data.message.trim() !== '')) {
        await this.openai.beta.threads.messages.create(thread.id, {
          role: 'user',
          content: data.message,
        });
      }

      // Check for existing runs in the thread
      const runs = await this.openai.beta.threads.runs.list(thread.id);
      const activeRun = runs.data.find(run =>
        ['in_progress', 'queued', 'requires_action'].includes(run.status)
      );

      let currentRun;

      // Use active run or create a new one if none exists
      if (activeRun) {
        console.log('Found active run:', activeRun.id);
        currentRun = activeRun;
      } else {
        currentRun = await this.openai.beta.threads.runs.create(thread.id, {
          assistant_id: data.assistantId,
        });
      }

      // Poll for completion or required actions
      while (['in_progress', 'queued', 'requires_action'].includes(currentRun.status)) {
        if (Date.now() - startTime > this.TIMEOUT) {
          throw new Error('Operation timeout');
        }

        await new Promise(resolve => setTimeout(resolve, this.POLL_INTERVAL));
        currentRun = await this.checkRunStatus(thread.id, currentRun.id, startTime, data.zapier_webhook_url);
        console.log('Updated run status:', currentRun.status);
      }

      // Get the latest message from the assistant
      const messages = await this.openai.beta.threads.messages.list(thread.id);
      const lastMessage = messages.data[messages.data.length - 1]?.content[0];
      const messageContent = lastMessage && 'text' in lastMessage ? lastMessage.text.value : '';

      // Update the return structure to match what the chatbot expects
      return {
        success: true,
        threadId: thread.id,
        runId: currentRun.id,
        status: currentRun.status,
        allMessages: messages.data,
        messages: [messageContent]
      };
    } catch (error) {
      console.error('Error running assistant:', error);
      return {error: 'An error occurred while running the assistant'};
    }
  }


  // Define checkRunStatus as a method of the class
  private async checkRunStatus(
    threadId: string,
    runId: string,
    startTime: number,
    zapier_webhook_url: string
  ): Promise<any> {
    const run = await this.openai.beta.threads.runs.retrieve(threadId, runId);
    console.log('Run status:', run.status);

    if (run.status === 'requires_action') {
      const toolCalls = run.required_action?.submit_tool_outputs.tool_calls;
      console.log('Tool calls:', toolCalls);

      if (toolCalls) {
        try {
          const toolOutputs: RunSubmitToolOutputsParams.ToolOutput[] = await Promise.race([
            Promise.all(toolCalls.map(async (toolCall) => {
              console.log('Processing tool call:', toolCall.function.name);
              try {
                const args = JSON.parse(toolCall.function.arguments);
                console.log('Sending request with args:', args);

                const requestBody = {
                  ...args,
                  webhook_url: zapier_webhook_url,
                  report_type: 'brand_voice',
                  status: 'pending'
                };

                console.log('Final request body:', requestBody);

                const response = await axios.post(
                  'https://mixituponline.com/wp-json/brand-voice/v1/submit',
                  requestBody,
                  {
                    timeout: 5000,
                    headers: {
                      'Content-Type': 'application/json',
                      'Accept': 'application/json'
                    }
                  }
                );

                console.log('Response from server:', response.data);

                return {
                  tool_call_id: toolCall.id,
                  output: JSON.stringify(response.data)
                };
              } catch (error) {
                if (axios.isAxiosError(error)) {
                  console.error('Axios error details:', {
                    response: error.response?.data,
                    status: error.response?.status,
                    headers: error.response?.headers,
                    config: error.config
                  });
                }
                console.error('Tool call error:', error);
                return {
                  tool_call_id: toolCall.id,
                  output: JSON.stringify({
                    error: 'Failed to process tool call',
                    details: error.response?.data || error.message
                  })
                };
              }
            })),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Tool calls timeout')), 10000)
            )
          ]) as RunSubmitToolOutputsParams.ToolOutput[];

          await this.openai.beta.threads.runs.submitToolOutputs(
            threadId,
            runId,
            {tool_outputs: toolOutputs}
          );

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
  }

  private async fetchApiKeyFromWordPress(wordpressUrl: string, apiKeyName: string): Promise<string | null> {
    console.log('Fetching API key from WordPress:', wordpressUrl, apiKeyName);
    try {
      const response = await axios.get(
        `${wordpressUrl}/wp-json/gpt-chat/v1/api-keys`,
        {
          params: {gpt_chat_api_key_name: apiKeyName},
        }
      );
      console.log('API key fetch response:', response.data.apiKey);
      return response.data.apiKey || null;
    } catch (error) {
      console.error('Failed to fetch API key from WordPress:', error);
      return null;
    }
  }
}
