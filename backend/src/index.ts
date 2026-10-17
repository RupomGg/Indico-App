import { buildApp } from "./app.js";
import { env } from "./config/env.js";

async function main() {
  const app = buildApp();

  try {
    const address = await app.listen({
      port: env.PORT,
      host: env.HOST,
    });
    console.log(`🚀 Indico Backend Server listening at ${address}`);
    console.log(`📚 Interactive OpenAPI / Swagger Docs at ${address}/docs`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
