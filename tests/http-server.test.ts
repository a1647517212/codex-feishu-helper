import test from "node:test";
import assert from "node:assert/strict";
import { BridgeHttpServer } from "../src/http/server.js";
import { CardRenderer } from "../src/domain/cards.js";
import { makeConfig, makeLogger, makeTempRepo } from "./helpers.js";

test("http server exposes health, guarded doctor, and Feishu URL verification", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  const config = makeConfig(dir);
  config.server.port = 0;
  config.server.adminToken = "smoke-token";
  config.feishu.verificationToken = "verify-token";
  const diagnostics = {
    recordError(): void {},
    async snapshot() {
      return {
        uptimeSeconds: 1,
        machineName: "test-machine",
        platform: "win32",
        nodeVersion: process.version,
        codexCommand: "codex",
        codexAvailable: true,
        appServerStatus: "connected" as const,
        feishuConfigured: true,
        databasePath: config.storage.databasePath,
        projectsCount: 0,
        sessionBindingsCount: repo.count("session_bindings"),
        runningTasksCount: 0,
        pendingOutboxCount: 0,
        pendingApprovalsCount: 0,
        lastError: null
      };
    }
  };
  const tasks = {
    async handleMessage(): Promise<void> {},
    async handleCardAction(): Promise<{ ok: boolean }> {
      return { ok: true };
    }
  };
  const server = new BridgeHttpServer(config, tasks as any, diagnostics as any, new CardRenderer(), makeLogger(dir));
  try {
    await server.start();
    const base = server.localUrl();
    const health = await getJson(`${base}/healthz`);
    assert.deepEqual(health, { ok: true });

    const unauthorized = await fetch(`${base}/doctor`);
    assert.equal(unauthorized.status, 401);

    const doctor = await getJson(`${base}/doctor`, {
      headers: { authorization: "Bearer smoke-token" }
    });
    assert.equal(doctor.ok, true);
    assert.equal(doctor.snapshot.appServerStatus, "connected");

    const verification = await postJson(`${base}/feishu/events`, {
      type: "url_verification",
      token: "verify-token",
      challenge: "ok-smoke"
    });
    assert.deepEqual(verification, { challenge: "ok-smoke" });
  } finally {
    await server.stop();
    cleanup();
  }
});

const getJson = async (url: string, init?: RequestInit): Promise<any> => {
  const response = await fetch(url, init);
  assert.equal(response.status, 200);
  return response.json();
};

const postJson = async (url: string, body: Record<string, unknown>): Promise<any> => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.equal(response.status, 200);
  return response.json();
};
