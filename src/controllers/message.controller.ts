import {get, post, requestBody} from '@loopback/rest';
import axios from 'axios';
import EventEmitter from 'events';
import OpenAI from 'openai';

export const assistantEvents = new EventEmitter();

export class MessageController {
  private openai: OpenAI;

  @get('/api/message')
  message(): object {
    return {message: 'Hello from LoopBack'};
  }

  @post('api/run-assistant')
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
              wordpressUrl: {type: 'string'}
            },
            required: ['message', 'assistantId', 'apiKeyName', 'wordpressUrl'],
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
    },
  ): Promise<object> {
    try {
      console.log('Received data:', data);

      // Fetch the OpenAI API key from WordPress
      const apiKey = await this.fetchApiKeyFromWordPress(data.wordpressUrl, data.apiKeyName);
      if (!apiKey) {
        throw new Error('API key not found');
      }

      // Initialize OpenAI client
      this.openai = new OpenAI({apiKey, maxRetries: 4});

      // Get or create thread
      let thread;
      if (data.threadId && data.threadId !== '') {
        thread = await this.openai.beta.threads.retrieve(data.threadId);
      } else {
        thread = await this.openai.beta.threads.create();
      }

      // Add the user message to the thread
      await this.openai.beta.threads.messages.create(thread.id, {
        role: 'user',
        content: data.message,
      });

      // Create a function to check run status
      const checkRunStatus = async (threadId: string, runId: string) => {
        const run = await this.openai.beta.threads.runs.retrieve(threadId, runId);
        console.log('Run status:', run.status);

        if (run.status === 'requires_action') {
          const toolCalls = run.required_action?.submit_tool_outputs.tool_calls;
          console.log('Tool calls:', toolCalls);

          if (toolCalls) {
            for (const toolCall of toolCalls) {
              console.log('Processing tool call:', toolCall.function.name);

              if (toolCall.function.name === 'submit_branding_report_to_zapier') {
                // Emit event with necessary data
                assistantEvents.emit('brandingReport', {
                  threadId,
                  runId,
                  toolCallId: toolCall.id,
                  arguments: JSON.parse(toolCall.function.arguments)
                });

                // Wait for the response
                const result = await new Promise((resolve) => {
                  assistantEvents.once('brandingReportComplete', resolve);
                });

                // Submit the result back to the assistant
                await this.openai.beta.threads.runs.submitToolOutputs(
                  threadId,
                  runId,
                  {
                    tool_outputs: [{
                      tool_call_id: toolCall.id,
                      output: JSON.stringify(result)
                    }]
                  }
                );
              }
            }
          }
        }
        return run;
      };

      // Start the run
      const initialRun = await this.openai.beta.threads.runs.create(thread.id, {
        assistant_id: data.assistantId,
      });

      // Poll for completion or required actions
      let currentRun = await checkRunStatus(thread.id, initialRun.id);
      while (currentRun.status === 'in_progress' || currentRun.status === 'queued') {
        await new Promise(resolve => setTimeout(resolve, 1000));
        currentRun = await checkRunStatus(thread.id, initialRun.id);
      }

      const messages = await this.openai.beta.threads.messages.list(thread.id);
      const lastMessage = messages.data[0]?.content[0];
      const messageContent = lastMessage && 'text' in lastMessage ? lastMessage.text.value : '';

      // Update the return structure to match what the chatbot expects
      return {
        success: true,
        threadId: thread.id,
        runId: currentRun.id,
        status: currentRun.status,
        allMessages: messages.data, // Changed from 'message' to 'response'
        messages: [messageContent]  // Adding full messages array if needed
      };
    } catch (error) {
      console.error('Error running assistant:', error);
      return {error: 'An error occurred while running the assistant'};
    }
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
