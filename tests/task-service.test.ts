import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

test("console card exposes control-group buttons for unclassified and notification operations", () => {
  const card = new CardRenderer("hybrid").consoleCard({ running: 1, approvals: 2, queued: 3, completedToday: 4 });
  const buttons = collectButtons(card);
  const labels = buttons.map((button) => String((button.text as Record<string, unknown>)?.content ?? ""));
  assert.equal(labels.includes("未归类"), true);
  assert.equal(labels.includes("项目"), true);
  assert.equal(labels.includes("最近任务"), true);
  assert.equal(labels.includes("待确认"), true);
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

test("repeated control-group task text only opens one project selection", async () => {
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
    assert.equal(codex.turns.length, 0);
    assert.equal(repo.count("session_bindings"), 0);
    assert.equal(repo.count("pending_project_prompts"), 1);
    assert.equal(feishu.sent.length, 1);
    assert.equal(JSON.stringify(feishu.sent[0]?.payload ?? {}).includes("选择项目"), true);
  } finally {
    cleanup();
  }
});

test("control-group task text waits for a project before starting Codex turn", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    const project = repo.upsertProject({
      id: "proj_group_start",
      name: "Group start",
      rootPath: dir,
      defaultModel: "gpt-5.5",
      defaultReasoningEffort: "xhigh"
    });
    await service.handleMessage({
      messageId: "msg_group_new_task",
      chatId: "chat_1",
      rootMessageId: "msg_group_new_task",
      threadId: null,
      userId: "user_1",
      text: "帮我检查项目状态"
    });
    const pendingPrompt = repo.findPendingProjectPromptByMessageId("msg_group_new_task");
    assert.ok(pendingPrompt);
    assert.equal(codex.turns.length, 0);
    await service.handleCardAction({
      actionId: "act_start_pending_prompt",
      action: "project_start_prompt",
      userId: "user_1",
      chatId: "chat_1",
      rootMessageId: "msg_group_new_task",
      payload: { projectId: project.id, pendingPromptId: pendingPrompt.id }
    });
    const binding = repo.findBindingByThreadId("thr_new");
    assert.ok(binding);
    assert.equal(feishu.createdChats.length, 1);
    assert.equal(binding.feishuContainerKind, "dedicated_chat");
    assert.equal(binding.feishuChatId, "task_chat_1");
    assert.equal(binding.feishuControlChatId, "chat_1");
    assert.equal(binding.feishuThreadId, null);
    assert.equal(binding.projectId, project.id);
    assert.equal(feishu.sent.some((entry) => entry.chatId === "chat_1" && String(entry.payload).includes("已创建独立任务会话")), false);
    assert.equal(feishu.sent.some((entry) => entry.chatId === "task_chat_1" && String(entry.payload).includes("后续补充")), true);
    assert.equal(feishu.updatedChatNames.some((entry) => entry.chatId === "task_chat_1" && entry.name.includes("[运行中]")), true);
    assert.equal(feishu.createdChats[0]?.name.includes("C-"), false);
    assert.equal(codex.startedThreads[0]?.cwd, dir);
    assert.equal(codex.startedThreads[0]?.model, "gpt-5.5");
    assert.equal(codex.startedThreads[0]?.reasoningEffort, "xhigh");
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

test("continuing a dedicated task updates the existing status card instead of sending a duplicate one", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_single_status_card",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root",
      feishuContainerKind: "dedicated_chat",
      title: "Single status card",
      status: "completed",
      createdFrom: "manual_import"
    });
    repo.updateBindingTaskCardMessageId(binding.id, "msg_task_card_existing");
    await service.handleMessage({
      messageId: "msg_continue_single_card",
      chatId: "task_chat_1",
      rootMessageId: null,
      threadId: null,
      userId: "user_1",
      text: "继续追问"
    });
    assert.equal(feishu.sent.filter((entry) => entry.type === "card" && entry.chatId === "task_chat_1").length, 0);
    assert.equal(feishu.updatedCards.some((entry) => entry.messageId === "msg_task_card_existing"), true);
  } finally {
    cleanup();
  }
});

test("dedicated task progress card replies to the existing task card", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    repo.createOrUpdateBinding({
      codexThreadId: "thr_progress_target",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root",
      feishuTaskCardMessageId: "om_task_card_progress",
      feishuContainerKind: "dedicated_chat",
      title: "Progress target",
      status: "running",
      createdFrom: "manual_import"
    });
    await codex.notifications.notification![0]!({
      method: "item/plan/delta",
      params: {
        threadId: "thr_progress_target",
        turnId: "turn_progress_target",
        itemId: "plan_progress_target",
        delta: "正在整理处理步骤。"
      }
    });
    assert.equal(feishu.sent.length, 1);
    assert.equal(feishu.sent[0]?.type, "card");
    assert.equal(feishu.sent[0]?.chatId, "task_chat_1");
    assert.equal(feishu.sent[0]?.root, "om_task_card_progress");
  } finally {
    cleanup();
  }
});

test("open task action from control chat does not replay task status into the control chat", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_open_bound",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root",
      feishuContainerKind: "dedicated_chat",
      feishuControlChatId: "chat_1",
      title: "Open bound task",
      status: "running",
      createdFrom: "manual_import"
    });
    const result = await service.handleCardAction({
      actionId: "act_open_bound",
      action: "open_bound_topic",
      userId: "user_1",
      chatId: "chat_1",
      rootMessageId: "root_control",
      payload: { bindingId: binding.id }
    });
    assert.equal(String(result.text).includes("主控群"), true);
    assert.equal(feishu.sent.filter((entry) => entry.type === "card").length, 0);
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
    const project = repo.upsertProject({ id: "proj_status_dedupe", name: "Status dedupe", rootPath: dir });
    await service.handleMessage({
      messageId: "msg_status_dedupe",
      chatId: "chat_1",
      rootMessageId: "msg_status_dedupe",
      threadId: null,
      userId: "user_1",
      text: "只回复 ok"
    });
    const pendingPrompt = repo.findPendingProjectPromptByMessageId("msg_status_dedupe");
    assert.ok(pendingPrompt);
    await service.handleCardAction({
      actionId: "act_status_dedupe_start",
      action: "project_start_prompt",
      userId: "user_1",
      chatId: "chat_1",
      rootMessageId: "msg_status_dedupe",
      payload: { projectId: project.id, pendingPromptId: pendingPrompt.id }
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

test("status card summary uses short plain text instead of visible truncation marker", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const codex = new MockCodex();
    const longFinal = Array.from({ length: 20 }, (_, index) => `第${index + 1}条结论：这里是比较长的摘要内容`).join("，");
    codex.threads = [
      {
        id: "thr_status_summary",
        name: "Status summary",
        preview: "Status summary",
        cwd: dir,
        status: { type: "idle" },
        turns: [
          {
            id: "turn_status_summary",
            status: "completed",
            items: [{ type: "agentMessage", text: longFinal }]
          }
        ],
        updatedAt: Date.now()
      }
    ];
    const service = new TaskService(config, repo, codex as any, new MockFeishu(), makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_status_summary",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root",
      feishuContainerKind: "dedicated_chat",
      title: "Status summary",
      status: "running",
      createdFrom: "manual_import"
    });
    await codex.notifications.notification![0]!({
      method: "turn/completed",
      params: {
        threadId: binding.codexThreadId,
        turn: {
          id: "turn_status_summary",
          status: "completed",
          items: []
        }
      }
    });
    const statusOutbox = repo.listDueOutbox(10).find(
      (item) => item.notificationType === "task_completed" && JSON.stringify(item.payload.card ?? {}).includes("直接回复即可继续处理")
    );
    assert.ok(statusOutbox);
    assert.equal(JSON.stringify(statusOutbox.payload.card).includes("...(已截断)"), false);
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
    const result = findTaskReportOutbox(repo.listDueOutbox(10));
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
    const result = findTaskReportOutbox(repo.listDueOutbox(10));
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

test("codex item lifecycle events update Feishu progress without raw terminal spam", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const codex = new MockCodex();
    const feishu = new MockFeishu();
    new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_item_progress",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root",
      feishuContainerKind: "dedicated_chat",
      title: "Item progress",
      status: "running",
      createdFrom: "manual_import"
    });
    await codex.notifications.notification![0]!({
      method: "item/started",
      params: {
        threadId: binding.codexThreadId,
        turnId: "turn_item_progress",
        item: {
          type: "commandExecution",
          id: "cmd_1",
          command: "npm run check",
          cwd: dir,
          status: "inProgress",
          commandActions: [{ type: "unknown", command: "npm run check" }]
        }
      }
    });
    await codex.notifications.notification![0]!({
      method: "item/fileChange/patchUpdated",
      params: {
        threadId: binding.codexThreadId,
        turnId: "turn_item_progress",
        itemId: "patch_1",
        changes: [
          { path: "src/bridge/task-service.ts", kind: { type: "update", move_path: null }, diff: "..." },
          { path: "tests/task-service.test.ts", kind: { type: "update", move_path: null }, diff: "..." }
        ]
      }
    });
    await codex.notifications.notification![0]!({
      method: "item/commandExecution/outputDelta",
      params: {
        threadId: binding.codexThreadId,
        turnId: "turn_item_progress",
        itemId: "cmd_1",
        delta: "raw terminal output should stay in local records"
      }
    });
    const latest = JSON.stringify(feishu.updatedCards.at(-1)?.card ?? feishu.sent.at(-1)?.payload ?? {});
    assert.equal(latest.includes("执行命令"), true);
    assert.equal(latest.includes("文件变更"), true);
    assert.equal(latest.includes("src/bridge/task-service.ts"), true);
    assert.equal(latest.includes("raw terminal output should stay"), false);
    assert.equal(repo.listEventsForBinding(binding.id).some((event) => event.eventType === "codex.command_output"), true);
  } finally {
    cleanup();
  }
});

test("raw response item completion fills Feishu progress and final report fallback", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const codex = new MockCodex();
    codex.threads = [
      {
        id: "thr_raw_response",
        name: "Raw response",
        preview: "Raw response",
        cwd: dir,
        status: { type: "idle" },
        turns: [{ id: "turn_raw_response", status: "completed", items: [] }],
        updatedAt: Date.now()
      }
    ];
    const feishu = new MockFeishu();
    new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_raw_response",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root",
      feishuContainerKind: "dedicated_chat",
      title: "Raw response",
      status: "running",
      createdFrom: "manual_import"
    });
    await codex.notifications.notification![0]!({
      method: "rawResponseItem/completed",
      params: {
        threadId: binding.codexThreadId,
        turnId: "turn_raw_response",
        item: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "已经完成原因定位。" }],
          encrypted_content: null
        }
      }
    });
    await codex.notifications.notification![0]!({
      method: "rawResponseItem/completed",
      params: {
        threadId: binding.codexThreadId,
        turnId: "turn_raw_response",
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "最终结论：飞书现在能收到 Codex App 输出。" }]
        }
      }
    });
    await codex.notifications.notification![0]!({
      method: "turn/completed",
      params: {
        threadId: binding.codexThreadId,
        turn: { id: "turn_raw_response", status: "completed", items: [] }
      }
    });
    const report = findTaskReportOutbox(repo.listDueOutbox(10));
    assert.ok(report);
    const payload = JSON.stringify(report.payload);
    assert.equal(payload.includes("已经完成原因定位。"), true);
    assert.equal(payload.includes("最终结论：飞书现在能收到 Codex App 输出。"), true);
  } finally {
    cleanup();
  }
});

test("completed notification does not resend full final result when card can show it", async () => {
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
    const result = findTaskReportOutbox(repo.listDueOutbox(10));
    assert.ok(result);
    assert.equal(JSON.stringify(result.payload.card).includes("最终结论"), true);
    assert.equal(JSON.stringify(result.payload.card).includes("第80条建议"), true);
    assert.equal("text" in result.payload, false);
  } finally {
    cleanup();
  }
});

test("completed notification sends supplemental cards before full text when final result is capped", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const codex = new MockCodex();
    const longFinal = Array.from({ length: 220 }, (_, index) => `第${index + 1}条建议：这部分最终结论需要优先通过飞书补充卡片展示，避免用户阅读一大段纯文本。`).join("\n");
    codex.threads = [
      {
        id: "thr_capped_result",
        name: "Capped result",
        preview: "Capped result",
        cwd: dir,
        status: { type: "idle" },
        turns: [
          {
            id: "turn_capped_result",
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
      codexThreadId: "thr_capped_result",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root",
      feishuContainerKind: "dedicated_chat",
      title: "Capped result",
      status: "running",
      createdFrom: "manual_import"
    });
    await codex.notifications.notification![0]!({
      method: "turn/completed",
      params: {
        threadId: binding.codexThreadId,
        turn: {
          id: "turn_capped_result",
          status: "completed",
          items: []
        }
      }
    });
    const result = findTaskReportOutbox(repo.listDueOutbox(10));
    assert.ok(result);
    assert.equal(JSON.stringify(result.payload.card).includes("最终结论"), true);
    assert.equal(Array.isArray(result.payload.cards), true);
    assert.equal(JSON.stringify(result.payload.cards).includes("最终结论补充"), true);
    assert.equal(JSON.stringify(result.payload.cards).includes("第220条建议"), true);
    assert.equal("text" in result.payload, false);
  } finally {
    cleanup();
  }
});

test("completed notification sends full text only after supplemental cards are exhausted", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const codex = new MockCodex();
    const longFinal = Array.from({ length: 1200 }, (_, index) => `第${index + 1}条建议：这部分最终结论超出多张飞书补充卡片容量，因此需要完整文本作为兜底。`).join("\n");
    codex.threads = [
      {
        id: "thr_text_fallback_result",
        name: "Text fallback result",
        preview: "Text fallback result",
        cwd: dir,
        status: { type: "idle" },
        turns: [
          {
            id: "turn_text_fallback_result",
            status: "completed",
            items: [
              { type: "reasoning", summary: ["整理极长结论并保留完整文本。"], content: [] },
              { type: "agentMessage", text: longFinal }
            ]
          }
        ],
        updatedAt: Date.now()
      }
    ];
    const service = new TaskService(config, repo, codex as any, new MockFeishu(), makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_text_fallback_result",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root",
      feishuContainerKind: "dedicated_chat",
      title: "Text fallback result",
      status: "running",
      createdFrom: "manual_import"
    });
    await codex.notifications.notification![0]!({
      method: "turn/completed",
      params: {
        threadId: binding.codexThreadId,
        turn: {
          id: "turn_text_fallback_result",
          status: "completed",
          items: []
        }
      }
    });
    const result = findTaskReportOutbox(repo.listDueOutbox(10));
    assert.ok(result);
    assert.equal(Array.isArray(result.payload.cards), true);
    assert.equal(JSON.stringify(result.payload.cards).includes("最终结论补充"), true);
    assert.equal("text" in result.payload, true);
    assert.equal(String(result.payload.text).includes("第1200条建议"), true);
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

test("new task action without project shows project selection", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    repo.upsertProject({ id: "proj_console_new_task", name: "Console project", rootPath: dir });
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
    assert.equal(JSON.stringify(feishu.sent[0]?.payload ?? {}).includes("选择项目"), true);
    assert.equal(feishu.createdChats.length, 0);
    assert.equal(repo.listBindings().length, 0);
  } finally {
    cleanup();
  }
});

test("project new task action creates a draft dedicated task chat", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    const project = repo.upsertProject({ id: "proj_project_new_task", name: "Project task", rootPath: dir });
    await service.handleCardAction({
      actionId: "act_project_new_task",
      action: "new_task",
      userId: "user_1",
      chatId: "chat_1",
      rootMessageId: "root_project",
      payload: { projectId: project.id }
    });
    assert.equal(feishu.createdChats.length, 1);
    assert.equal(feishu.sent.length, 1);
    assert.equal(feishu.sent[0]?.type, "text");
    assert.equal(feishu.sent[0]?.chatId, "task_chat_1");
    assert.equal(String(feishu.sent[0]?.payload).includes("请直接发送"), true);
    const draft = repo.listBindings().find((binding) => binding.status === "waiting_for_prompt");
    assert.ok(draft);
    assert.equal(draft.projectId, project.id);
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

test("claiming an already bound dedicated task does not send task content back to control chat", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    repo.createOrUpdateBinding({
      codexThreadId: "thr_bound_existing",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root",
      feishuContainerKind: "dedicated_chat",
      feishuControlChatId: "chat_1",
      title: "Bound existing task",
      status: "running",
      createdFrom: "manual_import"
    });
    const result = await service.handleCardAction({
      actionId: "act_claim_existing",
      action: "claim_thread",
      userId: "user_1",
      chatId: "chat_1",
      rootMessageId: "root_existing",
      payload: { codexThreadId: "thr_bound_existing" }
    });
    assert.equal(String(result.text).includes("主控群"), true);
    assert.equal(feishu.sent.filter((entry) => entry.type === "card").length, 0);
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

test("claim summary for an already bound dedicated task stays as a control-group hint", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    repo.createOrUpdateBinding({
      codexThreadId: "thr_bound_summary",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root",
      feishuContainerKind: "dedicated_chat",
      feishuControlChatId: "chat_1",
      title: "Bound summary task",
      status: "completed",
      createdFrom: "manual_import"
    });
    await service.handleMessage({
      messageId: "msg_claim_summary_bound",
      chatId: "chat_1",
      rootMessageId: "root_claim_summary_bound",
      threadId: null,
      userId: "user_1",
      text: "/claim summary thr_bound_summary"
    });
    assert.equal(
      feishu.sent.some((entry) => entry.type === "text" && String(entry.payload).includes("主控群不再展示子会话内容")),
      true
    );
    assert.equal(feishu.sent.some((entry) => String(entry.payload).includes("任务摘要：")), false);
  } finally {
    cleanup();
  }
});

test("codex-only completed thread enqueues one control chat reminder", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    config.feishu.interactionMode = "hybrid";
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const completedAt = Date.now();
    codex.threads = [
      {
        id: "thr_codex_only_done",
        name: "Codex App only task",
        preview: "Codex App only task",
        cwd: dir,
        status: { type: "idle" },
        updatedAt: completedAt
      }
    ];
    (codex as unknown as { readThread: (threadId: string) => Promise<Record<string, unknown>> }).readThread = async () => ({
      thread: {
        id: "thr_codex_only_done",
        name: "Codex App only task",
        preview: "Codex App only task",
        cwd: dir,
        status: { type: "idle" },
        updatedAt: completedAt,
        turns: [
          {
            id: "turn_codex_only_done",
            status: "completed",
            completedAt,
            items: [
              { type: "reasoning", summary: [{ text: "完成了需求拆解和验证。" }] },
              { type: "agentMessage", text: "最终结论：这个任务已经处理完成。" }
            ]
          }
        ]
      }
    });
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    assert.equal(await service.scanCodexOnlyCompletions(), 1);
    assert.equal(await service.scanCodexOnlyCompletions(), 0);
    const outbox = repo.listDueOutbox(10).filter((item) => item.dedupeKey.startsWith("codex-only:"));
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0]?.notificationType, "task_completed");
    assert.equal(outbox[0]?.feishuChatId, "chat_1");
    const payload = JSON.stringify(outbox[0]?.payload.card ?? {});
    assert.equal(payload.includes("Codex App 任务已完成"), true);
    assert.equal(payload.includes("最终结论：这个任务已经处理完成。"), true);
    assert.equal(collectButtons(outbox[0]?.payload.card).some((button) => buttonAction(button) === "claim_thread"), true);
  } finally {
    cleanup();
  }
});

test("codex-only completion scan skips bound, ignored and stale threads", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const now = Date.now();
    const stale = now - config.bridge.codexOnlyCompletionLookbackMs - 1000;
    codex.threads = [
      { id: "thr_bound_done", name: "Bound done", preview: "Bound done", cwd: dir, status: { type: "idle" }, updatedAt: now },
      { id: "thr_ignored_done", name: "Ignored done", preview: "Ignored done", cwd: dir, status: { type: "idle" }, updatedAt: now },
      { id: "thr_stale_done", name: "Stale done", preview: "Stale done", cwd: dir, status: { type: "idle" }, updatedAt: stale }
    ];
    (codex as unknown as { readThread: (threadId: string) => Promise<Record<string, unknown>> }).readThread = async (threadId: string) => ({
      thread: {
        id: threadId,
        name: threadId,
        cwd: dir,
        status: { type: "idle" },
        updatedAt: threadId === "thr_stale_done" ? stale : now,
        turns: [{ id: `turn_${threadId}`, status: "completed", completedAt: threadId === "thr_stale_done" ? stale : now }]
      }
    });
    repo.createOrUpdateBinding({
      codexThreadId: "thr_bound_done",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root",
      feishuContainerKind: "dedicated_chat",
      title: "Bound done",
      status: "completed",
      createdFrom: "manual_import"
    });
    repo.ignoreThread({ codexThreadId: "thr_ignored_done", title: "Ignored done", createdByFeishuUserId: "user_1" });
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    assert.equal(await service.scanCodexOnlyCompletions(), 0);
    assert.equal(repo.listDueOutbox(10).filter((item) => item.dedupeKey.startsWith("codex-only:")).length, 0);
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

test("runtime bootstrap auto imports Codex App workspace roots", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const firstWorkspace = join(dir, "workspace-one");
    const secondWorkspace = join(dir, "workspace-two");
    mkdirSync(firstWorkspace, { recursive: true });
    mkdirSync(secondWorkspace, { recursive: true });
    const appStatePath = join(dir, "codex-state.json");
    writeFileSync(
      appStatePath,
      JSON.stringify({
        "project-order": [secondWorkspace],
        "electron-saved-workspace-roots": [secondWorkspace],
        "electron-persisted-atom-state": {
          "project-order": [firstWorkspace],
          "electron-saved-workspace-roots": [firstWorkspace, secondWorkspace],
          "active-workspace-roots": [secondWorkspace]
        }
      }),
      "utf8"
    );
    const config = makeConfig(dir);
    config.feishu.interactionMode = "hybrid";
    config.codex.appStatePath = appStatePath;
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    await service.bootstrapRuntimeState();
    const projects = repo.listProjects();
    assert.equal(projects.length, 2);
    assert.equal(projects.some((project) => project.rootPath === firstWorkspace), true);
    assert.equal(projects.some((project) => project.rootPath === secondWorkspace), true);
    assert.equal(repo.findProjectForContext({ cwd: join(firstWorkspace, "src") })?.rootPath, firstWorkspace);
    assert.equal(repo.findProjectForContext({ cwd: join(secondWorkspace, "src") })?.rootPath, secondWorkspace);
  } finally {
    cleanup();
  }
});

test("project list auto syncs Codex App workspace roots before rendering", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const workspace = join(dir, "workspace-list");
    mkdirSync(workspace, { recursive: true });
    const appStatePath = join(dir, "codex-state-list.json");
    writeFileSync(
      appStatePath,
      JSON.stringify({
        "electron-persisted-atom-state": {
          "project-order": [workspace]
        }
      }),
      "utf8"
    );
    const config = makeConfig(dir);
    config.feishu.interactionMode = "hybrid";
    config.codex.appStatePath = appStatePath;
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    await service.handleCardAction({
      actionId: "act_project_list_auto_sync",
      action: "project_list",
      userId: "user_1",
      chatId: "chat_1",
      rootMessageId: "root_project_list_auto_sync",
      payload: {}
    });
    assert.equal(repo.listProjects().length, 1);
    const payload = JSON.stringify(feishu.sent.find((entry) => entry.type === "card")?.payload ?? {});
    assert.equal(payload.includes("workspace-list"), true);
    assert.equal(collectButtons(feishu.sent.find((entry) => entry.type === "card")?.payload).some((button) => buttonAction(button) === "project_open"), true);
    assert.equal(payload.includes("运行中 0"), false);
  } finally {
    cleanup();
  }
});

test("project navigation opens details and filters task lists by project", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    config.feishu.interactionMode = "hybrid";
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    const first = repo.upsertProject({ id: "proj_nav_1", name: "One", rootPath: join(dir, "one") });
    const second = repo.upsertProject({ id: "proj_nav_2", name: "Two", rootPath: join(dir, "two") });
    repo.createOrUpdateBinding({
      projectId: first.id,
      codexThreadId: "thr_one",
      feishuChatId: "chat_1",
      feishuTopicRootMessageId: "root_one",
      title: "Task in One",
      cwd: first.rootPath,
      status: "completed",
      createdFrom: "manual_import"
    });
    repo.createOrUpdateBinding({
      projectId: second.id,
      codexThreadId: "thr_two",
      feishuChatId: "chat_1",
      feishuTopicRootMessageId: "root_two",
      title: "Task in Two",
      cwd: second.rootPath,
      status: "completed",
      createdFrom: "manual_import"
    });
    await service.handleCardAction({
      actionId: "act_project_open_nav",
      action: "project_open",
      userId: "user_1",
      chatId: "chat_1",
      rootMessageId: "root_project_open_nav",
      payload: { projectId: first.id }
    });
    const opened = JSON.stringify(feishu.sent[0]?.payload ?? {});
    assert.equal(opened.includes("One"), true);
    assert.equal(opened.includes("运行中"), true);
    assert.equal(collectButtons(feishu.sent[0]?.payload).some((button) => buttonAction(button) === "project_tasks"), true);

    await service.handleCardAction({
      actionId: "act_project_tasks_nav",
      action: "project_tasks",
      userId: "user_1",
      chatId: "chat_1",
      rootMessageId: "root_project_tasks_nav",
      payload: { projectId: first.id }
    });
    const list = JSON.stringify(feishu.sent[1]?.payload ?? {});
    assert.equal(list.includes("Task in One"), true);
    assert.equal(list.includes("Task in Two"), false);
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
    repo.createWorkspaceCheckpoint({
      sessionBindingId: binding.id,
      codexThreadId: binding.codexThreadId,
      turnId: "turn_buttons",
      workspaceRoot: dir,
      checkpointRef: "start",
      snapshotNote: "before",
      kind: "turn_start",
      manifest: {
        version: 1,
        root: dir,
        capturedAt: new Date().toISOString(),
        files: [],
        truncated: false,
        limits: { maxFiles: 10, maxFileBytes: 10, maxSampleBytes: 10 },
        skipped: { directories: [], files: [] }
      }
    });
    repo.createWorkspaceCheckpoint({
      sessionBindingId: binding.id,
      codexThreadId: binding.codexThreadId,
      turnId: "turn_buttons",
      workspaceRoot: dir,
      checkpointRef: "end",
      snapshotNote: "after",
      kind: "turn_end",
      manifest: {
        version: 1,
        root: dir,
        capturedAt: new Date().toISOString(),
        files: [{ path: "src/index.ts", size: 1, mtimeMs: 1, sha256: "hash", sample: "x" }],
        truncated: false,
        limits: { maxFiles: 10, maxFileBytes: 10, maxSampleBytes: 10 },
        skipped: { directories: [], files: [] }
      }
    });
    for (const [index, action] of [
      "task_status",
      "task_logs",
      "task_detail",
      "task_impact",
      "task_restore_confirm",
      "task_search",
      "notification_history",
      "send_test_notification",
      "diagnostic_recover"
    ].entries()) {
      await service.handleCardAction({
        actionId: `act_button_${index}`,
        action,
        userId: "user_1",
        chatId: "chat_1",
        rootMessageId: "root_buttons",
        payload: { bindingId: binding.id, query: "Button" }
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

test("task status card renders summary and command hint as separate blocks", () => {
  const card = new CardRenderer("hybrid").taskStatusCard({
    bindingId: "bind_card_layout",
    title: "Layout task",
    projectName: "Playground",
    status: "running",
    cwd: null,
    selectedModel: "gpt-5.4",
    selectedReasoningEffort: "xhigh",
    subAgents: [],
    queuedMessages: 1,
    pendingApprovals: 0,
    lastTurnId: "turn_layout",
    lastSummary: "这里是当前阶段的简要结论。",
    updatedAt: new Date().toISOString()
  });
  const content = JSON.stringify(card);
  assert.equal(content.includes("当前结论"), true);
  assert.equal(content.includes("操作提示"), true);
  assert.equal(content.includes("这里是当前阶段的简要结论。"), true);
  assert.equal(content.includes("gpt-5.4"), true);
  assert.equal(content.includes("xhigh"), true);
});

test("task status card renders subagent model and reasoning", () => {
  const card = new CardRenderer("hybrid").taskStatusCard({
    bindingId: "bind_subagent_card",
    title: "Subagent task",
    projectName: "Playground",
    status: "running",
    cwd: null,
    selectedModel: "gpt-5.5",
    selectedReasoningEffort: "xhigh",
    subAgents: [
      {
        threadId: "thr_child_1",
        nickname: "worker-a",
        role: "worker",
        tool: "spawnAgent",
        status: "running",
        model: "gpt-5.4",
        reasoningEffort: "high",
        message: "正在实现模块",
        updatedAt: null
      }
    ],
    queuedMessages: 0,
    pendingApprovals: 0,
    lastTurnId: "turn_subagent",
    lastSummary: null,
    updatedAt: new Date().toISOString()
  });
  const content = JSON.stringify(card);
  assert.equal(content.includes("子 Agent"), true);
  assert.equal(content.includes("worker-a"), true);
  assert.equal(content.includes("gpt-5.4"), true);
  assert.equal(content.includes("high"), true);
});

test("collab agent events are projected into Feishu task status", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_parent_subagent",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root",
      feishuTaskCardMessageId: "msg_status_card",
      feishuContainerKind: "dedicated_chat",
      title: "Subagent projection",
      status: "running",
      createdFrom: "manual_import"
    });
    await codex.notifications.notification![0]!({
      method: "item/completed",
      params: {
        threadId: binding.codexThreadId,
        turnId: "turn_subagent",
        item: {
          type: "collabAgentToolCall",
          id: "item_spawn",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: binding.codexThreadId,
          receiverThreadIds: ["thr_child_subagent"],
          prompt: "实现模块",
          model: "gpt-5.5",
          reasoningEffort: "xhigh",
          agentsStates: {
            thr_child_subagent: { status: "running", message: "正在检查代码" }
          }
        }
      }
    });
    const latest = JSON.stringify(feishu.updatedCards[feishu.updatedCards.length - 1]?.card ?? {});
    assert.equal(repo.listEventsForBinding(binding.id).some((event) => event.eventType === "codex.subagent"), true);
    assert.equal(latest.includes("子 Agent"), true);
    assert.equal(latest.includes("gpt-5.5"), true);
    assert.equal(latest.includes("xhigh"), true);
  } finally {
    cleanup();
  }
});

test("console card uses compact mobile-safe button labels", () => {
  const card = new CardRenderer("hybrid").consoleCard({ running: 1, approvals: 2, queued: 3, completedToday: 4 });
  const buttons = collectButtons(card);
  const labels = buttons.map((button) => String((button.text as Record<string, unknown>)?.content ?? ""));
  assert.equal(labels.includes("项目"), true);
  assert.equal(labels.includes("新任务"), false);
  assert.equal(labels.includes("最近任务"), true);
  assert.equal(labels.includes("运行中"), true);
  assert.equal(labels.includes("已完成"), true);
  assert.equal(labels.includes("归档"), true);
  assert.equal(labels.includes("接管电脑任务"), false);
});

test("task settings card shows model and reasoning options", () => {
  const card = new CardRenderer("hybrid").taskSettingsCard({
    bindingId: "bind_setting",
    title: "Setting task",
    projectName: "Playground",
    currentModel: "gpt-5.4",
    currentReasoningEffort: "xhigh",
    currentNotificationLevel: "important",
    modelOptions: ["gpt-5.4", "gpt-5.5"],
    reasoningOptions: ["medium", "high", "xhigh"]
  });
  const content = JSON.stringify(card);
  assert.equal(content.includes("当前模型"), true);
  assert.equal(content.includes("当前思考"), true);
  assert.equal(content.includes("通知级别"), true);
  assert.equal(content.includes("5.5"), true);
  assert.equal(content.includes("极高"), true);
});

test("task report card renders highlights and next steps blocks", () => {
  const card = new CardRenderer("hybrid").taskReportCard({
    title: "Report task",
    status: "completed",
    projectName: "Playground",
    reasoningSummary: "先确认范围，再整理结论。",
    finalResult: "建议先上线主流程。后续可以再优化移动端显示和归档流程。",
    highlights: ["主流程已完成", "移动端仍可继续优化"],
    changeItems: ["已完成主流程实现"],
    verificationItems: ["已完成基础验证"],
    nextSteps: ["继续优化移动端显示", "补强归档流程体验"],
    subAgents: [],
    finalResultTruncated: false,
    updatedAt: new Date().toISOString()
  });
  const content = JSON.stringify(card);
  assert.equal(content.includes("关键信息"), true);
  assert.equal(content.includes("本次改动"), true);
  assert.equal(content.includes("验证情况"), true);
  assert.equal(content.includes("建议后续"), true);
  assert.equal(content.includes("主流程已完成"), true);
  assert.equal(content.includes("补强归档流程体验"), true);
});

test("task report card preserves markdown structure in final result", () => {
  const finalResult = [
    "## 推荐结论",
    "",
    "建议优先选择下面两项：",
    "",
    "1. 米家 501：适合预算敏感场景。",
    "2. 米家 636：适合更看重容量和体验的场景。",
    "",
    "| 机型 | 价格 | 结论 |",
    "| --- | --- | --- |",
    "| 米家 501 | 1799 | 优先推荐 |",
    "| 米家 636 | 2299 | 备选升级 |",
    "",
    "### 下一步",
    "",
    "- 确认摆放尺寸",
    "- 对比售后政策"
  ].join("\n");
  const card = new CardRenderer("hybrid").taskReportCard({
    title: "Markdown report",
    status: "completed",
    projectName: "Playground",
    reasoningSummary: "已完成对比。",
    finalResult,
    subAgents: [],
    finalResultTruncated: false,
    updatedAt: new Date().toISOString()
  });
  const content = JSON.stringify(card);
  assert.equal(content.includes("## 推荐结论"), true);
  assert.equal(content.includes("\\n\\n建议优先选择下面两项"), true);
  assert.equal(content.includes("1. 米家 501"), true);
  assert.equal(content.includes("| 机型 | 价格 | 结论 |"), true);
  assert.equal(content.includes("- 确认摆放尺寸"), true);
});

test("task report supplement cards carry overflow markdown before text fallback", () => {
  const finalResult = Array.from({ length: 180 }, (_, index) => `${index + 1}. 第${index + 1}条结构化结论：继续保持卡片排版。`).join("\n");
  const renderer = new CardRenderer("hybrid");
  const projection = {
    title: "Supplement report",
    status: "completed" as const,
    projectName: "Playground",
    reasoningSummary: "已完成整理。",
    finalResult: finalResult.slice(0, 8600),
    fullFinalResult: finalResult,
    subAgents: [],
    finalResultTruncated: true,
    updatedAt: new Date().toISOString()
  };
  const card = renderer.taskReportCard(projection);
  const supplements = renderer.taskReportSupplementCards(projection);
  assert.equal(JSON.stringify(card).includes("最终结论较长，系统会继续补充卡片。"), true);
  assert.equal(supplements.length > 0, true);
  assert.equal(JSON.stringify(supplements).includes("最终结论补充"), true);
  assert.equal(JSON.stringify(supplements).includes("第180条结构化结论"), true);
  assert.equal(renderer.shouldSendTaskReportFullText(projection), false);
});

test("completed notification preserves markdown final result from Codex thread", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const markdownFinal = [
      "## 最终结论",
      "",
      "这次建议按下面顺序处理：",
      "",
      "1. 先修复飞书卡片排版。",
      "2. 再验证长结论是否需要补发完整文本。",
      "",
      "| 项目 | 状态 |",
      "| --- | --- |",
      "| Markdown 保留 | 已完成 |",
      "| 表格展示 | 已完成 |",
      "",
      "### 验证",
      "",
      "- npm run check"
    ].join("\n");
    const codex = new MockCodex();
    codex.threads = [
      {
        id: "thr_markdown_report",
        name: "Markdown report",
        preview: "Markdown report",
        cwd: dir,
        status: { type: "idle" },
        turns: [
          {
            id: "turn_markdown_report",
            status: "completed",
            items: [
              { type: "reasoning", summary: ["读取 Codex 输出并保留结构化结论。"], content: [] },
              { type: "agentMessage", text: markdownFinal }
            ]
          }
        ],
        updatedAt: Date.now()
      }
    ];
    const service = new TaskService(config, repo, codex as any, new MockFeishu(), makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_markdown_report",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root",
      feishuContainerKind: "dedicated_chat",
      title: "Markdown report",
      status: "running",
      createdFrom: "manual_import"
    });
    await codex.notifications.notification![0]!({
      method: "turn/completed",
      params: {
        threadId: binding.codexThreadId,
        turn: {
          id: "turn_markdown_report",
          status: "completed",
          items: []
        }
      }
    });
    const result = findTaskReportOutbox(repo.listDueOutbox(10));
    assert.ok(result);
    const payload = JSON.stringify(result.payload.card);
    assert.equal(payload.includes("## 最终结论"), true);
    assert.equal(payload.includes("\\n\\n这次建议按下面顺序处理"), true);
    assert.equal(payload.includes("1. 先修复飞书卡片排版。"), true);
    assert.equal(payload.includes("| 项目 | 状态 |"), true);
    assert.equal(payload.includes("- npm run check"), true);
  } finally {
    cleanup();
  }
});

test("completed notification extracts subagent metadata from Codex thread", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const codex = new MockCodex();
    codex.threads = [
      {
        id: "thr_completed_subagent",
        name: "Completed subagent",
        preview: "Completed subagent",
        cwd: dir,
        status: { type: "idle" },
        turns: [
          {
            id: "turn_completed_subagent",
            status: "completed",
            items: [
              {
                type: "collabAgentToolCall",
                id: "item_spawn_completed",
                tool: "spawnAgent",
                status: "completed",
                senderThreadId: "thr_completed_subagent",
                receiverThreadIds: ["thr_child_completed"],
                prompt: "并行检查",
                model: "gpt-5.5",
                reasoningEffort: "xhigh",
                agentsStates: {
                  thr_child_completed: { status: "completed", message: "检查完成" }
                }
              },
              { type: "agentMessage", text: "已完成主任务。" }
            ]
          }
        ],
        updatedAt: Date.now()
      }
    ];
    const service = new TaskService(config, repo, codex as any, new MockFeishu(), makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_completed_subagent",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root",
      feishuContainerKind: "dedicated_chat",
      title: "Completed subagent",
      status: "running",
      createdFrom: "manual_import"
    });
    await codex.notifications.notification![0]!({
      method: "turn/completed",
      params: {
        threadId: binding.codexThreadId,
        turn: {
          id: "turn_completed_subagent",
          status: "completed",
          items: []
        }
      }
    });
    const result = findTaskReportOutbox(repo.listDueOutbox(10));
    assert.ok(result);
    const payload = JSON.stringify(result.payload.card);
    assert.equal(payload.includes("子 Agent"), true);
    assert.equal(payload.includes("gpt-5.5"), true);
    assert.equal(payload.includes("xhigh"), true);
    assert.equal(repo.listEventsForBinding(binding.id).some((event) => event.eventType === "codex.subagent"), true);
  } finally {
    cleanup();
  }
});

test("project card and settings card expose mobile-safe settings entry", () => {
  const projectCard = new CardRenderer("hybrid").projectCard({
    id: "proj_1",
    name: "Playground",
    rootPath: "C:\\repo",
    runningCount: 1,
    pendingApprovals: 2,
    completedCount: 3,
    defaultModel: "gpt-5.4",
    defaultReasoningEffort: "xhigh"
  });
  const labels = collectButtons(projectCard).map((button) => String((button.text as Record<string, unknown>)?.content ?? ""));
  assert.equal(labels.includes("设置"), true);
  assert.equal(labels.includes("对话"), true);
  assert.equal(labels.includes("运行中"), true);
  assert.equal(labels.includes("接管"), true);
  assert.equal(labels.includes("返回项目"), true);

  const settingsCard = new CardRenderer("hybrid").projectSettingsCard({
    projectId: "proj_1",
    projectName: "Playground",
    rootPath: "C:\\repo",
    currentModel: "gpt-5.4",
    currentReasoningEffort: "xhigh",
    currentNotificationLevel: "important",
    modelOptions: ["gpt-5.4", "gpt-5.5"],
    reasoningOptions: ["medium", "high", "xhigh"]
  });
  const content = JSON.stringify(settingsCard);
  assert.equal(content.includes("默认模型"), true);
  assert.equal(content.includes("默认思考"), true);
  assert.equal(content.includes("5.5"), true);
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

test("task settings actions update binding model and reasoning effort", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_setting_action",
      feishuChatId: "chat_1",
      feishuTopicRootMessageId: "root_setting_action",
      feishuThreadId: "omt_setting_action",
      title: "Setting action task",
      cwd: dir,
      selectedModel: "gpt-5.4",
      selectedReasoningEffort: "xhigh",
      status: "idle",
      createdFrom: "manual_import"
    });
    await service.handleCardAction({
      actionId: "act_setting_model",
      action: "task_setting_model",
      userId: "user_1",
      chatId: "chat_1",
      rootMessageId: "root_setting_action",
      payload: { bindingId: binding.id, model: "gpt-5.5" }
    });
    await service.handleCardAction({
      actionId: "act_setting_reasoning",
      action: "task_setting_reasoning",
      userId: "user_1",
      chatId: "chat_1",
      rootMessageId: "root_setting_action",
      payload: { bindingId: binding.id, reasoningEffort: "high" }
    });
    const updated = repo.findBindingById(binding.id);
    assert.equal(updated?.selectedModel, "gpt-5.5");
    assert.equal(updated?.selectedReasoningEffort, "high");
  } finally {
    cleanup();
  }
});

test("project settings actions update project defaults", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    const project = repo.upsertProject({
      id: "proj_setting_action",
      name: "Playground",
      rootPath: dir,
      defaultModel: "gpt-5.4",
      defaultReasoningEffort: "xhigh"
    });
    await service.handleCardAction({
      actionId: "act_project_setting_model",
      action: "project_setting_model",
      userId: "user_1",
      chatId: "chat_1",
      rootMessageId: "root_project_setting",
      payload: { projectId: project.id, model: "gpt-5.5" }
    });
    await service.handleCardAction({
      actionId: "act_project_setting_reasoning",
      action: "project_setting_reasoning",
      userId: "user_1",
      chatId: "chat_1",
      rootMessageId: "root_project_setting",
      payload: { projectId: project.id, reasoningEffort: "high" }
    });
    const updated = repo.getProject(project.id);
    assert.equal(updated?.defaultModel, "gpt-5.5");
    assert.equal(updated?.defaultReasoningEffort, "high");
  } finally {
    cleanup();
  }
});

test("project notification level action updates project notification policy", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    const project = repo.upsertProject({
      id: "proj_notify_setting",
      name: "Playground",
      rootPath: dir,
      notificationPolicy: "important"
    });
    await service.handleCardAction({
      actionId: "act_project_notification_level",
      action: "project_notification_level",
      userId: "user_1",
      chatId: "chat_1",
      rootMessageId: "root_project_notify_setting",
      payload: { projectId: project.id, level: "errors" }
    });
    assert.equal(repo.getProject(project.id)?.notificationPolicy, "errors");
  } finally {
    cleanup();
  }
});

test("global notification settings card is available from main console actions", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    await service.handleCardAction({
      actionId: "act_notification_settings_global",
      action: "notification_settings_global",
      userId: "user_1",
      chatId: "chat_1",
      rootMessageId: "root_notification_settings",
      payload: {}
    });
    assert.equal(feishu.sent.length, 1);
    assert.equal(JSON.stringify(feishu.sent[0]?.payload ?? {}).includes("通知设置"), true);
    assert.equal(JSON.stringify(feishu.sent[0]?.payload ?? {}).includes("当前级别"), true);
  } finally {
    cleanup();
  }
});

test("archived task center lists archived tasks from main console", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_archived_task",
      feishuChatId: "chat_1",
      feishuTopicRootMessageId: "root_archived_task",
      feishuThreadId: "omt_archived_task",
      title: "Archived task",
      cwd: dir,
      status: "archived",
      createdFrom: "manual_import"
    });
    await service.handleCardAction({
      actionId: "act_archived_list",
      action: "task_list_archived",
      userId: "user_1",
      chatId: "chat_1",
      rootMessageId: "root_archived_task",
      payload: {}
    });
    assert.equal(feishu.sent.length, 1);
    assert.equal(JSON.stringify(feishu.sent[0]?.payload ?? {}).includes("归档任务"), true);
    assert.equal(JSON.stringify(feishu.sent[0]?.payload ?? {}).includes("Archived task"), true);
    assert.equal(JSON.stringify(feishu.sent[0]?.payload ?? {}).includes(binding.id), false);
  } finally {
    cleanup();
  }
});

test("archived task center can restore an archived task", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_archived_restore",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root-restore",
      feishuContainerKind: "dedicated_chat",
      title: "Archived restore",
      cwd: dir,
      status: "archived",
      createdFrom: "manual_import"
    });
    await service.handleCardAction({
      actionId: "act_task_unarchive",
      action: "task_unarchive",
      userId: "user_1",
      chatId: "chat_1",
      rootMessageId: "root_archived_restore",
      payload: { bindingId: binding.id }
    });
    assert.deepEqual(codex.unarchived, ["thr_archived_restore"]);
    assert.equal(repo.findBindingById(binding.id)?.status, "idle");
    assert.equal(repo.listEventsForBinding(binding.id).some((event) => event.eventType === "task.unarchived"), true);
  } finally {
    cleanup();
  }
});

test("continuing a task uses task-level selected model and reasoning effort", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    repo.createOrUpdateBinding({
      codexThreadId: "thr_binding_setting",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root-setting",
      feishuContainerKind: "dedicated_chat",
      feishuControlChatId: "chat_1",
      title: "Bound setting task",
      cwd: dir,
      selectedModel: "gpt-5.5",
      selectedReasoningEffort: "high",
      status: "idle",
      createdFrom: "manual_import"
    });
    await service.handleMessage({
      messageId: "msg_setting_continue",
      chatId: "task_chat_1",
      rootMessageId: "task-root-setting",
      threadId: null,
      userId: "user_1",
      text: "继续处理"
    });
    assert.equal(codex.startedTurns.length, 1);
    assert.equal(codex.startedTurns[0]?.model, "gpt-5.5");
    assert.equal(codex.startedTurns[0]?.reasoningEffort, "high");
  } finally {
    cleanup();
  }
});

test("starting a new turn clears old progress card state", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const codex = new MockCodex();
    const service = new TaskService(config, repo, codex as any, feishu, makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_progress_reset",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root-progress-reset",
      feishuContainerKind: "dedicated_chat",
      feishuControlChatId: "chat_1",
      title: "Progress reset task",
      cwd: dir,
      status: "idle",
      createdFrom: "manual_import"
    });
    await codex.notifications.notification![0]!(
      {
        method: "item/plan/delta",
        params: {
          threadId: binding.codexThreadId,
          turnId: "turn_old",
          itemId: "plan_old",
          delta: "旧的一轮进度。"
        }
      }
    );
    assert.equal(feishu.sent.filter((entry) => entry.type === "card" && entry.chatId === "task_chat_1").length, 1);
    await service.handleMessage({
      messageId: "msg_progress_reset",
      chatId: "task_chat_1",
      rootMessageId: "task-root-progress-reset",
      threadId: null,
      userId: "user_1",
      text: "继续处理下一轮"
    });
    await codex.notifications.notification![0]!(
      {
        method: "item/reasoning/summaryTextDelta",
        params: {
          threadId: binding.codexThreadId,
          turnId: "turn_1",
          itemId: "reasoning_new",
          delta: "这是新一轮的处理摘要。"
        }
      }
    );
    const latest = JSON.stringify(feishu.updatedCards[feishu.updatedCards.length - 1]?.card ?? {});
    assert.equal(latest.includes("这是新一轮的处理摘要。"), true);
    assert.equal(latest.includes("旧的一轮进度。"), false);
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

const findTaskReportOutbox = (items: Array<{ notificationType: string; payload: Record<string, unknown> }>) =>
  items.find((item) => {
    const content = JSON.stringify(item.payload.card ?? {});
    return item.notificationType === "task_completed" && content.includes("处理完成") && content.includes("最终结论");
  });

const buttonAction = (button: Record<string, unknown>): string | null => {
  const behaviors = Array.isArray(button.behaviors) ? button.behaviors : [];
  const first = behaviors[0] && typeof behaviors[0] === "object" ? behaviors[0] as Record<string, unknown> : {};
  const value = first.value && typeof first.value === "object" ? first.value as Record<string, unknown> : {};
  return typeof value.action === "string" ? value.action : null;
};
