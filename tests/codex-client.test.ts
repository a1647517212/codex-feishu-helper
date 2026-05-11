import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import { join } from "node:path";
import { CodexClient } from "../src/codex/client.js";
import { DesktopIpcClient } from "../src/codex/desktop-ipc.js";
import { makeConfig, makeLogger, makeTempRepo } from "./helpers.js";

test("desktop ipc mode lists observed Desktop threads", async () => {
  const { dir, cleanup } = makeTempRepo();
  const ipc = await startMockDesktopIpcServer(dir);
  let client: CodexClient | null = null;
  try {
    const config = makeConfig(dir);
    config.codex.desktopIpcPipePath = ipc.pipePath;
    config.codex.desktopIpcInitialSnapshotWaitMs = 50;
    client = new CodexClient(config, makeLogger(dir));

    const threads = await client.listThreads(10);

    assert.deepEqual(
      threads.map((thread) => [thread.id, thread.status]),
      [["thr_desktop", "completed"]]
    );
  } finally {
    await client?.stop();
    await ipc.stop();
    cleanup();
  }
});

test("desktop ipc mode startThread and startTurn pass personal defaults to ordinary Desktop", async () => {
  const { dir, cleanup } = makeTempRepo();
  const ipc = await startMockDesktopIpcServer(dir);
  let client: CodexClient | null = null;
  try {
    const config = makeConfig(dir);
    config.codex.desktopIpcPipePath = ipc.pipePath;
    config.codex.desktopIpcInitialSnapshotWaitMs = 50;
    client = new CodexClient(config, makeLogger(dir));

    await client.startThread({ cwd: dir, prompt: "创建普通 Desktop 任务" });
    await client.startTurn("thr_desktop", "do it", { cwd: dir });

    const startConversation = ipc.requests.find((call) => call.method === "start-conversation");
    const followerStart = ipc.requests.find((call) => call.method === "thread-follower-start-turn");
    assert.ok(startConversation);
    assert.ok(followerStart);
    const startConversationParams = startConversation?.params as Record<string, unknown>;
    const turnStartParams = ((followerStart?.params as Record<string, unknown>).turnStartParams ?? {}) as Record<string, unknown>;
    assert.equal(startConversationParams.model, "gpt-5.5");
    assert.equal(startConversationParams.reasoningEffort, "xhigh");
    assert.equal(turnStartParams.model, "gpt-5.5");
    assert.equal(turnStartParams.effort, "xhigh");
    assert.equal(turnStartParams.approvalPolicy, "never");
    assert.deepEqual(turnStartParams.sandboxPolicy, { type: "dangerFullAccess" });
  } finally {
    await client?.stop();
    await ipc.stop();
    cleanup();
  }
});

test("desktop ipc mode setThreadName and listLoadedThreads operate on observed ordinary Desktop threads", async () => {
  const { dir, cleanup } = makeTempRepo();
  const ipc = await startMockDesktopIpcServer(dir);
  let client: CodexClient | null = null;
  try {
    const config = makeConfig(dir);
    config.codex.desktopIpcPipePath = ipc.pipePath;
    config.codex.desktopIpcInitialSnapshotWaitMs = 50;
    client = new CodexClient(config, makeLogger(dir));

    await client.setThreadName("thr_desktop", "New title");
    const loaded = await client.listLoadedThreads();

    assert.deepEqual(loaded, ["thr_desktop"]);
    const rename = ipc.requests.find((call) => call.method === "set-thread-title");
    assert.deepEqual(rename?.params, { conversationId: "thr_desktop", title: "New title" });
  } finally {
    await client?.stop();
    await ipc.stop();
    cleanup();
  }
});

test("codex client error listener can be absent without crashing", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const logger = makeLogger(dir);
    const client = new CodexClient(makeConfig(dir), logger);
    assert.doesNotThrow(() => {
      (client as unknown as { handleClientError: (error: Error) => void }).handleClientError(new Error("proxy failed"));
    });
  } finally {
    cleanup();
  }
});

test("desktop ipc mode lists ordinary Desktop snapshots without starting a separate runtime", async () => {
  const { dir, cleanup } = makeTempRepo();
  const ipc = await startMockDesktopIpcServer(dir);
  let client: CodexClient | null = null;
  try {
    const config = makeConfig(dir);
    config.codex.desktopIpcPipePath = ipc.pipePath;
    config.codex.desktopIpcInitialSnapshotWaitMs = 50;
    client = new CodexClient(config, makeLogger(dir));

    const threads = await client.listThreads(10);

    assert.equal(client.connectionKind, "desktop_ipc");
    assert.equal(client.status, "connected");
    assert.equal(threads.length, 1);
    assert.equal(threads[0]?.id, "thr_desktop");
    assert.equal(threads[0]?.title, "Desktop task");
    assert.equal(threads[0]?.cwd, dir);
    assert.equal(threads[0]?.status, "completed");
    assert.equal(client.desktopIpcSnapshot?.observedThreads, 1);
  } finally {
    await client?.stop();
    await ipc.stop();
    cleanup();
  }
});

test("desktop ipc mode targets the Desktop owner client for follower start turn", async () => {
  const { dir, cleanup } = makeTempRepo();
  const ipc = await startMockDesktopIpcServer(dir);
  let client: CodexClient | null = null;
  try {
    const config = makeConfig(dir);
    config.codex.desktopIpcPipePath = ipc.pipePath;
    config.codex.desktopIpcInitialSnapshotWaitMs = 50;
    client = new CodexClient(config, makeLogger(dir));

    const result = await client.startTurn("thr_desktop", "继续处理", { cwd: dir });

    assert.deepEqual(result, { ok: true, request: "thread-follower-start-turn" });
    const forwarded = ipc.requests.find((entry) => entry.method === "thread-follower-start-turn");
    assert.ok(forwarded);
    assert.equal(forwarded.targetClientId, "desktop-owner");
    assert.equal(forwarded.version, 1);
    assert.equal((forwarded.params as Record<string, unknown>).conversationId, "thr_desktop");
    const turnStartParams = (forwarded.params as Record<string, unknown>).turnStartParams as Record<string, unknown>;
    assert.deepEqual(turnStartParams.input, [{ type: "text", text: "继续处理", text_elements: [] }]);
    assert.equal(turnStartParams.cwd, dir);
    assert.equal(turnStartParams.model, "gpt-5.5");
    assert.equal(turnStartParams.effort, "xhigh");
  } finally {
    await client?.stop();
    await ipc.stop();
    cleanup();
  }
});

test("desktop ipc mode creates ordinary Desktop threads through start-conversation and applies goal/title", async () => {
  const { dir, cleanup } = makeTempRepo();
  const ipc = await startMockDesktopIpcServer(dir);
  let client: DesktopIpcClient | null = null;
  try {
    client = new DesktopIpcClient(
      { pipePath: ipc.pipePath, initialSnapshotWaitMs: 50 },
      makeLogger(dir)
    );

    const thread = await client.startThread({
      prompt: "飞书创建普通 Desktop thread",
      cwd: dir,
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      approvalPolicy: "never",
      sandboxMode: "danger-full-access",
      serviceName: "feishu_codex_bridge_test"
    });

    assert.equal(thread.id, "thr_desktop_new");
    assert.equal(thread.cwd, dir);
    assert.equal(thread.title, "飞书创建普通 Desktop thread");
    const startConversation = ipc.requests.find((entry) => entry.method === "start-conversation");
    assert.ok(startConversation);
    assert.equal(startConversation?.targetClientId, undefined);
    const startConversationParams = startConversation?.params as Record<string, unknown>;
    assert.equal(startConversationParams.hostId, "local");
    assert.deepEqual(startConversationParams.input, [{ type: "text", text: "飞书创建普通 Desktop thread", text_elements: [] }]);
    assert.deepEqual(startConversationParams.workspaceRoots, [dir]);
    assert.equal(startConversationParams.cwd, dir);
    assert.equal(startConversationParams.model, "gpt-5.5");
    assert.equal(startConversationParams.reasoningEffort, "xhigh");
    assert.equal(startConversationParams.workspaceKind, "project");
    const collaborationMode = startConversationParams.collaborationMode as Record<string, unknown> | undefined;
    const configPayload = startConversationParams.config as Record<string, unknown> | undefined;
    assert.equal(collaborationMode?.mode, "default");
    assert.equal(configPayload?.serviceName, "feishu_codex_bridge_test");
    assert.equal(ipc.requests.some((entry) => entry.method === "set-thread-goal"), true);
    assert.equal(ipc.requests.some((entry) => entry.method === "set-thread-title"), true);
  } finally {
    await client?.stop();
    await ipc.stop();
    cleanup();
  }
});

test("desktop ipc mode passes local image inputs to ordinary Desktop", async () => {
  const { dir, cleanup } = makeTempRepo();
  const ipc = await startMockDesktopIpcServer(dir);
  let client: CodexClient | null = null;
  try {
    const config = makeConfig(dir);
    config.codex.desktopIpcPipePath = ipc.pipePath;
    config.codex.desktopIpcInitialSnapshotWaitMs = 50;
    client = new CodexClient(config, makeLogger(dir));

    await client.startThread({
      cwd: dir,
      prompt: "看图处理",
      attachments: [{ path: join(dir, "image.png") }]
    });
    await client.startTurn("thr_desktop", "继续看图", {
      cwd: dir,
      attachments: [{ path: join(dir, "next.png") }]
    });
    await client.steerTurn("thr_desktop", "追加图片", [{ path: join(dir, "steer.png") }]);

    const startConversation = ipc.requests.find((call) => call.method === "start-conversation");
    const followerStart = ipc.requests.find((call) => call.method === "thread-follower-start-turn");
    const followerSteer = ipc.requests.find((call) => call.method === "thread-follower-steer-turn");
    assert.deepEqual((startConversation?.params as any).input, [
      { type: "text", text: "看图处理", text_elements: [] },
      { type: "localImage", path: join(dir, "image.png") }
    ]);
    assert.deepEqual(((followerStart?.params as any).turnStartParams as any).input, [
      { type: "text", text: "继续看图", text_elements: [] },
      { type: "localImage", path: join(dir, "next.png") }
    ]);
    assert.deepEqual((followerSteer?.params as any).input, [
      { type: "text", text: "追加图片", text_elements: [] },
      { type: "localImage", path: join(dir, "steer.png") }
    ]);
  } finally {
    await client?.stop();
    await ipc.stop();
    cleanup();
  }
});

test("desktop ipc mode does not bind a new Desktop thread unless the prompt matches", async () => {
  const { dir, cleanup } = makeTempRepo();
  const ipc = await startMockDesktopIpcServer(dir, { startConversationPromptOverride: "别的 Desktop 任务" });
  let client: DesktopIpcClient | null = null;
  try {
    client = new DesktopIpcClient(
      { pipePath: ipc.pipePath, initialSnapshotWaitMs: 50, creationSnapshotWaitMs: 120 },
      makeLogger(dir)
    );

    await assert.rejects(
      () => client!.startThread({
        prompt: "飞书创建普通 Desktop thread",
        cwd: dir,
        model: "gpt-5.5",
        reasoningEffort: "xhigh",
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
        serviceName: "feishu_codex_bridge_test"
      }),
      /Timed out waiting for ordinary Codex Desktop/
    );

    assert.equal(ipc.requests.some((entry) => entry.method === "start-conversation"), true);
    assert.equal(ipc.requests.some((entry) => entry.method === "set-thread-goal"), false);
    assert.equal(ipc.requests.some((entry) => entry.method === "set-thread-title"), false);
  } finally {
    await client?.stop();
    await ipc.stop();
    cleanup();
  }
});

test("desktop ipc mode archives, restores and renames ordinary Desktop threads through shared runtime", async () => {
  const { dir, cleanup } = makeTempRepo();
  const ipc = await startMockDesktopIpcServer(dir);
  let client: DesktopIpcClient | null = null;
  try {
    client = new DesktopIpcClient(
      { pipePath: ipc.pipePath, initialSnapshotWaitMs: 50, serviceName: "feishu_codex_bridge_test" },
      makeLogger(dir)
    );
    await client.start();

    await client.setThreadName("thr_desktop", "Renamed from Feishu");
    assert.equal(client.listThreads(10).find((thread) => thread.id === "thr_desktop")?.title, "Renamed from Feishu");

    await client.archiveThread("thr_desktop");
    assert.equal(client.listThreads(10).some((thread) => thread.id === "thr_desktop"), false);

    await client.unarchiveThread("thr_desktop");
    assert.equal(client.listThreads(10).find((thread) => thread.id === "thr_desktop")?.title, "Renamed from Feishu");

    const relevantRequests = ipc.requests.filter((entry) => entry.method !== "initialize");
    assert.deepEqual(
      relevantRequests.map((entry) => [entry.method, entry.params]),
      [
        ["set-thread-title", { conversationId: "thr_desktop", title: "Renamed from Feishu" }],
        ["archive-conversation", { conversationId: "thr_desktop", cleanupWorktree: false }],
        ["unarchive-conversation", { conversationId: "thr_desktop" }]
      ]
    );
  } finally {
    await client?.stop();
    await ipc.stop();
    cleanup();
  }
});

test("desktop ipc mode supports compact, collaboration and edit-style thread follower requests", async () => {
  const { dir, cleanup } = makeTempRepo();
  const ipc = await startMockDesktopIpcServer(dir);
  let client: DesktopIpcClient | null = null;
  try {
    client = new DesktopIpcClient({ pipePath: ipc.pipePath, initialSnapshotWaitMs: 50 }, makeLogger(dir));
    await client.start();

    await client.compactThread("thr_desktop");
    await client.setCollaborationMode("thr_desktop", { mode: "default", settings: { model: "gpt-5.5", reasoning_effort: null, developer_instructions: null } });
    await client.editLastUserTurn("thr_desktop", "turn_1", "修改后的上一条用户消息");
    await client.submitUserInput("thr_desktop", "req_input", { answers: { q1: { answers: ["yes"] } } });

    assert.deepEqual(
      ipc.requests.filter((entry) => entry.method?.startsWith("thread-follower-")).map((entry) => entry.method),
      [
        "thread-follower-compact-thread",
        "thread-follower-set-collaboration-mode",
        "thread-follower-edit-last-user-turn",
        "thread-follower-submit-user-input"
      ]
    );
  } finally {
    await client?.stop();
    await ipc.stop();
    cleanup();
  }
});

test("desktop ipc mode maps Desktop server requests to bridge request ids and responds over IPC", async () => {
  const { dir, cleanup } = makeTempRepo();
  const ipc = await startMockDesktopIpcServer(dir);
  let client: DesktopIpcClient | null = null;
  try {
    client = new DesktopIpcClient({ pipePath: ipc.pipePath, initialSnapshotWaitMs: 50 }, makeLogger(dir));
    const serverRequests: Record<string, unknown>[] = [];
    client.on("serverRequest", (message) => serverRequests.push(message));
    await client.start();

    ipc.sendRequest("desktop-request-1", "item/commandExecution/requestApproval", {
      threadId: "thr_desktop",
      turnId: "turn_1",
      itemId: "item_approval",
      command: "npm test"
    });
    await waitForCondition(() => serverRequests.length === 1, "Desktop server request was not delivered");

    assert.equal(serverRequests[0]?.id, "desktop-request-1");
    assert.equal(serverRequests[0]?.requestId, "desktop-request-1");
    assert.equal(serverRequests[0]?.method, "item/commandExecution/requestApproval");

    await client.respondToServerRequest("desktop-request-1", { decision: "approve" });
    await waitForCondition(() => ipc.responses.length === 1, "Desktop IPC response was not observed");

    assert.deepEqual(ipc.responses[0], {
      requestId: "desktop-request-1",
      targetClientId: "desktop-owner",
      resultType: "success",
      result: { decision: "approve" }
    });
  } finally {
    await client?.stop();
    await ipc.stop();
    cleanup();
  }
});

test("desktop ipc mode converts Desktop stream snapshots into bridge turn notifications", async () => {
  const { dir, cleanup } = makeTempRepo();
  const ipc = await startMockDesktopIpcServer(dir);
  let client: CodexClient | null = null;
  try {
    const config = makeConfig(dir);
    config.codex.desktopIpcPipePath = ipc.pipePath;
    config.codex.desktopIpcInitialSnapshotWaitMs = 50;
    client = new CodexClient(config, makeLogger(dir));
    const notifications: Record<string, unknown>[] = [];
    client.on("notification", (message) => notifications.push(message));

    await client.start();

    assert.ok(notifications.some((message) => message.method === "thread-stream-state-changed"));
    const completed = notifications.find((message) => message.method === "turn/completed");
    assert.ok(completed);
    assert.deepEqual(completed.params, {
      threadId: "thr_desktop",
      turn: {
        params: {
          threadId: "thr_desktop",
          cwd: dir,
          input: [{ type: "text", text: "继续处理", text_elements: [] }]
        },
        turnId: "turn_1",
        id: "turn_1",
        status: "completed",
        items: [{ type: "agentMessage", id: "item_1", text: "完成了" }]
      }
    });
  } finally {
    await client?.stop();
    await ipc.stop();
    cleanup();
  }
});

test("desktop ipc mode does not duplicate synthetic turn notification for the same snapshot", async () => {
  const { dir, cleanup } = makeTempRepo();
  const ipc = await startMockDesktopIpcServer(dir);
  let client: CodexClient | null = null;
  try {
    const config = makeConfig(dir);
    config.codex.desktopIpcPipePath = ipc.pipePath;
    config.codex.desktopIpcInitialSnapshotWaitMs = 50;
    client = new CodexClient(config, makeLogger(dir));
    const notifications: Record<string, unknown>[] = [];
    client.on("notification", (message) => notifications.push(message));

    await client.start();
    ipc.broadcastSnapshot(dir);

    await waitForCondition(
      () => notifications.filter((message) => message.method === "thread-stream-state-changed").length === 2,
      "desktop ipc duplicate snapshot was not observed"
    );
    assert.equal(notifications.filter((message) => message.method === "turn/completed").length, 1);
    assert.equal(notifications.filter((message) => message.method === "thread-stream-state-changed").length, 2);
  } finally {
    await client?.stop();
    await ipc.stop();
    cleanup();
  }
});

const startMockDesktopIpcServer = async (cwd: string, options: {
  startConversationPromptOverride?: string;
} = {}): Promise<{
  pipePath: string;
  requests: Array<{ method: string; targetClientId?: string; version?: number; params?: unknown }>;
  responses: Array<{ requestId?: string; targetClientId?: string; resultType?: string; result?: unknown }>;
  broadcastSnapshot: (cwd: string, options?: Partial<DesktopSnapshotOptions>) => void;
  sendRequest: (requestId: string, method: string, params?: Record<string, unknown>) => void;
  stop: () => Promise<void>;
}> => {
  const pipePath = process.platform === "win32"
    ? `\\\\.\\pipe\\codex-feishu-test-${process.pid}-${Date.now()}`
    : join(process.env.TMPDIR ?? "/tmp", `codex-feishu-test-${process.pid}-${Date.now()}.sock`);
  const requests: Array<{ method: string; targetClientId?: string; version?: number; params?: unknown }> = [];
  const responses: Array<{ requestId?: string; targetClientId?: string; resultType?: string; result?: unknown }> = [];
  const sockets = new Set<Socket>();
  const broadcastSnapshot = (snapshotCwd: string, options: Partial<DesktopSnapshotOptions> = {}): void => {
    for (const socket of sockets) {
      writeDesktopIpcFrame(socket, desktopSnapshotMessage(snapshotCwd, options));
    }
  };
  const sendRequest = (requestId: string, method: string, params: Record<string, unknown> = {}): void => {
    for (const socket of sockets) {
      writeDesktopIpcFrame(socket, {
        type: "request",
        requestId,
        sourceClientId: "desktop-owner",
        method,
        params
      });
    }
  };
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const frame = readDesktopIpcFrame(buffer);
        if (!frame) break;
        buffer = buffer.subarray(frame.consumed);
        const message = frame.message;
        if (message.type === "request" && message.method === "initialize") {
          writeDesktopIpcFrame(socket, {
            type: "response",
            method: "initialize",
            requestId: message.requestId,
            resultType: "success",
            result: { clientId: "bridge-client" }
          });
          writeDesktopIpcFrame(socket, desktopSnapshotMessage(cwd));
          continue;
        }
        if (message.type === "request") {
          requests.push({
            method: String(message.method),
            targetClientId: typeof message.targetClientId === "string" ? message.targetClientId : undefined,
            version: typeof message.version === "number" ? message.version : undefined,
            params: message.params
          });
          if (message.method === "thread-follower-start-turn") {
            const params = message.params as Record<string, unknown>;
            const turnStartParams = params.turnStartParams as Record<string, unknown> | undefined;
            const input = Array.isArray(turnStartParams?.input) ? turnStartParams.input : [];
            const textInput = input[0] && typeof input[0] === "object" ? input[0] as Record<string, unknown> : {};
            broadcastSnapshot(String(turnStartParams?.cwd ?? cwd), {
              conversationId: String(params.conversationId ?? "thr_desktop_new"),
              title: "Feishu-created Desktop task",
              prompt: typeof textInput.text === "string" ? textInput.text : "",
              turnId: "turn_new",
              status: "running"
            });
          }
          if (message.method === "start-conversation") {
            const params = message.params as Record<string, unknown>;
            const input = Array.isArray(params.input) ? params.input : [];
            const textInput = input[0] && typeof input[0] === "object" ? input[0] as Record<string, unknown> : {};
            broadcastSnapshot(String(params.cwd ?? cwd), {
              conversationId: "thr_desktop_new",
              title: "Feishu-created Desktop thread",
              prompt: options.startConversationPromptOverride ?? (typeof textInput.text === "string" ? textInput.text : ""),
              turnId: "turn_new",
              status: "running"
            });
          }
          if (message.method === "set-thread-title") {
            const params = message.params as Record<string, unknown>;
            const threadId = String(params.conversationId ?? "thr_desktop_new");
            const title = typeof params.title === "string" ? params.title : "Desktop task";
            broadcastSnapshot(cwd, {
              conversationId: threadId,
              title,
              prompt: "飞书创建普通 Desktop thread",
              turnId: "turn_new",
              status: "running"
            });
          }
          if (message.method === "set-thread-goal" || message.method === "clear-thread-goal") {
            // No-op for the mock; the client only needs the request to succeed.
          }
          if (message.method === "archive-conversation" || message.method === "unarchive-conversation") {
            // No-op for the mock; the client only needs the request to succeed.
          }
          if (message.method === "thread-follower-compact-thread" || message.method === "thread-follower-set-collaboration-mode" || message.method === "thread-follower-edit-last-user-turn" || message.method === "thread-follower-submit-user-input" || message.method === "thread-follower-submit-mcp-server-elicitation-response") {
            // No-op for the mock; the client only needs the request to succeed.
          }
          writeDesktopIpcFrame(socket, {
            type: "response",
            method: message.method,
            requestId: message.requestId,
            resultType: "success",
            result: { ok: true, request: message.method }
          });
          continue;
        }
        if (message.type === "response") {
          responses.push({
            requestId: typeof message.requestId === "string" ? message.requestId : undefined,
            targetClientId: typeof message.targetClientId === "string" ? message.targetClientId : undefined,
            resultType: typeof message.resultType === "string" ? message.resultType : undefined,
            result: message.result
          });
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(pipePath, resolve));
  return {
    pipePath,
    requests,
    responses,
    broadcastSnapshot,
    sendRequest,
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    }
  };
};

interface DesktopSnapshotOptions {
  conversationId: string;
  title: string;
  prompt: string;
  turnId: string | null;
  status: string;
}

const desktopSnapshotMessage = (cwd: string, options: Partial<DesktopSnapshotOptions> = {}): Record<string, unknown> => {
  const conversationId = options.conversationId ?? "thr_desktop";
  const turnId = options.turnId === null ? null : options.turnId ?? "turn_1";
  const status = options.status ?? "completed";
  const prompt = options.prompt ?? "继续处理";
  const turns = turnId
    ? [
        {
          params: { threadId: conversationId, cwd, input: prompt ? [{ type: "text", text: prompt, text_elements: [] }] : [] },
          turnId,
          status,
          items: [{ type: "agentMessage", id: "item_1", text: "完成了" }]
        }
      ]
    : [];
  return {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop-owner",
    version: 6,
    params: {
      conversationId,
      hostId: "local",
      change: {
        type: "snapshot",
        conversationState: {
          id: conversationId,
          title: options.title ?? "Desktop task",
          updatedAt: 1778451000000,
          source: "desktop",
          threadRuntimeStatus: { type: status === "running" ? "active" : "idle" },
          cwd,
          turns
        }
      },
      version: 6,
      type: "thread-stream-state-changed"
    }
  };
};

const closeServer = (server: TcpServer): Promise<void> =>
  new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

const waitForCondition = async (predicate: () => boolean, message: string, timeoutMs = 1000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
};

const writeDesktopIpcFrame = (socket: NodeJS.WritableStream, value: Record<string, unknown>): void => {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  socket.write(Buffer.concat([header, payload]));
};

const readDesktopIpcFrame = (buffer: Buffer): { message: Record<string, unknown>; consumed: number } | null => {
  if (buffer.length < 4) return null;
  const length = buffer.readUInt32LE(0);
  if (buffer.length < 4 + length) return null;
  const message = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")) as Record<string, unknown>;
  return { message, consumed: 4 + length };
};
