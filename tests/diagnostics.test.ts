import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DiagnosticsService } from "../src/bridge/diagnostics.js";
import { CardRenderer } from "../src/domain/cards.js";
import { makeConfig, makeTempRepo, MockCodex } from "./helpers.js";

test("diagnostics distinguishes normal group chat from full topic-mode group", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    config.feishu.taskContainerMode = "topic";
    const diagnostics = new DiagnosticsService(config, repo, new MockCodex() as any, {
      async getChatInfo() {
        return {
          chatId: "chat_1",
          name: "Codex 控制群",
          chatMode: "group",
          groupMessageType: "chat",
          chatType: "private",
          chatStatus: "normal",
          external: false,
          raw: {}
        };
      }
    });
    const snapshot = await diagnostics.snapshot();
    assert.equal(snapshot.feishuDefaultChatDiagnostic?.ok, true);
    assert.equal(snapshot.feishuDefaultChatDiagnostic?.topicReplySupported, true);
    assert.equal(snapshot.feishuDefaultChatDiagnostic?.fullTopicMode, false);
    assert.match(snapshot.feishuDefaultChatDiagnostic?.recommendation ?? "", /reply_in_thread/);
    assert.match(snapshot.feishuDefaultChatDiagnostic?.recommendation ?? "", /group_message_type/);
  } finally {
    cleanup();
  }
});

test("diagnostics reports topic-mode group as full topic UX", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    config.feishu.taskContainerMode = "topic";
    const diagnostics = new DiagnosticsService(config, repo, new MockCodex() as any, {
      async getChatInfo() {
        return {
          chatId: "chat_1",
          name: "Codex 话题群",
          chatMode: "topic",
          groupMessageType: null,
          chatType: "private",
          chatStatus: "normal",
          external: false,
          raw: {}
        };
      }
    });
    const snapshot = await diagnostics.snapshot();
    assert.equal(snapshot.feishuDefaultChatDiagnostic?.ok, true);
    assert.equal(snapshot.feishuDefaultChatDiagnostic?.fullTopicMode, true);
    assert.match(snapshot.feishuDefaultChatDiagnostic?.recommendation ?? "", /话题消息形式/);
  } finally {
    cleanup();
  }
});

test("diagnostics probes Codex Remote Control prerequisites from local Codex home", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const codexHome = join(dir, ".codex");
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(join(codexHome, "app-server-control"), { recursive: true });
    mkdirSync(join(codexHome, "sqlite"), { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), "[features]\nremote_control = true\n", "utf8");
    writeFileSync(join(codexHome, "app-server-control", "app-server-control.sock"), "", "utf8");
    writeFileSync(
      join(codexHome, ".codex-global-state.json"),
      JSON.stringify({
        "electron-persisted-atom-state": {
          codexCloudAccess: "enabled"
        },
        "electron-remote-control-client-enrollments": {
          controller_1: {
            accountUserId: "acct_user_1",
            algorithm: "ecdsa_p256_sha256",
            clientId: "client_1",
            keyId: "key_1",
            protectionClass: "hardware_tpm",
            publicKeySpkiDerBase64: "abc"
          }
        }
      }),
      "utf8"
    );
    const stateDb = new DatabaseSync(join(codexHome, "state_5.sqlite"));
    stateDb.exec("CREATE TABLE remote_control_enrollments (id TEXT PRIMARY KEY);");
    stateDb.exec("INSERT INTO remote_control_enrollments (id) VALUES ('enrollment_1');");
    stateDb.close();
    const featureDb = new DatabaseSync(join(codexHome, "sqlite", "codex-dev.db"));
    featureDb.exec("CREATE TABLE local_app_server_feature_enablement (feature_name TEXT, enabled INTEGER, updated_at TEXT);");
    featureDb.exec("INSERT INTO local_app_server_feature_enablement (feature_name, enabled, updated_at) VALUES ('remote_control', 1, '2026-05-12T21:00:00.000Z');");
    featureDb.close();

    const config = makeConfig(dir);
    config.codex.appStatePath = join(codexHome, ".codex-global-state.json");
    const diagnostics = new DiagnosticsService(
      config,
      repo,
      new MockCodex() as any,
      undefined,
      {
        execCodex: async (_command, args) => {
          if (args[0] === "--version") return { stdout: "codex 0.1.0" };
          if (args[0] === "login" && args[1] === "status") return { stdout: "Logged in with ChatGPT" };
          throw new Error(`unexpected args: ${args.join(" ")}`);
        }
      }
    );
    const snapshot = await diagnostics.snapshot();

    assert.equal(snapshot.codexAvailable, true);
    assert.ok(snapshot.codexRemoteControl);
    assert.equal(snapshot.codexRemoteControl?.featureEnabled, true);
    assert.equal(snapshot.codexRemoteControl?.enrollmentCount, 1);
    assert.equal(snapshot.codexRemoteControl?.localFeatureState, "enabled");
    assert.equal(snapshot.codexRemoteControl?.localFeatureEntryCount, 1);
    assert.equal(snapshot.codexRemoteControl?.localFeatureUpdatedAt, "2026-05-12T21:00:00.000Z");
    assert.equal(snapshot.codexRemoteControl?.controlSocketExists, true);
    assert.equal(snapshot.codexRemoteControl?.loginAuthMode, "account");
    assert.equal(snapshot.codexRemoteControl?.cloudAccess, "enabled");
    assert.equal(snapshot.codexRemoteControl?.authorizedClientCount, 1);
    assert.equal(existsSync(snapshot.codexRemoteControl?.stateDbPath ?? ""), true);
    assert.equal(existsSync(snapshot.codexRemoteControl?.localFeatureStateDbPath ?? ""), true);
  } finally {
    cleanup();
  }
});

test("diagnostics remote control recommendation points to Desktop account login when only API key auth is available", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const codexHome = join(dir, ".codex");
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(join(codexHome, "sqlite"), { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), "[features]\nremote_control = true\n", "utf8");
    const stateDb = new DatabaseSync(join(codexHome, "state_5.sqlite"));
    stateDb.exec("CREATE TABLE remote_control_enrollments (id TEXT PRIMARY KEY);");
    stateDb.close();
    const featureDb = new DatabaseSync(join(codexHome, "sqlite", "codex-dev.db"));
    featureDb.exec("CREATE TABLE local_app_server_feature_enablement (feature_name TEXT, enabled INTEGER, updated_at TEXT);");
    featureDb.close();

    const config = makeConfig(dir);
    config.codex.appStatePath = join(codexHome, ".codex-global-state.json");
    config.codex.connectionMode = "desktop_auto";
    const diagnostics = new DiagnosticsService(
      config,
      repo,
      new MockCodex() as any,
      undefined,
      {
        execCodex: async (_command, args) => {
          if (args[0] === "--version") return { stdout: "codex 0.1.0" };
          if (args[0] === "login" && args[1] === "status") return { stdout: "Logged in using an API key" };
          throw new Error(`unexpected args: ${args.join(" ")}`);
        }
      }
    );
    const snapshot = await diagnostics.snapshot();
    const recommendation = DiagnosticsService.remoteControlRecommendation(snapshot);

    assert.equal(snapshot.codexRemoteControl?.enrollmentCount, 0);
    assert.equal(snapshot.codexRemoteControl?.localFeatureState, "unset");
    assert.equal(snapshot.codexRemoteControl?.loginAuthMode, "api_key");
    assert.match(recommendation ?? "", /local_app_server_feature_enablement/);
    assert.match(recommendation ?? "", /API key/);
    assert.match(recommendation ?? "", /Remote Control 很可能不会完成 enrollment/);
  } finally {
    cleanup();
  }
});

test("diagnostics remote control recommendation surfaces disabled cloud access even when account auth exists", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const codexHome = join(dir, ".codex");
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(join(codexHome, "sqlite"), { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), "[features]\nremote_control = true\n", "utf8");
    writeFileSync(
      join(codexHome, ".codex-global-state.json"),
      JSON.stringify({
        "electron-persisted-atom-state": {
          codexCloudAccess: "disabled"
        }
      }),
      "utf8"
    );
    const stateDb = new DatabaseSync(join(codexHome, "state_5.sqlite"));
    stateDb.exec("CREATE TABLE remote_control_enrollments (id TEXT PRIMARY KEY);");
    stateDb.close();
    const featureDb = new DatabaseSync(join(codexHome, "sqlite", "codex-dev.db"));
    featureDb.exec("CREATE TABLE local_app_server_feature_enablement (feature_name TEXT, enabled INTEGER, updated_at TEXT);");
    featureDb.exec("INSERT INTO local_app_server_feature_enablement (feature_name, enabled, updated_at) VALUES ('remote_control', 1, '2026-05-12T21:00:00.000Z');");
    featureDb.close();

    const config = makeConfig(dir);
    config.codex.appStatePath = join(codexHome, ".codex-global-state.json");
    config.codex.connectionMode = "desktop_proxy";
    const diagnostics = new DiagnosticsService(
      config,
      repo,
      new MockCodex() as any,
      undefined,
      {
        execCodex: async (_command, args) => {
          if (args[0] === "--version") return { stdout: "codex 0.1.0" };
          if (args[0] === "login" && args[1] === "status") return { stdout: "Logged in with ChatGPT" };
          throw new Error(`unexpected args: ${args.join(" ")}`);
        }
      }
    );
    const snapshot = await diagnostics.snapshot();
    const recommendation = DiagnosticsService.remoteControlRecommendation(snapshot);

    assert.equal(snapshot.codexRemoteControl?.loginAuthMode, "account");
    assert.equal(snapshot.codexRemoteControl?.cloudAccess, "disabled");
    assert.match(recommendation ?? "", /codexCloudAccess/);
    assert.match(recommendation ?? "", /Cloud access/);
    assert.match(recommendation ?? "", /不会完成 enrollment/);
  } finally {
    cleanup();
  }
});

test("diagnostics snapshot does not wait forever when Feishu chat info probe stalls", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const diagnostics = new DiagnosticsService(
      config,
      repo,
      new MockCodex() as any,
      {
        async getChatInfo() {
          return await new Promise<any>(() => undefined);
        }
      },
      {
        execCodex: async (_command, args) => {
          if (args[0] === "--version") return { stdout: "codex 0.1.0" };
          if (args[0] === "login" && args[1] === "status") return { stdout: "Logged in using an API key" };
          throw new Error(`unexpected args: ${args.join(" ")}`);
        },
        chatInfoTimeoutMs: 20
      }
    );
    const started = Date.now();
    const snapshot = await diagnostics.snapshot();

    assert.ok(Date.now() - started < 1000);
    assert.equal(snapshot.feishuDefaultChatDiagnostic?.ok, false);
    assert.match(snapshot.feishuDefaultChatDiagnostic?.error ?? "", /timed out/i);
  } finally {
    cleanup();
  }
});

test("diagnostics desktop ipc recommendation makes claim-only boundary explicit", () => {
  const recommendation = DiagnosticsService.desktopIpcRecommendation({
    uptimeSeconds: 1,
    machineName: "test-machine",
    platform: "win32",
    nodeVersion: process.version,
    codexCommand: "codex",
    codexConnectionMode: "desktop_ipc",
    codexConnectionKind: "desktop_ipc",
    codexDesktopIpc: {
      pipePath: "\\\\.\\pipe\\codex-ipc",
      status: "connected",
      clientId: "bridge-client",
      observedThreads: 2,
      capabilities: {
        appAsarPath: "C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app.asar",
        requestHandlers: [
          "thread-follower-start-turn",
          "thread-follower-steer-turn"
        ],
        requestHandlerCount: 2,
        supportsHostThreadCreation: false,
        supportsThreadGoal: false,
        supportsThreadTitle: false,
        supportsArchiveControl: false,
        supportsFollowerControl: true,
        probeError: null
      }
    },
    codexDesktopProxy: null,
    codexRemoteControl: null,
    codexAvailable: true,
    appServerStatus: "connected",
    feishuConfigured: true,
    feishuMessageTransport: "long_connection",
    feishuCardActionTransport: "long_connection",
    feishuInteractionMode: "hybrid",
    feishuDefaultChatId: "chat_1",
    feishuDefaultChatDiagnostic: null,
    feishuTaskContainerMode: "dedicated_chat",
    databasePath: "bridge.db",
    projectsCount: 0,
    sessionBindingsCount: 0,
    runningTasksCount: 0,
    pendingOutboxCount: 0,
    pendingApprovalsCount: 0,
    notificationPreferenceCount: 0,
    trustedSubjectsCount: 0,
    bridgeDevicesCount: 0,
    currentDevice: null,
    trustedSubjects: [],
    lastFeishuMessageAt: null,
    lastFeishuMessageId: null,
    lastFeishuCardActionAt: null,
    lastFeishuCardAction: null,
    lastFeishuCardActionId: null,
    lastError: null
  });

  assert.match(recommendation ?? "", /不能从飞书直接新建新对话/);
  assert.match(recommendation ?? "", /官方新线程 handler/);
});

test("diagnostics desktop proxy recommendation points to direct app-server first when transport degraded to ipc", () => {
  const recommendation = DiagnosticsService.desktopProxyRecommendation({
    uptimeSeconds: 1,
    machineName: "test-machine",
    platform: "win32",
    nodeVersion: process.version,
    codexCommand: "codex",
    codexConnectionMode: "desktop_proxy",
    codexConnectionKind: "desktop_ipc",
    codexDesktopIpc: {
      pipePath: "\\\\.\\pipe\\codex-ipc",
      status: "connected",
      clientId: "bridge-client",
      observedThreads: 1
    },
    codexDesktopProxy: null,
    codexRemoteControl: null,
    codexAvailable: true,
    appServerStatus: "connected",
    feishuConfigured: true,
    feishuMessageTransport: "long_connection",
    feishuCardActionTransport: "long_connection",
    feishuInteractionMode: "hybrid",
    feishuDefaultChatId: "chat_1",
    feishuDefaultChatDiagnostic: null,
    feishuTaskContainerMode: "dedicated_chat",
    databasePath: "bridge.db",
    projectsCount: 0,
    sessionBindingsCount: 0,
    runningTasksCount: 0,
    pendingOutboxCount: 0,
    pendingApprovalsCount: 0,
    notificationPreferenceCount: 0,
    trustedSubjectsCount: 0,
    bridgeDevicesCount: 0,
    currentDevice: null,
    trustedSubjects: [],
    lastFeishuMessageAt: null,
    lastFeishuMessageId: null,
    lastFeishuCardActionAt: null,
    lastFeishuCardAction: null,
    lastFeishuCardActionId: null,
    lastError: null
  });

  assert.match(recommendation ?? "", /Desktop Proxy 未连接/);
  assert.match(recommendation ?? "", /Codex App Server 直连主线/);
});

test("diagnostic card surfaces local feature store state for remote control", () => {
  const card = new CardRenderer("message_command").diagnosticCard({
    uptimeSeconds: 1,
    machineName: "test-machine",
    platform: "win32",
    nodeVersion: process.version,
    codexCommand: "codex",
    codexConnectionMode: "desktop_auto",
    codexConnectionKind: "desktop_ipc",
    codexDesktopIpc: {
      pipePath: "\\\\.\\pipe\\codex-ipc",
      status: "connected",
      clientId: "bridge-client",
      observedThreads: 1,
      capabilities: null
    },
    codexDesktopProxy: {
      command: "codex app-server",
      status: "disconnected"
    },
    codexRemoteControl: {
      codexHome: "C:\\Users\\EPEANZ\\.codex",
      configPath: "C:\\Users\\EPEANZ\\.codex\\config.toml",
      appStatePath: "C:\\Users\\EPEANZ\\.codex\\.codex-global-state.json",
      featureEnabled: true,
      stateDbPath: "C:\\Users\\EPEANZ\\.codex\\state_5.sqlite",
      enrollmentCount: 0,
      localFeatureStateDbPath: "C:\\Users\\EPEANZ\\.codex\\sqlite\\codex-dev.db",
      localFeatureState: "unset",
      localFeatureEntryCount: 0,
      localFeatureUpdatedAt: null,
      controlSocketPath: "C:\\Users\\EPEANZ\\.codex\\app-server-control\\app-server-control.sock",
      controlSocketExists: false,
      loginStatus: "Not logged in",
      loginAuthMode: "logged_out",
      cloudAccess: "disabled",
      authorizedClientCount: 0,
      probeError: null
    },
    codexAvailable: true,
    appServerStatus: "connected",
    feishuConfigured: true,
    feishuMessageTransport: "long_connection",
    feishuCardActionTransport: "long_connection",
    feishuInteractionMode: "message_command",
    feishuDefaultChatId: "chat_1",
    feishuDefaultChatDiagnostic: null,
    feishuTaskContainerMode: "dedicated_chat",
    databasePath: "bridge.db",
    projectsCount: 0,
    sessionBindingsCount: 0,
    runningTasksCount: 0,
    pendingOutboxCount: 0,
    pendingApprovalsCount: 0,
    notificationPreferenceCount: 0,
    trustedSubjectsCount: 0,
    bridgeDevicesCount: 0,
    currentDevice: null,
    trustedSubjects: [],
    lastFeishuMessageAt: null,
    lastFeishuMessageId: null,
    lastFeishuCardActionAt: null,
    lastFeishuCardAction: null,
    lastFeishuCardActionId: null,
    lastError: null
  });

  const payload = JSON.stringify(card);
  assert.match(payload, /Remote Control 本地特性/);
  assert.match(payload, /未写入/);
  assert.match(payload, /codex-dev\.db/);
});
