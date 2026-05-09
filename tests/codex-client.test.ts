import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createConnection, createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { CodexClient } from "../src/codex/client.js";
import { makeConfig, makeLogger, makeTempRepo } from "./helpers.js";

test("listThreads scans paginated app-server results with a bounded max page count", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const client = new CodexClient(makeConfig(dir), makeLogger(dir));
    const calls: Array<Record<string, unknown>> = [];
    const pages = [
      { data: [{ id: "thr_1", status: { type: "idle" } }], nextCursor: "next_1" },
      { data: [{ id: "thr_2", status: { type: "active" } }], nextCursor: "next_2" },
      { data: [{ id: "thr_3", status: { type: "idle" } }], nextCursor: null }
    ];
    (client as unknown as { request: (method: string, params: unknown) => Promise<unknown> }).request = async (
      method,
      params
    ) => {
      assert.equal(method, "thread/list");
      calls.push(params as Record<string, unknown>);
      return pages[calls.length - 1];
    };

    const threads = await client.listThreads(3, { pageSize: 1, maxPages: 3 });

    assert.deepEqual(
      calls.map((call) => call.cursor ?? null),
      [null, "next_1", "next_2"]
    );
    assert.equal(calls.every((call) => call.sortKey === "updated_at"), true);
    assert.deepEqual(
      threads.map((thread) => [thread.id, thread.status]),
      [
        ["thr_1", "idle"],
        ["thr_2", "running"],
        ["thr_3", "idle"]
      ]
    );
  } finally {
    cleanup();
  }
});

test("startThread and startTurn pass personal default model, reasoning and full access", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const client = new CodexClient(makeConfig(dir), makeLogger(dir));
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    (client as unknown as { request: (method: string, params: unknown) => Promise<unknown> }).request = async (
      method,
      params
    ) => {
      calls.push({ method, params: params as Record<string, unknown> });
      if (method === "thread/start") {
        return { thread: { id: "thr_new", status: { type: "idle" } } };
      }
      return { turn: { id: "turn_1" } };
    };

    await client.startThread({ cwd: dir });
    await client.startTurn("thr_new", "do it", { cwd: dir });

    const threadStart = calls.find((call) => call.method === "thread/start")?.params;
    const turnStart = calls.find((call) => call.method === "turn/start")?.params;
    assert.equal(threadStart?.model, "gpt-5.5");
    assert.equal(threadStart?.approvalPolicy, "never");
    assert.equal(threadStart?.sandbox, "danger-full-access");
    assert.deepEqual(threadStart?.config, { model_reasoning_effort: "xhigh" });
    assert.equal(turnStart?.model, "gpt-5.5");
    assert.equal(turnStart?.effort, "xhigh");
    assert.equal(turnStart?.approvalPolicy, "never");
    assert.deepEqual(turnStart?.sandboxPolicy, { type: "dangerFullAccess" });
  } finally {
    cleanup();
  }
});

test("setThreadName and listLoadedThreads call app-server helper APIs", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const client = new CodexClient(makeConfig(dir), makeLogger(dir));
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    (client as unknown as { request: (method: string, params: unknown) => Promise<unknown> }).request = async (
      method,
      params
    ) => {
      calls.push({ method, params: params as Record<string, unknown> });
      if (method === "thread/loaded/list") return { data: ["thr_1", "thr_2"], nextCursor: null };
      return {};
    };

    await client.setThreadName("thr_1", "New title");
    const loaded = await client.listLoadedThreads();

    assert.deepEqual(loaded, ["thr_1", "thr_2"]);
    assert.deepEqual(calls[0], { method: "thread/name/set", params: { threadId: "thr_1", name: "New title" } });
    assert.equal(calls[1]?.method, "thread/loaded/list");
  } finally {
    cleanup();
  }
});

test("unhandled Codex client errors are logged instead of crashing", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const logger = makeLogger(dir);
    const client = new CodexClient(makeConfig(dir), logger);
    assert.doesNotThrow(() => {
      (client as unknown as { rejectAll: (error: Error) => void }).rejectAll(new Error("proxy failed"));
    });
  } finally {
    cleanup();
  }
});

test("canonical websocket mode starts app-server with --listen and speaks JSON-RPC over WebSocket", async () => {
  const { dir, cleanup } = makeTempRepo();
  const server = await startMockCodexWebSocketServer();
  let client: CodexClient | null = null;
  try {
    const config = makeConfig(dir);
    config.codex.connectionMode = "canonical_websocket";
    config.codex.command = process.execPath;
    config.codex.args = ["-e", "setInterval(() => {}, 1000)"];
    config.codex.websocketListenUrl = server.wsUrl;
    config.codex.websocketUrl = server.wsUrl;
    config.codex.websocketAttachExisting = false;
    client = new CodexClient(config, makeLogger(dir));

    const threads = await client.listThreads(2);

    assert.equal(client.connectionKind, "canonical_websocket");
    assert.equal(client.webSocketUrl, server.wsUrl);
    assert.deepEqual(
      server.methods.slice(0, 3),
      ["initialize", "initialized", "thread/list"]
    );
    assert.equal(threads[0]?.id, "thr_ws");
  } finally {
    await client?.stop();
    await server.stop();
    cleanup();
  }
});

test("canonical websocket mode attaches to an existing app-server when it is already ready", async () => {
  const { dir, cleanup } = makeTempRepo();
  const server = await startMockCodexWebSocketServer();
  let client: CodexClient | null = null;
  try {
    const config = makeConfig(dir);
    config.codex.connectionMode = "canonical_websocket";
    config.codex.command = process.execPath;
    config.codex.args = ["-e", "process.exit(55)"];
    config.codex.websocketListenUrl = server.wsUrl;
    config.codex.websocketUrl = server.wsUrl;
    config.codex.websocketAttachExisting = true;
    client = new CodexClient(config, makeLogger(dir));

    await client.request("thread/list", {});

    assert.equal(client.connectionKind, "canonical_websocket");
    assert.equal((client as unknown as { proc: unknown | null }).proc, null);
    assert.deepEqual(server.methods.slice(0, 3), ["initialize", "initialized", "thread/list"]);
  } finally {
    await client?.stop();
    await server.stop();
    cleanup();
  }
});

test("canonical websocket mode can expose the Desktop SOCKS proxy for the configured target", async () => {
  const { dir, cleanup } = makeTempRepo();
  const server = await startMockCodexWebSocketServer();
  const socksPort = await freeTcpPort();
  let client: CodexClient | null = null;
  try {
    const config = makeConfig(dir);
    config.codex.connectionMode = "canonical_websocket";
    config.codex.command = process.execPath;
    config.codex.args = ["-e", "setInterval(() => {}, 1000)"];
    config.codex.websocketListenUrl = server.wsUrl;
    config.codex.websocketUrl = server.wsUrl;
    config.codex.websocketAttachExisting = false;
    config.codex.desktopSocksProxyEnabled = true;
    config.codex.desktopSocksProxyPort = socksPort;
    client = new CodexClient(config, makeLogger(dir));

    await client.request("thread/list", {});
    const snapshot = client.desktopSocksProxySnapshot;
    const response = await webSocketJsonRpcThroughSocks(socksPort, "localhost", server.port, {
      id: 99,
      method: "thread/list",
      params: {}
    });

    assert.equal(snapshot?.status, "listening");
    assert.equal(snapshot?.port, socksPort);
    assert.equal(snapshot?.allowedPort, server.port);
    assert.equal(response.id, 99);
    assert.deepEqual(response.result, {
      data: [{ id: "thr_ws", name: "WS thread", status: { type: "idle" } }],
      nextCursor: null
    });
  } finally {
    await client?.stop();
    await server.stop();
    cleanup();
  }
});

test("canonical websocket mode cleans stale process before reconnecting", async () => {
  const { dir, cleanup } = makeTempRepo();
  const server = await startMockCodexWebSocketServer();
  let client: CodexClient | null = null;
  try {
    const config = makeConfig(dir);
    config.codex.connectionMode = "canonical_websocket";
    config.codex.command = process.execPath;
    config.codex.args = ["-e", "setInterval(() => {}, 1000)"];
    config.codex.websocketListenUrl = server.wsUrl;
    config.codex.websocketUrl = server.wsUrl;
    config.codex.websocketAttachExisting = false;
    client = new CodexClient(config, makeLogger(dir));

    await client.request("thread/list", {});
    const firstProc = (client as unknown as { proc: { pid?: number } | null }).proc;
    assert.ok(firstProc?.pid);
    (client as unknown as { initialized: boolean }).initialized = false;

    await client.request("thread/list", {});

    await assertProcessExited(firstProc.pid);
    const secondProc = (client as unknown as { proc: { pid?: number } | null }).proc;
    assert.ok(secondProc?.pid);
    assert.notEqual(secondProc.pid, firstProc.pid);
  } finally {
    await client?.stop();
    await server.stop();
    cleanup();
  }
});

const startMockCodexWebSocketServer = async (): Promise<{
  wsUrl: string;
  port: number;
  methods: string[];
  stop: () => Promise<void>;
}> => {
  const methods: string[] = [];
  const sockets = new Set<Duplex>();
  const server = createServer((req, res) => {
    if (req.url === "/readyz" || req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    const accept = webSocketAccept(key);
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        ""
      ].join("\r\n")
    );
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (true) {
        const frame = readWebSocketFrame(buffered);
        if (!frame) break;
        buffered = buffered.subarray(frame.consumed);
        if (frame.opcode === 0x08) {
          socket.end();
          return;
        }
        const message = JSON.parse(frame.text) as Record<string, unknown>;
        if (typeof message.method === "string") methods.push(message.method);
        if ("id" in message) {
          writeWebSocketJson(socket, responseFor(message));
        }
      }
    });
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock server address is unavailable");
  const port = address.port;
  return {
    wsUrl: `ws://127.0.0.1:${port}`,
    port,
    methods,
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    }
  };
};

const responseFor = (message: Record<string, unknown>): Record<string, unknown> => {
  if (message.method === "initialize") {
    return { id: message.id, result: { protocolVersion: "test" } };
  }
  if (message.method === "thread/list") {
    return {
      id: message.id,
      result: { data: [{ id: "thr_ws", name: "WS thread", status: { type: "idle" } }], nextCursor: null }
    };
  }
  return { id: message.id, result: {} };
};

const listen = (server: ReturnType<typeof createServer>): Promise<void> =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const closeServer = (server: ReturnType<typeof createServer>): Promise<void> =>
  new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

const freeTcpPort = async (): Promise<number> => {
  const server: TcpServer = createTcpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("free port server address is unavailable");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
};

const assertProcessExited = async (pid: number): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`process ${pid} did not exit`);
};

const webSocketJsonRpcThroughSocks = async (
  socksPort: number,
  targetHost: string,
  targetPort: number,
  message: Record<string, unknown>
): Promise<Record<string, unknown>> => {
  const socket = await connectSocksTunnel(socksPort, targetHost, targetPort);
  try {
    const key = Buffer.from("codex-feishu-test").toString("base64");
    socket.write(
      [
        "GET / HTTP/1.1",
        `Host: ${targetHost}:${targetPort}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "",
        ""
      ].join("\r\n")
    );
    const handshake = await readSocketUntil(socket, (buffer) => buffer.includes("\r\n\r\n"));
    assert.match(handshake.toString("utf8"), /^HTTP\/1\.1 101 Switching Protocols/);

    writeMaskedWebSocketJson(socket, message);
    const response = await readSocketUntil(socket, (buffer) => readWebSocketFrame(buffer) !== null);
    const frame = readWebSocketFrame(response);
    assert.ok(frame);
    return JSON.parse(frame.text) as Record<string, unknown>;
  } finally {
    socket.destroy();
  }
};

const connectSocksTunnel = async (socksPort: number, targetHost: string, targetPort: number): Promise<Socket> => {
  const socket = createConnection({ host: "127.0.0.1", port: socksPort });
  await waitForSocketConnect(socket);
  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  const greeting = await readSocketUntil(socket, (buffer) => buffer.length >= 2);
  assert.deepEqual(Array.from(greeting.subarray(0, 2)), [0x05, 0x00]);

  const host = Buffer.from(targetHost, "utf8");
  socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, portBuffer(targetPort)]));
  const reply = await readSocketUntil(socket, (buffer) => buffer.length >= 10);
  assert.equal(reply[0], 0x05);
  assert.equal(reply[1], 0x00);
  return socket;
};

const waitForSocketConnect = (socket: Socket): Promise<void> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error("socket connect timed out"));
    }, 5000);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });

const readSocketUntil = (socket: Socket, predicate: (buffer: Buffer) => boolean): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("socket read timed out"));
    }, 5000);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!predicate(buffer)) return;
      cleanup();
      resolve(buffer);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socket closed before expected data arrived"));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });

const portBuffer = (port: number): Buffer => Buffer.from([port >> 8, port & 0xff]);

const webSocketAccept = (key: string): string =>
  createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

const writeWebSocketJson = (socket: NodeJS.WritableStream, value: Record<string, unknown>): void => {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  socket.write(Buffer.concat([header, payload]));
};

const writeMaskedWebSocketJson = (socket: NodeJS.WritableStream, value: Record<string, unknown>): void => {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const header =
    payload.length < 126
      ? Buffer.from([0x81, 0x80 | payload.length])
      : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index++) {
    masked[index] = masked[index]! ^ mask[index % 4]!;
  }
  socket.write(Buffer.concat([header, mask, masked]));
};

const readWebSocketFrame = (buffer: Buffer): { opcode: number; text: string; consumed: number } | null => {
  if (buffer.length < 2) return null;
  const opcode = buffer[0]! & 0x0f;
  const masked = (buffer[1]! & 0x80) !== 0;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  }
  if (length === 127) throw new Error("large websocket frames are not supported in test");
  const maskOffset = offset;
  const payloadOffset = masked ? offset + 4 : offset;
  const consumed = payloadOffset + length;
  if (buffer.length < consumed) return null;
  const payload = Buffer.from(buffer.subarray(payloadOffset, payloadOffset + length));
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4);
    for (let index = 0; index < payload.length; index++) {
      payload[index] = payload[index]! ^ mask[index % 4]!;
    }
  }
  return { opcode, text: payload.toString("utf8"), consumed };
};
