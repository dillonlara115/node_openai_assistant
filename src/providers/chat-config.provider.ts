import {Provider} from '@loopback/core';
import {ChatConfig} from '../types';

export class ChatConfigProvider implements Provider<ChatConfig> {
  private config: ChatConfig = {
    wordpressUrl: '',
    authToken: '',
  };

  value(): ChatConfig {
    return this.config;
  }

  updateConfig(newConfig: Partial<ChatConfig>) {
    this.config = {...this.config, ...newConfig};
  }
}
