import test from "node:test";
import assert from "node:assert/strict";
import { TaskService } from "../src/bridge/task-service.js";
import { makeConfig, makeLogger, makeTempRepo, MockCodex, MockFeishu } from "./helpers.js";

test("running topic replies are queued instead of dropped", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_1",
      feishuChatId: "chat_1",
      feishuTopicRootMessageId: "root_1",
      title: "Task",
      status: "running",
      createdFrom: "manual_import"
    });
    await service.handleMessage({
      messageId: "msg_2",
      chatId: "chat_1",
      rootMessageId: "root_1",
      threadId: null,
      userId: "user_1",
      text: "继续跑测试"
    });
    assert.equal(repo.listQueuedMessages(binding.id).length, 1);
    assert.equal(feishu.sent.some((entry) => entry.type === "text"), true);
  } finally {
    cleanup();
  }
});

test("approval action is idempotent and sends one codex response", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_1",
      feishuChatId: "chat_1",
      feishuTopicRootMessageId: "root_1",
      title: "Task",
      status: "waiting_for_approval",
      createdFrom: "manual_import"
    });
    const approval = repo.upsertPendingApproval({
      sessionBindingId: binding.id,
      codexThreadId: binding.codexThreadId,
      codexTurnId: "turn_1",
      requestId: "req_1",
      approvalType: "command_execution",
      command: "npm test",
      riskLevel: "low"
    });
    const action = {
      actionId: "act_approval",
      action: "approval_once",
      userId: "user_1",
      chatId: "chat_1",
      payload: { approvalId: approval.id }
    };
    await service.handleCardAction(action);
    await service.handleCardAction(action);
    assert.equal(codex.responses.length, 1);
    assert.equal(repo.findApprovalById(approval.id)?.status, "approved_once");
  } finally {
    cleanup();
  }
});

test("console new task action sends a draft topic card", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    await service.handleCardAction({
      actionId: "act_new_task",
      action: "new_task",
      userId: "user_1",
      chatId: "chat_1",
      rootMessageId: "root_console",
      payload: {}
    });
    assert.equal(feishu.sent.length, 1);
    assert.equal(feishu.sent[0]?.type, "card");
    assert.equal(feishu.sent[0]?.root, "root_console");
  } finally {
    cleanup();
  }
});

test("claim sessions card can bind an existing Codex thread", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    codex.threads = [
      {
        id: "thr_existing",
        name: "Existing task",
        preview: "Existing task",
        cwd: dir,
        status: { type: "idle" },
        updatedAt: Date.now()
      }
    ];
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    await service.handleCardAction({
      actionId: "act_claim",
      action: "claim_thread",
      userId: "user_1",
      chatId: "chat_1",
      rootMessageId: "root_existing",
      payload: { codexThreadId: "thr_existing" }
    });
    const binding = repo.findBindingByThreadId("thr_existing");
    assert.ok(binding);
    assert.equal(binding.feishuTopicRootMessageId, "root_existing");
    assert.equal(binding.createdFrom, "codex_app_claimed");
  } finally {
    cleanup();
  }
});
