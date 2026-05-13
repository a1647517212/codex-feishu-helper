import { createInterface } from "node:readline";

const thread = {
  id: "thr_proxy",
  forkedFromId: null,
  preview: "Proxy thread",
  ephemeral: false,
  modelProvider: "openai",
  createdAt: Math.floor(Date.now() / 1000),
  updatedAt: Math.floor(Date.now() / 1000),
  status: { type: "idle" },
  path: null,
  cwd: process.cwd(),
  cliVersion: "test",
  source: "appServer",
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: "Proxy thread",
  goal: null,
  turns: []
};

const rl = createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

const write = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    write({
      id: message.id,
      result: {
        userAgent: "mock-codex-proxy",
        codexHome: process.cwd(),
        platformFamily: process.platform === "win32" ? "windows" : "unix",
        platformOs: process.platform === "win32" ? "windows" : process.platform
      }
    });
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.method === "getAuthStatus") {
    write({
      id: message.id,
      result: {
        authMethod: "chatgpt",
        authToken: null,
        requiresOpenaiAuth: true
      }
    });
    return;
  }
  if (message.method === "account/read") {
    write({
      id: message.id,
      result: {
        requiresOpenaiAuth: true,
        account: {
          type: "chatgpt",
          email: "proxy@example.com",
          planType: "plus"
        }
      }
    });
    return;
  }
  if (message.method === "thread/list") {
    write({
      id: message.id,
      result: {
        data: [thread],
        nextCursor: null,
        backwardsCursor: null
      }
    });
    return;
  }
  if (message.method === "thread/start") {
    thread.status = { type: "active" };
    thread.updatedAt = Math.floor(Date.now() / 1000);
    write({
      id: message.id,
      result: {
        thread,
        model: "gpt-5.5",
        modelProvider: "openai",
        serviceTier: null,
        cwd: thread.cwd,
        instructionSources: [],
        approvalPolicy: "never",
        approvalsReviewer: { type: "user" },
        sandbox: { type: "dangerFullAccess" },
        permissionProfile: null,
        reasoningEffort: "xhigh"
      }
    });
    return;
  }
  if (message.method === "thread/read") {
    write({
      id: message.id,
      result: {
        thread
      }
    });
    return;
  }
  if (message.method === "turn/start") {
    const input = Array.isArray(message.params?.input) ? message.params.input : [];
    const text = typeof input[0]?.text === "string" ? input[0].text : "";
    const turn = {
      id: `turn_${thread.turns.length + 1}`,
      status: "running",
      params: {
        threadId: thread.id,
        cwd: message.params?.cwd ?? thread.cwd,
        input
      },
      items: text ? [{ type: "agentMessage", id: `item_${thread.turns.length + 1}`, text }] : []
    };
    thread.turns.push(turn);
    thread.status = { type: "active" };
    thread.updatedAt = Math.floor(Date.now() / 1000);
    write({
      id: message.id,
      result: { turn }
    });
    return;
  }
  if (message.method === "thread/name/set") {
    thread.name = message.params?.name ?? thread.name;
    write({ id: message.id, result: {} });
    return;
  }
  if (message.method === "thread/goal/set") {
    thread.goal = message.params?.objective ?? thread.goal;
    write({
      id: message.id,
      result: {
        goal: {
          threadId: thread.id,
          objective: thread.goal,
          status: message.params?.status ?? "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: Math.floor(Date.now() / 1000),
          updatedAt: Math.floor(Date.now() / 1000)
        }
      }
    });
    return;
  }
  if (message.method === "thread/goal/clear") {
    thread.goal = null;
    write({ id: message.id, result: { cleared: true } });
    return;
  }
  if (message.method === "thread/archive" || message.method === "thread/unarchive" || message.method === "turn/interrupt" || message.method === "thread/compact/start") {
    write({ id: message.id, result: {} });
    return;
  }
  if (message.method === "thread/loaded/list") {
    write({
      id: message.id,
      result: {
        data: [thread.id],
        nextCursor: null
      }
    });
    return;
  }
  if (message.method === "model/list") {
    write({
      id: message.id,
      result: {
        data: [{
          id: "gpt-5.5",
          name: "gpt-5.5",
          displayName: "gpt-5.5",
          defaultReasoningEffort: "xhigh",
          supportedReasoningEfforts: ["xhigh"],
          isDefault: true
        }],
        nextCursor: null
      }
    });
    return;
  }
  write({ id: message.id, result: {} });
});
