#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { BridgeApp } from "./app.js";

const command = process.argv[2] ?? "serve";
const configArgIndex = process.argv.findIndex((arg) => arg === "--config" || arg === "-c");
const configPath = configArgIndex >= 0 ? process.argv[configArgIndex + 1] : undefined;
const config = loadConfig(configPath);

if (command === "serve") {
  const app = new BridgeApp(config);
  const shutdown = async () => {
    await app.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await app.start();
  console.log(`feishu-codex listening on http://${config.server.host}:${config.server.port}`);
  console.log(`admin token: ${config.server.adminToken}`);
} else if (command === "doctor") {
  const app = new BridgeApp(config);
  await app.tasks.bootstrapProjectsFromConfig();
  const snapshot = await app.diagnostics.snapshot();
  console.log(JSON.stringify(snapshot, null, 2));
  app.database.close();
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(2);
}
