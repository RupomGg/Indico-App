import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { runIndexerLoop } from "./worker.js";

async function main() {
  const app = buildApp();

  try {
    const address = await app.listen({
      port: env.PORT,
      host: env.HOST,
    });
    console.log(`🚀 Indico Backend Server listening at ${address}`);
    console.log(`📚 Interactive OpenAPI / Swagger Docs at ${address}/docs`);

    // In single-instance cloud environments (Railway / Render), run worker in background
    if (env.RUN_WORKER === "true" || process.env.RUN_WORKER === "true") {
      console.log("⚡ [Single-Instance Mode] Running background blockchain worker alongside server...");
      runIndexerLoop().catch((err) => {
        console.error("❌ [Worker] Error in background worker loop:", err);
      });
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
