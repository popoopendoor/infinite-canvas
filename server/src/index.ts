import { createServer } from "node:http";
import { assertProductionConfig, loadConfig } from "./config.js";
import { markInFlightTasksForReconciliation, openDatabase } from "./db.js";
import { createApp } from "./http.js";
import { createLogger } from "./logger.js";
import { BridgeClient } from "./billing/bridge-client.js";
import { CustomCapabilityService } from "./billing/custom-capability.js";
import { HttpProviderExecutor } from "./provider/executor.js";

const CAPABILITY_EXPIRY_SWEEP_MS = 60_000;

const config = loadConfig();
assertProductionConfig(config);
const db = openDatabase(config.databasePath);
const recoveredTasks = markInFlightTasksForReconciliation(db);
const logger = createLogger(config.logLevel);
const bridge = new BridgeClient(config);
const provider = new HttpProviderExecutor(
  config,
  config.modelProviderTimeoutMs,
);
const customCapabilities = new CustomCapabilityService(db, bridge, provider);
const app = createApp({
  config,
  db,
  logger,
  bridge,
  provider,
  customCapabilities,
});
const server = createServer(app);
const capabilityExpiryTimer = setInterval(() => {
  try {
    const expired = customCapabilities.expire();
    if (expired) logger.info("canvas_capabilities_expired", { expired });
  } catch (error) {
    logger.error("canvas_capability_expiry_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}, CAPABILITY_EXPIRY_SWEEP_MS);
capabilityExpiryTimer.unref();

server.listen(config.port, "0.0.0.0", () =>
  logger.info("canvas_bff_started", { port: config.port, recoveredTasks }),
);

function shutdown(signal: string) {
  logger.info("canvas_bff_stopping", { signal });
  clearInterval(capabilityExpiryTimer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
