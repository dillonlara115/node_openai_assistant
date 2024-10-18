import {get, post, requestBody} from '@loopback/rest';
import axios from 'axios';
import OpenAI from 'openai';

export class MessageController {
  private openai: OpenAI;

  @get('/api/message')
  message(): object {
    return {message: 'Hello from LoopBack'};
  }

  @post('/api/run-assistant')
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
              apiKeyName: {type: 'string'}, // NEW: API key name sent with request
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

      // Fetch the OpenAI API key from WordPress using the provided key name
      const apiKey = await this.fetchApiKeyFromWordPress(data.wordpressUrl, data.apiKeyName);

      if (!apiKey) {
        throw new Error('API key not found');
      }

      // Initialize OpenAI client with the fetched API key
      this.openai = new OpenAI({
        apiKey: apiKey,
      });


      let thread;
      if (data.threadId && data.threadId !== '') {
        // Use existing thread
        thread = await this.openai.beta.threads.retrieve(data.threadId);
        if (!thread) {
          throw new Error(`Thread with ID ${data.threadId} not found`);
        }
      } else {
        // Create a new thread
        thread = await this.openai.beta.threads.create();
      }


      // Add the initial message to the thread
      await this.openai.beta.threads.messages.create(thread.id, {
        role: 'user',
        content: data.message,
      });

      // Step 4: Stream the assistant's response
      const run = this.openai.beta.threads.runs.stream(thread.id, {
        assistant_id: data.assistantId,
      });

      // NEW: Initialize an empty string to accumulate the text from deltas
      let accumulatedText = '';

      run.on('textDelta', (delta) => {
        // Access the 'value' directly from the delta object
        if (delta.value) {
          accumulatedText += delta.value;
        }
        console.log('Received text delta:', delta.value);
      });

      run.on('messageDelta', (delta, snapshot) => {
        // Process any message-level deltas
        console.log('Received message delta:', delta);
      });

      run.on('event', (event) => {
        // Log any events that occur during the stream
        console.log('Received event:', event);
      });

      run.on('run', (run) => {
        // Log when the run completes
        console.log('Run completed:', run);
      });

      const finalResult = await run.finalRun(); // Wait for the stream to complete
      console.log('Final run result:', finalResult);

      // Step 5: Return the accumulated text after streaming completes
      return {
        success: true,
        threadId: thread.id,
        runResult: finalResult,  // You can return any useful metadata from the final result here
        messages: [accumulatedText],  // Return the full accumulated message as an array
      };
    } catch (error) {
      console.error('Error running assistant:', error);
      return {error: 'An error occurred while running the assistant'};
    }
  }

  /**
   * Fetches the OpenAI API key from the WordPress plugin.
   * @param wordpressUrl The base URL of the WordPress site.
   * @param apiKeyName The name of the API key to retrieve.
   * @returns The API key string.
   */
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
