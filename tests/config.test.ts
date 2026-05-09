import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

test("default Feishu interaction is button-first over long connection", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-feishu-config-"));
  try {
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        storage: {
          homeDir: dir,
          databasePath: join(dir, "bridge.db"),
          logPath: join(dir, "bridge.log")
        },
        feishu: {
          appId: "app",
          appSecret: "secret"
        }
      }),
      "utf8"
    );

    const config = loadConfig(configPath);
    assert.equal(config.feishu.messageTransport, "long_connection");
    assert.equal(config.feishu.cardActionTransport, "long_connection");
    assert.equal(config.feishu.interactionMode, "hybrid");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("config accepts canonical websocket app-server settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-feishu-config-"));
  try {
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        storage: {
          homeDir: dir,
          databasePath: join(dir, "bridge.db"),
          logPath: join(dir, "bridge.log")
        },
        codex: {
          connectionMode: "canonical_websocket",
          websocketListenUrl: "ws://127.0.0.1:47939",
          desktopSocksProxyEnabled: true,
          desktopSocksProxyPort: 1080
        },
        feishu: {
          appId: "app",
          appSecret: "secret"
        }
      }),
      "utf8"
    );

    const config = loadConfig(configPath);

    assert.equal(config.codex.connectionMode, "canonical_websocket");
    assert.equal(config.codex.websocketListenUrl, "ws://127.0.0.1:47939");
    assert.equal(config.codex.websocketUrl, undefined);
    assert.equal(config.codex.desktopSocksProxyEnabled, true);
    assert.equal(config.codex.desktopSocksProxyHost, "127.0.0.1");
    assert.equal(config.codex.desktopSocksProxyPort, 1080);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
