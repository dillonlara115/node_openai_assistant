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
            // Process all tool calls and collect their outputs
            const toolOutputs = await Promise.all(toolCalls.map(async (toolCall) => {
              console.log('Processing tool call:', toolCall.function.name);

              try {
                const args = JSON.parse(toolCall.function.arguments);
                console.log('Function arguments for', toolCall.id, ':', args);

                const response = await axios.post(
                  'https://mixituponline.com/wp-json/brand-voice/v1/submit',
                  args
                );
                console.log('API Response for', toolCall.id, ':', response.data);

                return {
                  tool_call_id: toolCall.id,
                  output: JSON.stringify(response.data)
                };
              } catch (error) {
                console.error('Error in function call:', error);
                return {
                  tool_call_id: toolCall.id,
                  output: JSON.stringify({error: 'Failed to process report'})
                };
              }
            }));

            // Submit all tool outputs together
            await this.openai.beta.threads.runs.submitToolOutputs(
              threadId,
              runId,
              {tool_outputs: toolOutputs}
            );

            // Get updated run status after submitting tool outputs
            return this.openai.beta.threads.runs.retrieve(threadId, runId);
          }
        }
        return run;
      };

      // Start the run
      const initialRun = await this.openai.beta.threads.runs.createAndPoll(thread.id, {
        assistant_id: data.assistantId,
      });

      // Poll for completion or required actions
      let currentRun = await checkRunStatus(thread.id, initialRun.id);
      while (['in_progress', 'queued', 'requires_action'].includes(currentRun.status)) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        currentRun = await checkRunStatus(thread.id, initialRun.id);
        console.log('Updated run status:', currentRun.status); // Added for debugging
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
