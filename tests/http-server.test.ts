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
  config.feishu.messageTransport = "http_callback";
  config.feishu.cardActionTransport = "http_callback";
  const diagnostics = {
    recordError(): void {},
    recordFeishuMessage(): void {},
    recordFeishuCardAction(): void {},
    async snapshot() {
      return {
        uptimeSeconds: 1,
        machineName: "test-machine",
        platform: "win32",
        nodeVersion: process.version,
        codexCommand: "codex",
        codexConnectionMode: config.codex.connectionMode,
        codexConnectionKind: "desktop_ipc" as const,
        codexDesktopIpc: null,
        codexDesktopProxy: null,
        codexRemoteControl: null,
        codexAvailable: true,
        appServerStatus: "connected" as const,
        feishuConfigured: true,
        feishuMessageTransport: config.feishu.messageTransport,
        feishuCardActionTransport: config.feishu.cardActionTransport,
        feishuInteractionMode: config.feishu.interactionMode,
        feishuDefaultChatId: config.feishu.defaultChatId ?? null,
        feishuDefaultChatDiagnostic: null,
        feishuTaskContainerMode: config.feishu.taskContainerMode,
        databasePath: config.storage.databasePath,
        projectsCount: 0,
        sessionBindingsCount: repo.count("session_bindings"),
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
      };
    }
  };
  const tasks = {
    async handleMessage(): Promise<void> {},
    async processCardActionDeferred(): Promise<void> {}
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

test("http callback endpoints are disabled when long connection transport is active", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  const config = makeConfig(dir);
  config.server.port = 0;
  config.server.mode = "enabled";
  config.feishu.messageTransport = "long_connection";
  config.feishu.cardActionTransport = "long_connection";
  const diagnostics = {
    recordError(): void {},
    recordFeishuMessage(): void {},
    recordFeishuCardAction(): void {},
    async snapshot() {
      return {
        uptimeSeconds: 1,
        machineName: "test-machine",
        platform: "win32",
        nodeVersion: process.version,
        codexCommand: "codex",
        codexConnectionMode: config.codex.connectionMode,
        codexConnectionKind: "desktop_ipc" as const,
        codexDesktopIpc: null,
        codexDesktopProxy: null,
        codexRemoteControl: null,
        codexAvailable: true,
        appServerStatus: "connected" as const,
        feishuConfigured: true,
        feishuMessageTransport: config.feishu.messageTransport,
        feishuCardActionTransport: config.feishu.cardActionTransport,
        feishuInteractionMode: config.feishu.interactionMode,
        feishuDefaultChatId: config.feishu.defaultChatId ?? null,
        feishuDefaultChatDiagnostic: null,
        feishuTaskContainerMode: config.feishu.taskContainerMode,
        databasePath: config.storage.databasePath,
        projectsCount: 0,
        sessionBindingsCount: repo.count("session_bindings"),
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
      };
    }
  };
  const tasks = {
    async handleMessage(): Promise<void> {},
    async processCardActionDeferred(): Promise<void> {}
  };
  const server = new BridgeHttpServer(config, tasks as any, diagnostics as any, new CardRenderer(), makeLogger(dir));
  try {
    await server.start();
    const response = await fetch(`${server.localUrl()}/feishu/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "url_verification", challenge: "blocked" })
    });
    assert.equal(response.status, 409);
  } finally {
    await server.stop();
    cleanup();
  }
});

test("http server skips startup in auto mode when both transports use long connection", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  const config = makeConfig(dir);
  config.server.mode = "auto";
  config.server.port = 0;
  config.feishu.messageTransport = "long_connection";
  config.feishu.cardActionTransport = "long_connection";
  const diagnostics = {
    recordError(): void {},
    recordFeishuMessage(): void {},
    recordFeishuCardAction(): void {},
    async snapshot() {
      return {
        uptimeSeconds: 1,
        machineName: "test-machine",
        platform: "win32",
        nodeVersion: process.version,
        codexCommand: "codex",
        codexConnectionMode: config.codex.connectionMode,
        codexConnectionKind: "desktop_ipc" as const,
        codexDesktopIpc: null,
        codexDesktopProxy: null,
        codexRemoteControl: null,
        codexAvailable: true,
        appServerStatus: "connected" as const,
        feishuConfigured: true,
        feishuMessageTransport: config.feishu.messageTransport,
        feishuCardActionTransport: config.feishu.cardActionTransport,
        feishuInteractionMode: config.feishu.interactionMode,
        feishuDefaultChatId: config.feishu.defaultChatId ?? null,
        feishuDefaultChatDiagnostic: null,
        feishuTaskContainerMode: config.feishu.taskContainerMode,
        databasePath: config.storage.databasePath,
        projectsCount: 0,
        sessionBindingsCount: repo.count("session_bindings"),
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
      };
    }
  };
  const tasks = {
    async handleMessage(): Promise<void> {},
    async processCardActionDeferred(): Promise<void> {}
  };
  const server = new BridgeHttpServer(config, tasks as any, diagnostics as any, new CardRenderer(), makeLogger(dir));
  try {
    assert.equal(server.shouldStart(), false);
    await server.start();
    assert.throws(() => server.localUrl(), /not started/);
  } finally {
    await server.stop();
    cleanup();
  }
});

test("http callback card parser accepts v2 card action context nested under event", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  const config = makeConfig(dir);
  config.server.port = 0;
  config.feishu.messageTransport = "long_connection";
  config.feishu.cardActionTransport = "http_callback";
  const actions: any[] = [];
  const diagnostics = {
    recordError(): void {},
    recordFeishuMessage(): void {},
    recordFeishuCardAction(): void {},
    async snapshot() {
      return {
        uptimeSeconds: 1,
        machineName: "test-machine",
        platform: "win32",
        nodeVersion: process.version,
        codexCommand: "codex",
        codexConnectionMode: config.codex.connectionMode,
        codexConnectionKind: "desktop_ipc" as const,
        codexDesktopIpc: null,
        codexDesktopProxy: null,
        codexRemoteControl: null,
        codexAvailable: true,
        appServerStatus: "connected" as const,
        feishuConfigured: true,
        feishuMessageTransport: config.feishu.messageTransport,
        feishuCardActionTransport: config.feishu.cardActionTransport,
        feishuInteractionMode: config.feishu.interactionMode,
        feishuDefaultChatId: config.feishu.defaultChatId ?? null,
        feishuDefaultChatDiagnostic: null,
        feishuTaskContainerMode: config.feishu.taskContainerMode,
        databasePath: config.storage.databasePath,
        projectsCount: 0,
        sessionBindingsCount: repo.count("session_bindings"),
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
      };
    }
  };
  const tasks = {
    async handleMessage(): Promise<void> {},
    async processCardActionDeferred(action: any): Promise<void> {
      actions.push(action);
    }
  };
  const server = new BridgeHttpServer(config, tasks as any, diagnostics as any, new CardRenderer(), makeLogger(dir));
  try {
    await server.start();
    const response = await postJson(`${server.localUrl()}/feishu/card`, {
      schema: "2.0",
      header: { event_type: "card.action.trigger" },
      event: {
        context: { open_message_id: "om_root", open_chat_id: "oc_1" },
        operator: { open_id: "ou_1" },
        action: { tag: "button", value: { action: "doctor", actionId: "act_v2" } },
        form_value: { token: "from-http-callback" }
      }
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(response.toast.type, "success");
    assert.equal(response.toast.content, "已收到，正在处理");
    assert.equal(actions[0].action, "doctor");
    assert.equal(actions[0].chatId, "oc_1");
    assert.equal(actions[0].rootMessageId, "om_root");
    assert.deepEqual(actions[0].formValue, { token: "from-http-callback" });
  } finally {
    await server.stop();
    cleanup();
  }
});

test("http callback message parser accepts image-only Feishu messages", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  const config = makeConfig(dir);
  config.server.port = 0;
  config.feishu.messageTransport = "http_callback";
  config.feishu.cardActionTransport = "long_connection";
  config.feishu.verificationToken = "verify-token";
  const messages: any[] = [];
  const diagnostics = {
    recordError(): void {},
    recordFeishuMessage(): void {},
    recordFeishuCardAction(): void {},
    async snapshot() {
      return {
        uptimeSeconds: 1,
        machineName: "test-machine",
        platform: "win32",
        nodeVersion: process.version,
        codexCommand: "codex",
        codexConnectionMode: config.codex.connectionMode,
        codexConnectionKind: "desktop_ipc" as const,
        codexDesktopIpc: null,
        codexDesktopProxy: null,
        codexRemoteControl: null,
        codexAvailable: true,
        appServerStatus: "connected" as const,
        feishuConfigured: true,
        feishuMessageTransport: config.feishu.messageTransport,
        feishuCardActionTransport: config.feishu.cardActionTransport,
        feishuInteractionMode: config.feishu.interactionMode,
        feishuDefaultChatId: config.feishu.defaultChatId ?? null,
        feishuDefaultChatDiagnostic: null,
        feishuTaskContainerMode: config.feishu.taskContainerMode,
        databasePath: config.storage.databasePath,
        projectsCount: 0,
        sessionBindingsCount: repo.count("session_bindings"),
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
      };
    }
  };
  const tasks = {
    async handleMessage(message: any): Promise<void> {
      messages.push(message);
    },
    async processCardActionDeferred(): Promise<void> {}
  };
  const server = new BridgeHttpServer(config, tasks as any, diagnostics as any, new CardRenderer(), makeLogger(dir));
  try {
    await server.start();
    const response = await postJson(`${server.localUrl()}/feishu/events`, {
      schema: "2.0",
      token: "verify-token",
      header: { event_type: "im.message.receive_v1" },
      event: {
        sender: { sender_id: { open_id: "user_1" } },
        message: {
          message_id: "om_img_http",
          chat_id: "chat_1",
          root_id: "om_img_http",
          message_type: "image",
          content: "{\"image_key\":\"img_v3_http\"}"
        }
      }
    });

    assert.equal(response.ok, true);
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].attachments, [{ kind: "image", key: "img_v3_http", messageId: "om_img_http" }]);
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
