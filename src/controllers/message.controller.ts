import {get, post, requestBody} from '@loopback/rest';
import axios from 'axios';
import EventEmitter from 'events';
import OpenAI from 'openai';

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
      if (data.threadId && data.threadId !== '') {
        thread = await this.openai.beta.threads.retrieve(data.threadId);

        // Check for existing runs
        const runs = await this.openai.beta.threads.runs.list(thread.id);
        const activeRun = runs.data.find(run =>
          ['in_progress', 'queued', 'requires_action'].includes(run.status)
        );

        if (activeRun) {
          console.log('Found active run:', activeRun.id);
          // Cancel the existing run
          try {
            await this.openai.beta.threads.runs.cancel(thread.id, activeRun.id);
            console.log('Cancelled existing run');

            // Wait for cancellation to take effect
            let cancelled = false;
            for (let i = 0; i < 5; i++) { // Retry a few times to ensure cancellation is complete
              await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
              const updatedRuns = await this.openai.beta.threads.runs.list(thread.id);
              const stillActiveRun = updatedRuns.data.find(run =>
                ['in_progress', 'queued', 'requires_action'].includes(run.status)
              );
              if (!stillActiveRun) {
                cancelled = true;
                break;
              }
            }

            if (!cancelled) {
              console.error('Failed to cancel existing run after multiple attempts, creating a new thread instead.');
              thread = await this.openai.beta.threads.create();
            }
          } catch (error) {
            console.error('Error cancelling run:', error);
            // If we can't cancel, create a new thread instead
            thread = await this.openai.beta.threads.create();
          }
        }
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
        if (Date.now() - startTime > this.TIMEOUT) {
          throw new Error('Operation timeout');
        }

        await new Promise(resolve => setTimeout(resolve, this.POLL_INTERVAL));
        currentRun = await this.openai.beta.threads.runs.retrieve(thread.id, currentRun.id);

        if (currentRun.status === 'requires_action') {
          currentRun = await this.checkRunStatus(thread.id, currentRun.id, startTime, data.zapier_webhook_url);
        }
        console.log('Updated run status:', currentRun.status);
      }

      // Get the latest message
      const messages = await this.openai.beta.threads.messages.list(thread.id);
      const lastMessage = messages.data[messages.data.length - 1]?.content[0];
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
