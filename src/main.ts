import type { Server } from "node:http";
import { startPanel } from "./panel.js";
import { createServices } from "./services.js";

async function main(): Promise<void> {
  const services = createServices();
  const server = await startPanel(services);
  if (services.config.agent.workerEnabled) services.worker.start();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    services.logger.info("application.shutdown_started", { signal });
    await closeServer(server);
    await services.worker.stop();
    services.store.close();
    services.logger.info("application.shutdown_completed", { signal });
  };

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM").then(() => process.exit(0));
  });
  process.once("SIGINT", () => {
    void shutdown("SIGINT").then(() => process.exit(0));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
