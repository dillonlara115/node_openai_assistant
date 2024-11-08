import {BootMixin} from '@loopback/boot';
import {ApplicationConfig} from '@loopback/core';
import {RepositoryMixin} from '@loopback/repository';
import {RestApplication} from '@loopback/rest';
import {ServiceMixin} from '@loopback/service-proxy';
import {ChatConfigProvider} from './providers/chat-config.provider';
import {ChatConfig} from './types';

export {ApplicationConfig};
export class OpenaiVercelApplication extends BootMixin(
  ServiceMixin(RepositoryMixin(RestApplication)),
) {
  constructor(options: ApplicationConfig = {}) {
    super(options);

    // Configure CORS
    this.bind('rest.config.cors').to({
      origin: ['https://mixituponline.com', 'http://localhost:3000', 'https://glacial-bayou-78142-e7f743daa346.herokuapp.com/api/run-assistant'],
      methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
      preflightContinue: false,
      optionsSuccessStatus: 204,
      maxAge: 86400,
      allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
      exposedHeaders: ['Content-Type'],
      credentials: true
    });
    this.projectRoot = __dirname;
    // Customize @loopback/boot Booter Conventions here
    this.bootOptions = {
      controllers: {
        // Customize ControllerBooter Conventions here
        dirs: ['controllers'],
        extensions: ['.controller.js'],
        nested: true,
      },
    };
    this.bind('services.ChatConfig').toProvider(ChatConfigProvider);

    this.bind('services.UpdateChatConfig').to((newConfig: Partial<ChatConfig>) => {
      const provider = this.getSync<ChatConfigProvider>('services.ChatConfig');
      provider.updateConfig(newConfig);
    });
    // Add CORS support
    this.configure('rest.cors').to({
      origin: '*',
      methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
      preflightContinue: false,
      optionsSuccessStatus: 204,
      maxAge: 86400,
      allowedHeaders: 'Content-Type,Authorization',
      credentials: true,
    });

  }
}
