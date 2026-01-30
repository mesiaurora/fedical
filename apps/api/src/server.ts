import { buildApp } from "./app.js";

const app = buildApp();

const port = Number(process.env.PORT ?? 3000);

app
  .listen({ port, host: "127.0.0.1" })
  .then(() => {
    app.log.info(`Listening on http://127.0.0.1:${port}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });