import test from "node:test";
import assert from "node:assert/strict";
import { TaskService } from "../src/bridge/task-service.js";
import { makeConfig, makeLogger, makeTempRepo, MockCodex, MockFeishu } from "./helpers.js";
import { CardRenderer } from "../src/domain/cards.js";

test("hybrid cards render Card JSON 2.0 callback buttons for long connection", () => {
  const card = new CardRenderer("hybrid").consoleCard({ running: 0, approvals: 0, queued: 0, completedToday: 0 });
  const buttons = collectButtons(card);
  assert.equal(card.schema, "2.0");
  assert.ok(buttons.length > 0);
  const names = new Set<string>();
  for (const button of buttons) {
    assert.equal("value" in button, false);
    const behaviors = button.behaviors as Array<Record<string, unknown>>;
    assert.equal(behaviors[0]?.type, "callback");
    const value = behaviors[0]?.value as Record<string, unknown>;
    assert.equal(typeof value.action, "string");
    assert.equal(typeof value.actionId, "string");
    assert.equal(typeof button.name, "string");
    assert.equal(names.has(String(button.name)), false);
    names.add(String(button.name));
  }
});

test("claimable sessions card keeps button names unique when actions repeat", () => {
  const card = new CardRenderer("hybrid").claimableSessionsCard([
    { id: "thr_1", title: "Task 1", status: "idle", cwd: "C:\\repo-1" },
    { id: "thr_2", title: "Task 2", status: "idle", cwd: "C:\\repo-2" }
  ]);
  const buttons = collectButtons(card);
  assert.equal(buttons.length, 6);
  const names = buttons.map((button) => String(button.name));
  assert.deepEqual(new Set(names).size, names.length);
});

test("unclassified threads card exposes claim, summary and ignore actions", () => {
  const card = new CardRenderer("hybrid").unclassifiedThreadsCard([
    { id: "thr_unclassified", title: "Task 1", cwd: "C:\\repo-1", status: "idle" }
  ]);
  const buttons = collectButtons(card);
  assert.equal(buttons.length, 4);
});

test("message-command cards hide callback buttons but keep commands", () => {
  const card = new CardRenderer("message_command").consoleCard({ running: 0, approvals: 0, queued: 0, completedToday: 0 });
  assert.equal(collectButtons(card).length, 0);
  assert.equal(JSON.stringify(card).includes("/tasks"), true);
});

test("running topic replies are queued instead of dropped", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    codex.failSteer = true;
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

test("running topic replies prefer steer before falling back to queue", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_steer",
      feishuChatId: "chat_1",
      feishuTopicRootMessageId: "root_steer",
      feishuThreadId: "omt_steer",
      title: "Steer task",
      status: "running",
      createdFrom: "manual_import"
    });
    await service.handleMessage({
      messageId: "msg_steer",
      chatId: "chat_1",
      rootMessageId: "root_steer",
      threadId: null,
      userId: "user_1",
      text: "继续跑测试"
    });
    assert.equal(repo.listQueuedMessages(binding.id).length, 0);
    assert.equal(codex.steerRequests.length, 1);
    assert.equal(
      feishu.sent.some((entry) => entry.type === "text" && entry.mode === "thread" && String(entry.payload).includes("已追加要求")),
      true
    );
  } finally {
    cleanup();
  }
});

test("repeated Feishu command delivery is ignored after first handling", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    const message = {
      messageId: "msg_repeat",
      chatId: "chat_1",
      rootMessageId: "msg_repeat",
      threadId: null,
      userId: "user_1",
      text: "/codex"
    };
    await service.handleMessage(message);
    await service.handleMessage(message);
    assert.equal(feishu.sent.length, 1);
    assert.equal(repo.count("incoming_messages"), 1);
  } finally {
    cleanup();
  }
});

test("repeated new-task delivery starts only one Codex turn", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    const message = {
      messageId: "msg_new_task_repeat",
      chatId: "chat_1",
      rootMessageId: "msg_new_task_repeat",
      threadId: null,
      userId: "user_1",
      text: "帮我检查项目状态"
    };
    await service.handleMessage(message);
    await service.handleMessage(message);
    assert.equal(codex.turns.length, 1);
    assert.equal(repo.count("session_bindings"), 1);
  } finally {
    cleanup();
  }
});

test("direct group message creates a dedicated Feishu task chat before starting Codex turn", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    await service.handleMessage({
      messageId: "msg_group_new_task",
      chatId: "chat_1",
      rootMessageId: "msg_group_new_task",
      threadId: null,
      userId: "user_1",
      text: "帮我检查项目状态"
    });
    const binding = repo.findBindingByThreadId("thr_new");
    assert.ok(binding);
    assert.equal(feishu.createdChats.length, 1);
    assert.equal(binding.feishuContainerKind, "dedicated_chat");
    assert.equal(binding.feishuChatId, "task_chat_1");
    assert.equal(binding.feishuControlChatId, "chat_1");
    assert.equal(binding.feishuThreadId, null);
    assert.equal(feishu.sent.some((entry) => entry.chatId === "chat_1" && String(entry.payload).includes("已创建独立任务会话")), false);
    assert.equal(feishu.sent.some((entry) => entry.chatId === "task_chat_1" && String(entry.payload).includes("后续补充")), true);
    assert.equal(feishu.updatedChatNames.some((entry) => entry.chatId === "task_chat_1" && entry.name.includes("[运行中]")), true);
    assert.equal(feishu.createdChats[0]?.name.includes("C-"), false);
  } finally {
    cleanup();
  }
});

test("dedicated task chat replies find the bound task even when chat allowlist only contains control chat", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_dedicated_reply",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root",
      feishuContainerKind: "dedicated_chat",
      feishuControlChatId: "chat_1",
      title: "Dedicated task",
      status: "idle",
      createdFrom: "manual_import"
    });
    await service.handleMessage({
      messageId: "msg_dedicated_reply",
      chatId: "task_chat_1",
      rootMessageId: null,
      threadId: null,
      userId: "user_1",
      text: "继续处理"
    });
    assert.equal(codex.turns.length, 1);
    assert.equal(codex.turns[0]?.threadId, binding.codexThreadId);
  } finally {
    cleanup();
  }
});

test("continuing a completed dedicated task chat switches the chat title back to running", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    repo.createOrUpdateBinding({
      codexThreadId: "thr_resume_title",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root",
      feishuContainerKind: "dedicated_chat",
      feishuControlChatId: "chat_1",
      title: "恢复标题测试",
      status: "completed",
      createdFrom: "manual_import"
    });
    await service.handleMessage({
      messageId: "msg_resume_title",
      chatId: "task_chat_1",
      rootMessageId: null,
      threadId: null,
      userId: "user_1",
      text: "继续处理这个任务"
    });
    assert.equal(codex.turns.length, 1);
    assert.equal(
      feishu.updatedChatNames.some((entry) => entry.chatId === "task_chat_1" && entry.name === "[运行中] 恢复标题测试"),
      true
    );
  } finally {
    cleanup();
  }
});

test("replying to the task status card message still finds the bound topic", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_card_reply",
      feishuChatId: "chat_1",
      feishuTopicRootMessageId: "root_card_reply",
      feishuThreadId: "omt_card_reply",
      feishuTaskCardMessageId: "msg_task_card_1",
      title: "Card reply task",
      status: "idle",
      createdFrom: "manual_import"
    });
    await service.handleMessage({
      messageId: "msg_reply_on_card",
      chatId: "chat_1",
      rootMessageId: "root_card_reply",
      parentMessageId: "msg_task_card_1",
      threadId: null,
      userId: "user_1",
      text: "继续处理"
    });
    assert.equal(codex.turns.length, 1);
    assert.equal(codex.turns[0]?.threadId, binding.codexThreadId);
  } finally {
    cleanup();
  }
});

test("new task emits one running status and one completion notification", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const codex = new MockCodex();
    codex.threads = [
      {
        id: "thr_new",
        name: "只回复 ok",
        preview: "只回复 ok",
        cwd: dir,
        status: { type: "idle" },
        turns: [
          {
            id: "turn_1",
            status: "completed",
            items: [
              { type: "reasoning", summary: ["确认需求，只需要返回简短结果。"], content: [] },
              { type: "agentMessage", text: "ok" }
            ]
          }
        ],
        updatedAt: Date.now()
      }
    ];
    const feishu = new MockFeishu();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    await service.handleMessage({
      messageId: "msg_status_dedupe",
      chatId: "chat_1",
      rootMessageId: "msg_status_dedupe",
      threadId: null,
      userId: "user_1",
      text: "只回复 ok"
    });
    const binding = repo.findBindingByThreadId("thr_new");
    assert.ok(binding);
    const turnStarted = {
      method: "turn/started",
      params: {
        threadId: binding.codexThreadId,
        turn: {
          id: binding.lastTurnId ?? "turn_status_dedupe",
          status: "inProgress"
        }
      }
    };
    await codex.notifications.notification![0]!(turnStarted);
    await codex.notifications.notification![0]!(turnStarted);
    await codex.notifications.notification![0]!({
      method: "turn/completed",
      params: {
        threadId: binding.codexThreadId,
        turn: {
          id: binding.lastTurnId ?? "turn_status_dedupe",
          status: "completed"
        }
      }
    });
    const outbox = repo.listDueOutbox(10);
    assert.equal(outbox.filter((item) => item.notificationType === "task_status").length <= 1, true);
    assert.equal(outbox.filter((item) => item.notificationType === "task_completed").length, 2);
    assert.equal(outbox.some((item) => JSON.stringify(item.payload.card ?? {}).includes("处理摘要")), true);
    assert.equal(outbox.some((item) => JSON.stringify(item.payload.card ?? {}).includes("最终结论")), true);
    assert.deepEqual(codex.archived, []);
  } finally {
    cleanup();
  }
});

test("completed notification can still auto archive when explicitly enabled", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    config.codex.autoArchiveOnCompletion = true;
    const codex = new MockCodex();
    codex.threads = [
      {
        id: "thr_auto_archive",
        name: "Auto archive",
        preview: "Auto archive",
        cwd: dir,
        status: { type: "idle" },
        turns: [
          {
            id: "turn_auto_archive",
            status: "completed",
            items: [{ type: "agentMessage", text: "完成。" }]
          }
        ],
        updatedAt: Date.now()
      }
    ];
    const service = new TaskService(config, repo, codex as any, new MockFeishu(), makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_auto_archive",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root",
      feishuContainerKind: "dedicated_chat",
      title: "Auto archive",
      status: "running",
      createdFrom: "manual_import"
    });
    await codex.notifications.notification![0]!({
      method: "turn/completed",
      params: {
        threadId: binding.codexThreadId,
        turn: {
          id: "turn_auto_archive",
          status: "completed",
          items: []
        }
      }
    });
    assert.deepEqual(codex.archived, ["thr_auto_archive"]);
  } finally {
    cleanup();
  }
});

test("completed notification sends result from completed item when thread read has no turns", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const codex = new MockCodex();
    codex.threads = [
      {
        id: "thr_item_report",
        name: "Item report",
        preview: "Item report",
        cwd: dir,
        status: { type: "idle" },
        turns: [],
        updatedAt: Date.now()
      }
    ];
    const service = new TaskService(config, repo, codex as any, new MockFeishu(), makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_item_report",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root",
      feishuContainerKind: "dedicated_chat",
      title: "Item report",
      status: "running",
      createdFrom: "manual_import"
    });
    await codex.notifications.notification![0]!({
      method: "item/completed",
      params: {
        threadId: binding.codexThreadId,
        turnId: "turn_item_report",
        item: {
          type: "reasoning",
          id: "rs_1",
          summary: ["先检查输入，再整理结论。"],
          content: []
        }
      }
    });
    await codex.notifications.notification![0]!({
      method: "item/completed",
      params: {
        threadId: binding.codexThreadId,
        turnId: "turn_item_report",
        item: {
          type: "agentMessage",
          id: "am_1",
          text: "最终结论已经整理完成。"
        }
      }
    });
    await codex.notifications.notification![0]!({
      method: "turn/completed",
      params: {
        threadId: binding.codexThreadId,
        turn: {
          id: "turn_item_report",
          status: "completed",
          items: []
        }
      }
    });
    const result = repo.listDueOutbox(10).find((item) => item.notificationType === "task_completed" && JSON.stringify(item.payload.card ?? {}).includes("处理完成"));
    assert.ok(result);
    const payload = JSON.stringify(result.payload);
    assert.equal(payload.includes("处理摘要"), true);
    assert.equal(payload.includes("先检查输入，再整理结论。"), true);
    assert.equal(payload.includes("最终结论已经整理完成。"), true);
  } finally {
    cleanup();
  }
});

test("completed notification sends result from streamed deltas when read and turn items are empty", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const codex = new MockCodex();
    codex.threads = [
      {
        id: "thr_delta_report",
        name: "Delta report",
        preview: "Delta report",
        cwd: dir,
        status: { type: "idle" },
        turns: [],
        updatedAt: Date.now()
      }
    ];
    const service = new TaskService(config, repo, codex as any, new MockFeishu(), makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_delta_report",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root",
      feishuContainerKind: "dedicated_chat",
      title: "Delta report",
      status: "running",
      createdFrom: "manual_import"
    });
    await codex.notifications.notification![0]!({
      method: "item/plan/delta",
      params: { threadId: binding.codexThreadId, turnId: "turn_delta_report", itemId: "plan_1", delta: "先确认目标，" }
    });
    await codex.notifications.notification![0]!({
      method: "item/plan/delta",
      params: { threadId: binding.codexThreadId, turnId: "turn_delta_report", itemId: "plan_1", delta: "再输出结果。" }
    });
    await codex.notifications.notification![0]!({
      method: "item/agentMessage/delta",
      params: { threadId: binding.codexThreadId, turnId: "turn_delta_report", itemId: "am_1", delta: "已完成" }
    });
    await codex.notifications.notification![0]!({
      method: "item/agentMessage/delta",
      params: { threadId: binding.codexThreadId, turnId: "turn_delta_report", itemId: "am_1", delta: "并给出结论。" }
    });
    await codex.notifications.notification![0]!({
      method: "turn/completed",
      params: {
        threadId: binding.codexThreadId,
        turn: {
          id: "turn_delta_report",
          status: "completed",
          items: []
        }
      }
    });
    const result = repo.listDueOutbox(10).find((item) => item.notificationType === "task_completed" && JSON.stringify(item.payload.card ?? {}).includes("处理完成"));
    assert.ok(result);
    const payload = JSON.stringify(result.payload);
    assert.equal(payload.includes("先确认目标，再输出结果。"), true);
    assert.equal(payload.includes("已完成并给出结论。"), true);
    assert.equal("text" in result.payload, false);
  } finally {
    cleanup();
  }
});

test("running deltas enqueue readable progress updates for Feishu", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const codex = new MockCodex();
    const feishu = new MockFeishu();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_progress",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root",
      feishuContainerKind: "dedicated_chat",
      title: "Progress task",
      status: "running",
      createdFrom: "manual_import"
    });
    await codex.notifications.notification![0]!({
      method: "item/plan/delta",
      params: {
        threadId: binding.codexThreadId,
        turnId: "turn_progress",
        itemId: "plan_1",
        delta: "先确认输入和当前代码状态，再定位飞书进度消息缺失原因。"
      }
    });
    await codex.notifications.notification![0]!({
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: binding.codexThreadId,
        turnId: "turn_progress",
        itemId: "rs_1",
        delta: "已经定位到事件只写入本地记录，没有进入飞书发送队列。"
      }
    });
    assert.equal(repo.listDueOutbox(10).filter((item) => item.notificationType === "task_progress").length, 0);
    assert.equal(feishu.sent.filter((entry) => entry.type === "card" && entry.chatId === "task_chat_1").length, 1);
    assert.equal(feishu.updatedCards.length, 1);
    assert.equal(JSON.stringify(feishu.updatedCards[0]?.card).includes("处理摘要"), true);
    assert.equal(JSON.stringify(feishu.updatedCards[0]?.card).includes("处理步骤"), true);
  } finally {
    cleanup();
  }
});

test("completed notification keeps long final result for outbox chunking", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const codex = new MockCodex();
    const longFinal = Array.from({ length: 80 }, (_, index) => `第${index + 1}条建议：这部分最终结论需要完整回传到飞书。`).join("\n");
    codex.threads = [
      {
        id: "thr_long_result",
        name: "Long result",
        preview: "Long result",
        cwd: dir,
        status: { type: "idle" },
        turns: [
          {
            id: "turn_long_result",
            status: "completed",
            items: [
              { type: "reasoning", summary: ["整理长结论并保留完整文本。"], content: [] },
              { type: "agentMessage", text: longFinal }
            ]
          }
        ],
        updatedAt: Date.now()
      }
    ];
    const service = new TaskService(config, repo, codex as any, new MockFeishu(), makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_long_result",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root",
      feishuContainerKind: "dedicated_chat",
      title: "Long result",
      status: "running",
      createdFrom: "manual_import"
    });
    await codex.notifications.notification![0]!({
      method: "turn/completed",
      params: {
        threadId: binding.codexThreadId,
        turn: {
          id: "turn_long_result",
          status: "completed",
          items: []
        }
      }
    });
    const result = repo.listDueOutbox(10).find((item) => item.notificationType === "task_completed" && JSON.stringify(item.payload.card ?? {}).includes("处理完成"));
    assert.ok(result);
    assert.equal(JSON.stringify(result.payload.card).includes("最终结论"), true);
    assert.equal("text" in result.payload, true);
    assert.equal(String(result.payload.text).includes("第80条建议"), true);
    assert.equal(String(result.payload.text).includes("...(已截断)"), false);
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
    codex.failSteer = true;
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_queue",
      feishuChatId: "chat_1",
      feishuTopicRootMessageId: "root_queue",
      feishuThreadId: "omt_queue",
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
    assert.equal(
      feishu.sent.some((entry) => entry.type === "text" && entry.mode === "thread" && String(entry.payload).includes("排队：第 3 条")),
      true
    );
    await service.handleCardAction({
      actionId: "act_queue_view",
      action: "queue_view",
      userId: "user_1",
      chatId: "chat_1",
      rootMessageId: "root_queue",
      payload: { bindingId: binding.id }
    });
    assert.equal(feishu.sent.some((entry) => entry.type === "card" && entry.mode === "thread"), true);
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

test("card action deferred success text replies into bound thread", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_deferred",
      feishuChatId: "chat_1",
      feishuTopicRootMessageId: "root_deferred",
      feishuThreadId: "omt_deferred",
      title: "Deferred task",
      status: "completed",
      createdFrom: "manual_import"
    });
    await service.processCardActionDeferred({
      actionId: "act_archive_deferred",
      action: "task_archive",
      userId: "user_1",
      chatId: "chat_1",
      rootMessageId: "root_elsewhere",
      payload: { bindingId: binding.id }
    });
    assert.equal(
      feishu.sent.some((entry) => entry.type === "text" && entry.mode === "thread" && String(entry.payload).includes("任务已归档")),
      true
    );
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

test("console new task action creates a draft dedicated task chat", async () => {
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
    assert.equal(feishu.createdChats.length, 1);
    assert.equal(feishu.sent.length, 1);
    assert.equal(feishu.sent[0]?.type, "text");
    assert.equal(feishu.sent[0]?.chatId, "task_chat_1");
    assert.equal(String(feishu.sent[0]?.payload).includes("请直接发送"), true);
    const draft = repo.listBindings().find((binding) => binding.status === "waiting_for_prompt");
    assert.ok(draft);
    assert.equal(draft.feishuContainerKind, "dedicated_chat");
    assert.equal(draft.feishuChatId, "task_chat_1");
    assert.equal(draft.feishuThreadId, null);
  } finally {
    cleanup();
  }
});

test("doctor command and button render diagnostic cards in Feishu", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    await service.handleMessage({
      messageId: "msg_doctor",
      chatId: "chat_1",
      rootMessageId: "msg_doctor",
      threadId: null,
      userId: "user_1",
      text: "/doctor"
    });
    await service.handleCardAction({
      actionId: "act_doctor",
      action: "doctor",
      userId: "user_1",
      chatId: "chat_1",
      rootMessageId: "root_console",
      payload: {}
    });
    assert.equal(feishu.sent.length, 2);
    assert.equal(feishu.sent.every((entry) => entry.type === "card"), true);
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
    assert.equal(binding.feishuContainerKind, "dedicated_chat");
    assert.equal(binding.feishuChatId, "task_chat_1");
    assert.equal(binding.feishuThreadId, null);
    assert.equal(binding.createdFrom, "codex_app_claimed");
    assert.equal(feishu.createdChats.length, 1);
    assert.equal(feishu.sent.some((entry) => entry.chatId === "chat_1" && String(entry.payload).includes("已创建独立任务会话")), false);
    assert.equal(repo.listDueOutbox(10).some((item) => item.feishuChatId === "task_chat_1" && item.notificationType === "task_status"), true);
  } finally {
    cleanup();
  }
});

test("message command can claim an existing Codex thread without card callback", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    codex.threads = [
      {
        id: "thr_command_claim",
        name: "Command claimed task",
        preview: "Command claimed task",
        cwd: dir,
        status: { type: "idle" },
        updatedAt: Date.now()
      }
    ];
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    await service.handleMessage({
      messageId: "msg_claim_command",
      chatId: "chat_1",
      rootMessageId: "root_claim_command",
      threadId: null,
      userId: "user_1",
      text: "/claim thr_command_claim"
    });
    const binding = repo.findBindingByThreadId("thr_command_claim");
    assert.ok(binding);
    assert.equal(binding.feishuContainerKind, "dedicated_chat");
    assert.equal(binding.feishuChatId, "task_chat_1");
    assert.equal(binding.feishuThreadId, null);
    assert.equal(binding.createdFrom, "codex_app_claimed");
  } finally {
    cleanup();
  }
});

test("message commands cover project, notification, status and logs actions", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    repo.createOrUpdateBinding({
      codexThreadId: "thr_commands",
      feishuChatId: "chat_1",
      feishuTopicRootMessageId: "root_commands",
      title: "Command task",
      cwd: dir,
      status: "completed",
      createdFrom: "manual_import"
    });
    for (const [index, text] of ["/projects", "/notify test", "/notify history", "/status", "/logs"].entries()) {
      await service.handleMessage({
        messageId: `msg_command_${index}`,
        chatId: "chat_1",
        rootMessageId: index < 3 ? `root_command_${index}` : "root_commands",
        threadId: null,
        userId: "user_1",
        text
      });
    }
    assert.equal(feishu.sent.some((entry) => entry.type === "text" && String(entry.payload).includes("测试通知")), true);
    assert.equal(feishu.sent.filter((entry) => entry.type === "card").length >= 4, true);
  } finally {
    cleanup();
  }
});

test("claim summary and ignore commands work without card callback", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    codex.threads = [
      {
        id: "thr_summary",
        name: "Summary task",
        preview: "Summary task",
        cwd: dir,
        status: { type: "idle" },
        updatedAt: Date.now()
      }
    ];
    (codex as unknown as { readThread: (threadId: string) => Promise<Record<string, unknown>> }).readThread = async () => ({
      thread: {
        id: "thr_summary",
        name: "Summary task",
        preview: "Summary task",
        cwd: dir,
        status: { type: "idle" },
        updatedAt: Date.now(),
        turns: [
          {
            id: "turn_1",
            status: "completed",
            items: [
              { type: "commandExecution", command: "npm test" },
              { type: "agentMessage", text: "已经完成检查并整理结果。" }
            ]
          }
        ]
      }
    });
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    await service.handleMessage({
      messageId: "msg_claim_summary",
      chatId: "chat_1",
      rootMessageId: "root_claim_summary",
      threadId: null,
      userId: "user_1",
      text: "/claim summary thr_summary"
    });
    await service.handleMessage({
      messageId: "msg_claim_ignore",
      chatId: "chat_1",
      rootMessageId: "root_claim_ignore",
      threadId: null,
      userId: "user_1",
      text: "/claim ignore thr_summary"
    });
    assert.equal(feishu.sent.some((entry) => String(entry.payload).includes("任务摘要：Summary task")), true);
    assert.equal(feishu.sent.some((entry) => String(entry.payload).includes("最近执行步骤：1 个")), true);
    assert.equal(feishu.sent.some((entry) => String(entry.payload).includes("npm test")), false);
    assert.equal(repo.findIgnoredThread("thr_summary")?.codexThreadId, "thr_summary");
  } finally {
    cleanup();
  }
});

test("unclassified command lists only unclassified and non-ignored tasks", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    config.projects = [{ id: "proj_1", name: "Known", rootPath: dir }];
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    codex.threads = [
      {
        id: "thr_known",
        name: "Known task",
        preview: "Known task",
        cwd: dir,
        status: { type: "idle" },
        updatedAt: Date.now()
      },
      {
        id: "thr_unclassified_visible",
        name: "Visible task",
        preview: "Visible task",
        cwd: "C:\\other",
        status: { type: "idle" },
        updatedAt: Date.now()
      },
      {
        id: "thr_unclassified_ignored",
        name: "Ignored task",
        preview: "Ignored task",
        cwd: "C:\\ignored",
        status: { type: "idle" },
        updatedAt: Date.now()
      }
    ];
    repo.ignoreThread({ codexThreadId: "thr_unclassified_ignored", title: "Ignored task", createdByFeishuUserId: "user_1" });
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    await service.bootstrapProjectsFromConfig();
    await service.handleMessage({
      messageId: "msg_unclassified",
      chatId: "chat_1",
      rootMessageId: "root_unclassified",
      threadId: null,
      userId: "user_1",
      text: "/unclassified"
    });
    const payload = JSON.stringify(feishu.sent.find((entry) => entry.type === "card")?.payload ?? {});
    assert.equal(payload.includes("Visible task"), true);
    assert.equal(payload.includes("Known task"), false);
    assert.equal(payload.includes("Ignored task"), false);
  } finally {
    cleanup();
  }
});

test("unclassified create project action creates project and bind rules", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    codex.threads = [
      {
        id: "thr_create_project",
        name: "Create project task",
        preview: "Create project task",
        cwd: dir,
        status: { type: "idle" },
        updatedAt: Date.now()
      }
    ];
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    await service.handleCardAction({
      actionId: "act_create_project",
      action: "unclassified_create_project",
      userId: "user_1",
      chatId: "chat_1",
      rootMessageId: "root_create_project",
      payload: { codexThreadId: "thr_create_project" }
    });
    const projects = repo.listProjects();
    assert.equal(projects.length, 1);
    assert.equal(projects[0]?.rootPath, dir);
    assert.equal(repo.findProjectForContext({ cwd: dir })?.id, projects[0]?.id);
  } finally {
    cleanup();
  }
});

test("assign project command binds future unclassified thread lookup to existing project", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const project = repo.upsertProject({ id: "proj_assigned", name: "Assigned", rootPath: "C:\\known" });
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    codex.threads = [
      {
        id: "thr_assign_project",
        name: "Assign project task",
        preview: "Assign project task",
        cwd: "C:\\mapped\\repo",
        status: { type: "idle" },
        updatedAt: Date.now()
      }
    ];
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    await service.handleMessage({
      messageId: "msg_assign_project",
      chatId: "chat_1",
      rootMessageId: "root_assign_project",
      threadId: null,
      userId: "user_1",
      text: `/assign-project thr_assign_project ${project.id}`
    });
    assert.equal(repo.findProjectForContext({ cwd: "C:\\mapped\\repo\\subdir" })?.id, project.id);
    assert.equal(feishu.sent.some((entry) => String(entry.payload).includes("已将任务归入项目")), true);
  } finally {
    cleanup();
  }
});

test("pick project command shows assignment card without card callback", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    repo.upsertProject({ id: "proj_existing", name: "Existing", rootPath: "C:\\known" });
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    codex.threads = [
      {
        id: "thr_pick_project",
        name: "Pick project task",
        preview: "Pick project task",
        cwd: "C:\\mapped\\repo",
        status: { type: "idle" },
        updatedAt: Date.now()
      }
    ];
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    await service.handleMessage({
      messageId: "msg_pick_project",
      chatId: "chat_1",
      rootMessageId: "root_pick_project",
      threadId: null,
      userId: "user_1",
      text: "/pick-project thr_pick_project"
    });
    const payload = JSON.stringify(feishu.sent.find((entry) => entry.type === "card")?.payload ?? {});
    assert.equal(payload.includes("归入已有项目"), true);
    assert.equal(payload.includes("/assign-project thr_pick_project proj_existing"), true);
  } finally {
    cleanup();
  }
});

test("unclassified command excludes threads that match project by cwd rule", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const project = repo.upsertProject({ id: "proj_mapped", name: "Path mapped", rootPath: "C:\\known" });
    repo.addProjectMatchRule({
      projectId: project.id,
      ruleType: "cwd_prefix",
      ruleValue: dir
    });
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    codex.threads = [
      {
        id: "thr_path_mapped",
        name: "Path mapped task",
        preview: "Path mapped task",
        cwd: dir,
        status: { type: "idle" },
        updatedAt: Date.now()
      },
      {
        id: "thr_unclassified_still",
        name: "Still unclassified",
        preview: "Still unclassified",
        cwd: "C:\\other-unclassified",
        status: { type: "idle" },
        updatedAt: Date.now()
      }
    ];
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    await service.bootstrapProjectsFromConfig();
    await service.handleMessage({
      messageId: "msg_unclassified_path",
      chatId: "chat_1",
      rootMessageId: "root_unclassified_path",
      threadId: null,
      userId: "user_1",
      text: "/unclassified"
    });
    const payload = JSON.stringify(feishu.sent.find((entry) => entry.type === "card")?.payload ?? {});
    assert.equal(payload.includes("Path mapped task"), false);
    assert.equal(payload.includes("Still unclassified"), true);
  } finally {
    cleanup();
  }
});

test("queue commands can view and cancel queued messages without card callback", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_queue_command",
      feishuChatId: "chat_1",
      feishuTopicRootMessageId: "root_queue_command",
      title: "Queue command task",
      status: "running",
      createdFrom: "manual_import"
    });
    const queued = repo.enqueueMessage({
      sessionBindingId: binding.id,
      feishuMessageId: "msg_queued_command",
      text: "queued work",
      createdByFeishuUserId: "user_1"
    });
    await service.handleMessage({
      messageId: "msg_queue_view_command",
      chatId: "chat_1",
      rootMessageId: "root_queue_command",
      threadId: null,
      userId: "user_1",
      text: "/queue"
    });
    await service.handleMessage({
      messageId: "msg_queue_cancel_command",
      chatId: "chat_1",
      rootMessageId: "root_queue_command",
      threadId: null,
      userId: "user_1",
      text: `/queue cancel ${queued.id}`
    });
    assert.equal(repo.getQueuedMessage(queued.id)?.status, "cancelled");
    assert.equal(feishu.sent.some((entry) => entry.type === "card"), true);
    assert.equal(feishu.sent.some((entry) => entry.type === "text" && String(entry.payload).includes("已处理")), true);
  } finally {
    cleanup();
  }
});

test("approval commands resolve approvals without card callback", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_approval_command",
      feishuChatId: "chat_1",
      feishuTopicRootMessageId: "root_approval_command",
      title: "Approval command task",
      status: "waiting_for_approval",
      createdFrom: "manual_import"
    });
    const approval = repo.upsertPendingApproval({
      sessionBindingId: binding.id,
      codexThreadId: binding.codexThreadId,
      requestId: "req_approval_command",
      approvalType: "command_execution",
      command: "npm test",
      riskLevel: "low"
    });
    await service.handleMessage({
      messageId: "msg_approval_detail_command",
      chatId: "chat_1",
      rootMessageId: "root_approval_command",
      threadId: null,
      userId: "user_1",
      text: `/approval detail ${approval.id}`
    });
    await service.handleMessage({
      messageId: "msg_approval_once_command",
      chatId: "chat_1",
      rootMessageId: "root_approval_command",
      threadId: null,
      userId: "user_1",
      text: `/approval once ${approval.id}`
    });
    assert.equal(repo.findApprovalById(approval.id)?.status, "approved_once");
    assert.equal(codex.responses.length, 1);
    assert.equal(feishu.sent.some((entry) => entry.type === "card"), true);
    assert.equal(feishu.sent.some((entry) => entry.type === "text" && String(entry.payload).includes("已处理")), true);
  } finally {
    cleanup();
  }
});

test("task control commands require a bound task and can stop, retry, run tests and archive", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_control_command",
      feishuChatId: "chat_1",
      feishuTopicRootMessageId: "root_control_command",
      title: "Control command task",
      cwd: dir,
      status: "failed",
      createdFrom: "manual_import"
    });
    repo.updateBindingStatus(binding.id, "failed", "turn_control_command");
    await service.handleMessage({
      messageId: "msg_orphan_status_command",
      chatId: "chat_1",
      rootMessageId: "root_orphan_command",
      threadId: null,
      userId: "user_1",
      text: "/status"
    });
    await service.handleMessage({
      messageId: "msg_retry_command",
      chatId: "chat_1",
      rootMessageId: "root_control_command",
      threadId: null,
      userId: "user_1",
      text: "/retry"
    });
    repo.updateBindingStatus(binding.id, "idle");
    await service.handleMessage({
      messageId: "msg_run_tests_command",
      chatId: "chat_1",
      rootMessageId: "root_control_command",
      threadId: null,
      userId: "user_1",
      text: "/run-tests"
    });
    await service.handleMessage({
      messageId: "msg_stop_command",
      chatId: "chat_1",
      rootMessageId: "root_control_command",
      threadId: null,
      userId: "user_1",
      text: "/stop"
    });
    await service.handleMessage({
      messageId: "msg_archive_command",
      chatId: "chat_1",
      rootMessageId: "root_control_command",
      threadId: null,
      userId: "user_1",
      text: "/archive"
    });
    assert.equal(feishu.sent.some((entry) => String(entry.payload).includes("需要在已绑定的任务会话里发送")), true);
    assert.equal(codex.turns.length >= 2, true);
    assert.deepEqual(codex.interrupted, ["thr_control_command"]);
    assert.equal(repo.findBindingById(binding.id)?.status, "archived");
    assert.deepEqual(codex.archived, ["thr_control_command"]);
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

test("bootstrap keeps terminal bindings when thread read reports idle", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const codex = new MockCodex();
    codex.threads = [
      {
        id: "thr_terminal",
        name: "Terminal task",
        preview: "Terminal task",
        cwd: dir,
        status: { type: "idle" },
        updatedAt: Date.now()
      }
    ];
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_terminal",
      feishuChatId: "chat_1",
      feishuTopicRootMessageId: "root_terminal",
      title: "Terminal task",
      status: "completed",
      createdFrom: "manual_import"
    });
    const service = new TaskService(config, repo, codex as any, new MockFeishu(), makeLogger(dir));
    await service.bootstrapProjectsFromConfig();
    assert.equal(repo.findBindingById(binding.id)?.status, "completed");
    assert.equal(repo.listDueOutbox(10).filter((item) => item.notificationType === "task_status").length, 0);
  } finally {
    cleanup();
  }
});

test("bootstrap restores terminal status from event history after stale idle reconcile", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const codex = new MockCodex();
    codex.threads = [
      {
        id: "thr_restore_terminal",
        name: "Restore terminal task",
        preview: "Restore terminal task",
        cwd: dir,
        status: { type: "idle" },
        updatedAt: Date.now()
      }
    ];
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_restore_terminal",
      feishuChatId: "chat_1",
      feishuTopicRootMessageId: "root_restore_terminal",
      title: "Restore terminal task",
      status: "idle",
      createdFrom: "manual_import"
    });
    repo.insertEvent({
      sessionBindingId: binding.id,
      codexThreadId: binding.codexThreadId,
      codexTurnId: "turn_restore_terminal",
      eventType: "task.completed",
      eventPayload: { text: "任务完成" }
    });
    const service = new TaskService(config, repo, codex as any, new MockFeishu(), makeLogger(dir));
    await service.bootstrapProjectsFromConfig();
    assert.equal(repo.findBindingById(binding.id)?.status, "completed");
    assert.equal(
      repo.listEventsForBinding(binding.id).some((event) => event.eventType === "session.reconcile_restored_terminal_status"),
      true
    );
  } finally {
    cleanup();
  }
});

test("bootstrap skips draft task chats that do not have real Codex thread ids yet", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const codex = new MockCodex();
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "draft_waiting_prompt",
      feishuChatId: "task_chat_draft",
      feishuTopicRootMessageId: "task-draft",
      feishuContainerKind: "dedicated_chat",
      title: "Draft task",
      status: "waiting_for_prompt",
      createdFrom: "feishu_new_task"
    });
    const service = new TaskService(config, repo, codex as any, new MockFeishu(), makeLogger(dir));
    await service.bootstrapProjectsFromConfig();
    assert.equal(repo.findBindingById(binding.id)?.status, "waiting_for_prompt");
    assert.equal(repo.listEventsForBinding(binding.id).some((event) => event.eventType === "session.reconcile_failed"), false);
  } finally {
    cleanup();
  }
});

test("bootstrap attempts to unarchive completed Codex threads that disappeared from app list", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    codex.readFailures.set("thr_restore_archived", new Error("no rollout found for thread id thr_restore_archived"));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_restore_archived",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root",
      feishuContainerKind: "dedicated_chat",
      title: "Restore archived",
      status: "completed",
      createdFrom: "manual_import"
    });
    repo.insertEvent({
      sessionBindingId: binding.id,
      codexThreadId: binding.codexThreadId,
      eventType: "task.completed",
      eventPayload: { text: "已完成" }
    });
    (codex as any).unarchiveThread = async (threadId: string) => {
      codex.unarchived.push(threadId);
      codex.readFailures.delete(threadId);
      return {};
    };
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    await service.bootstrapProjectsFromConfig();
    assert.deepEqual(codex.unarchived, ["thr_restore_archived"]);
    assert.equal(
      repo.listEventsForBinding(binding.id).some((event) => event.eventType === "session.unarchived_codex_thread"),
      true
    );
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
      feishuThreadId: "omt_buttons",
      title: "Button task",
      cwd: dir,
      status: "completed",
      createdFrom: "manual_import"
    });
    repo.insertEvent({
      sessionBindingId: binding.id,
      codexThreadId: binding.codexThreadId,
      eventType: "task.completed",
      eventPayload: { text: "done", finalResult: "最终答案：已经处理完成。", reasoningSummary: "先分析，再执行。" }
    });
    repo.insertEvent({
      sessionBindingId: binding.id,
      codexThreadId: binding.codexThreadId,
      codexTurnId: "turn_buttons",
      eventType: "codex.plan_updated",
      eventPayload: { text: "1. [完成] 收集上下文 2. [完成] 给出结论" }
    });
    repo.enqueueOutbox({
      sessionBindingId: binding.id,
      notificationType: "task_completed",
      feishuChatId: "chat_1",
      feishuTopicRootMessageId: "root_buttons",
      payload: { text: "done" },
      dedupeKey: "button-history"
    });
    for (const [index, action] of ["task_status", "task_logs", "notification_history", "send_test_notification"].entries()) {
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
    assert.equal(feishu.sent.filter((entry) => entry.type === "text").length >= 1, true);
    assert.equal(
      feishu.sent.filter((entry) => entry.mode === "thread" && entry.root === "root_buttons").length >= 2,
      true
    );
    assert.equal(
      feishu.sent.some(
        (entry) =>
          entry.type === "card" &&
          entry.mode === "thread" &&
          JSON.stringify(entry.payload).includes("处理记录") &&
          JSON.stringify(entry.payload).includes("最终结论") &&
          JSON.stringify(entry.payload).includes("恢复标题测试") === false
      ),
      true
    );
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
      feishuThreadId: "omt_approval_buttons",
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
    assert.equal(feishu.sent.every((entry) => entry.mode === "thread" && entry.root === "root_approval_buttons"), true);
  } finally {
    cleanup();
  }
});

const collectButtons = (value: unknown): Array<Record<string, unknown>> => {
  const found: Array<Record<string, unknown>> = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const object = node as Record<string, unknown>;
    if (object.tag === "button") found.push(object);
    for (const child of Object.values(object)) visit(child);
  };
  visit(value);
  return found;
};
