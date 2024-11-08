import {get, post, requestBody} from '@loopback/rest';
import axios from 'axios';
import OpenAI from 'openai';

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
      origin: ['https://mixituponline.com', 'http://localhost:3000'],
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
              webhookUrl: {type: 'string'},
            },
            required: ['message', 'assistantId', 'apiKeyName', 'wordpressUrl', 'webhookUrl'],
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
      webhookUrl: string;
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

      // Start the run
      let currentRun = await this.openai.beta.threads.runs.create(thread.id, {
        assistant_id: data.assistantId,
      });

      // Poll for completion or required actions
      while (['in_progress', 'queued', 'requires_action'].includes(currentRun.status)) {
        // Check for timeout
        if (Date.now() - startTime > this.TIMEOUT) {
          throw new Error('Operation timeout');
        }

        await new Promise(resolve => setTimeout(resolve, this.POLL_INTERVAL));
        currentRun = await this.checkRunStatus(thread.id, currentRun.id, startTime);
        console.log('Updated run status:', currentRun.status);
      }

      const messages = await this.openai.beta.threads.messages.list(thread.id);
      const lastMessage = messages.data[0]?.content[0];
      const messageContent = lastMessage && 'text' in lastMessage ? lastMessage.text.value : '';

      return {
        success: true,
        threadId: thread.id,
        runId: currentRun.id,
        status: currentRun.status,
        allMessages: messages.data,
        messages: [messageContent]
      };

    } catch (error) {
      console.error('Error in runAssistant:', error);
      return {
        success: false,
        error: error.message || 'An error occurred',
        status: 'error'
      };
    }
  }

  private async checkRunStatus(threadId: string, runId: string, startTime: number) {
    const run = await this.openai.beta.threads.runs.retrieve(threadId, runId);
    console.log('Run status:', run.status);

    if (run.status === 'requires_action') {
      const toolCalls = run.required_action?.submit_tool_outputs.tool_calls;
      console.log('Tool calls:', toolCalls);

      if (toolCalls) {
        try {
          // Set a timeout for tool calls processing
          const toolOutputs = await Promise.race([
            Promise.all(toolCalls.map(async (toolCall) => {
              console.log('Processing tool call:', toolCall.function.name);
              try {
                const args = JSON.parse(toolCall.function.arguments);
                const response = await axios.post(
                  'https://mixituponline.com/wp-json/brand-voice/v1/submit',
                  {
                    ...args,
                    webhook_url: process.env.ZAPIER_WEBHOOK_URL || 'https://hooks.zapier.com/hooks/catch/YOUR_WEBHOOK'
                  },
                  {timeout: 5000} // 5 second timeout for the API call
                );

                return {
                  tool_call_id: toolCall.id,
                  output: JSON.stringify(response.data)
                };
              } catch (error) {
                console.error('Tool call error:', error);
                return {
                  tool_call_id: toolCall.id,
                  output: JSON.stringify({error: 'Failed to process tool call'})
                };
              }
            })),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Tool calls timeout')), 10000)
            )
          ]);

          await this.openai.beta.threads.runs.submitToolOutputs(
            threadId,
            runId,
            {tool_outputs: toolOutputs}
          );
        } catch (error) {
          console.error('Error processing tool calls:', error);
          throw new Error('Failed to process tool calls: ' + error.message);
        }
      }
    }

    // Check if we're about to timeout
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
