import {ApplicationConfig, OpenaiVercelApplication} from './application';

export * from './application';

export async function main(options: ApplicationConfig = {}) {
  const app = new OpenaiVercelApplication(options);
  await app.boot();
  await app.start();

  const url = app.restServer.url;
  console.log(`Server is running at ${url}`);
  console.log(`Try ${url}/ping`);

  return app;
}

if (require.main === module) {
  // Run the application
  const config = {
    rest: {
      // Use Heroku's PORT environment variable, default to 7753 if not available
      port: +(process.env.PORT || 7753),
      // Use 0.0.0.0 to bind to all network interfaces for Heroku
      host: process.env.HOST || '0.0.0.0',
      gracePeriodForClose: 5000, // 5 seconds
      openApiSpec: {
        setServersFromRequest: true,
      },
    },
  };
  main(config).catch((err) => {
    console.error('Cannot start the application.', err);
    process.exit(1);
  });
}
