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

test("three running topic replies stay queued and can be cancelled", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_queue",
      feishuChatId: "chat_1",
      feishuTopicRootMessageId: "root_queue",
      title: "Queue task",
      status: "running",
      createdFrom: "manual_import"
    });
    for (let index = 1; index <= 3; index++) {
      await service.handleMessage({
        messageId: `msg_queue_${index}`,
        chatId: "chat_1",
        rootMessageId: "root_queue",
        threadId: null,
        userId: "user_1",
        text: `追加要求 ${index}`
      });
    }
    const queued = repo.listQueuedMessages(binding.id);
    assert.equal(queued.length, 3);
    await service.handleCardAction({
      actionId: "act_queue_view",
      action: "queue_view",
      userId: "user_1",
      chatId: "chat_1",
      rootMessageId: "root_queue",
      payload: { bindingId: binding.id }
    });
    assert.equal(feishu.sent.some((entry) => entry.type === "card"), true);
    await service.handleCardAction({
      actionId: "act_queue_cancel",
      action: "queue_cancel",
      userId: "user_1",
      chatId: "chat_1",
      rootMessageId: "root_queue",
      payload: { bindingId: binding.id, queueId: queued[1]!.id }
    });
    assert.equal(repo.getQueuedMessage(queued[1]!.id)?.status, "cancelled");
    assert.equal(repo.listEventsForBinding(binding.id).some((event) => event.eventType === "queue.cancelled"), true);
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

test("malformed completed notification records protocol validation event", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const codex = new MockCodex();
    new TaskService(config, repo, codex as any, new MockFeishu(), makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_bad_event",
      feishuChatId: "chat_1",
      feishuTopicRootMessageId: "root_bad_event",
      title: "Bad event task",
      status: "running",
      createdFrom: "manual_import"
    });
    await codex.notifications.notification![0]!({
      method: "turn/completed",
      params: {
        threadId: binding.codexThreadId,
        turn: {
          status: "completed"
        }
      }
    });
    const events = repo.listEventsForBinding(binding.id);
    assert.equal(events.some((event) => event.eventType === "protocol.validation_failed"), true);
  } finally {
    cleanup();
  }
});

test("bootstrap reconciles persisted running binding to current thread status", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const codex = new MockCodex();
    codex.threads = [
      {
        id: "thr_reconcile",
        name: "Reconciled task",
        preview: "Reconciled task",
        cwd: dir,
        status: { type: "idle" },
        updatedAt: Date.now()
      }
    ];
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_reconcile",
      feishuChatId: "chat_1",
      feishuTopicRootMessageId: "root_reconcile",
      title: "Reconciled task",
      status: "running",
      createdFrom: "manual_import"
    });
    const service = new TaskService(config, repo, codex as any, new MockFeishu(), makeLogger(dir));
    await service.bootstrapProjectsFromConfig();
    assert.equal(repo.findBindingById(binding.id)?.status, "idle");
    assert.equal(repo.listEventsForBinding(binding.id).some((event) => event.eventType === "session.reconciled"), true);
  } finally {
    cleanup();
  }
});

test("visible task and diagnostic buttons have concrete handlers", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_buttons",
      feishuChatId: "chat_1",
      feishuTopicRootMessageId: "root_buttons",
      title: "Button task",
      cwd: dir,
      status: "completed",
      createdFrom: "manual_import"
    });
    repo.insertEvent({
      sessionBindingId: binding.id,
      codexThreadId: binding.codexThreadId,
      eventType: "task.completed",
      eventPayload: { text: "done" }
    });
    repo.enqueueOutbox({
      sessionBindingId: binding.id,
      notificationType: "task_completed",
      feishuChatId: "chat_1",
      feishuTopicRootMessageId: "root_buttons",
      payload: { text: "done" },
      dedupeKey: "button-history"
    });
    for (const [index, action] of ["task_status", "task_logs", "task_diff", "notification_history", "send_test_notification"].entries()) {
      await service.handleCardAction({
        actionId: `act_button_${index}`,
        action,
        userId: "user_1",
        chatId: "chat_1",
        rootMessageId: "root_buttons",
        payload: { bindingId: binding.id }
      });
    }
    await service.handleCardAction({
      actionId: "act_archive",
      action: "task_archive",
      userId: "user_1",
      chatId: "chat_1",
      rootMessageId: "root_buttons",
      payload: { bindingId: binding.id }
    });
    assert.equal(repo.findBindingById(binding.id)?.status, "archived");
    assert.equal(feishu.sent.filter((entry) => entry.type === "card").length >= 3, true);
    assert.equal(feishu.sent.filter((entry) => entry.type === "text").length >= 2, true);
  } finally {
    cleanup();
  }
});

test("approval list and detail buttons render stored pending approvals", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_approval_buttons",
      feishuChatId: "chat_1",
      feishuTopicRootMessageId: "root_approval_buttons",
      title: "Approval button task",
      status: "waiting_for_approval",
      createdFrom: "manual_import"
    });
    const approval = repo.upsertPendingApproval({
      sessionBindingId: binding.id,
      codexThreadId: binding.codexThreadId,
      requestId: "req_approval_buttons",
      approvalType: "command_execution",
      command: "npm test",
      riskLevel: "low"
    });
    await service.handleCardAction({
      actionId: "act_approval_list",
      action: "approval_list",
      userId: "user_1",
      chatId: "chat_1",
      rootMessageId: "root_approval_buttons",
      payload: { bindingId: binding.id }
    });
    await service.handleCardAction({
      actionId: "act_approval_detail",
      action: "approval_detail",
      userId: "user_1",
      chatId: "chat_1",
      rootMessageId: "root_approval_buttons",
      payload: { approvalId: approval.id }
    });
    assert.equal(feishu.sent.length, 2);
    assert.equal(feishu.sent.every((entry) => entry.type === "card"), true);
  } finally {
    cleanup();
  }
});
