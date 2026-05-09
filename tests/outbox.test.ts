import test from "node:test";
import assert from "node:assert/strict";
import { OutboxWorker } from "../src/bridge/outbox.js";
import { makeConfig, makeLogger, makeTempRepo, MockFeishu } from "./helpers.js";

test("outbox retries after transient Feishu failure", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const worker = new OutboxWorker(config, repo, feishu, makeLogger(dir));
    feishu.failNext = true;
    const item = repo.enqueueOutbox({
      notificationType: "console",
      feishuChatId: "chat_1",
      payload: { text: "hello" },
      dedupeKey: "hello"
    });
    await worker.flush();
    assert.equal(repo.listDueOutbox(10).length, 0);
    repo.updateOutbox(item.id, "pending", 1, "retry", new Date(Date.now() - 1000).toISOString());
    await worker.flush();
    assert.equal(feishu.sent.length, 1);
  } finally {
    cleanup();
  }
});

test("outbox prefers replying inside Feishu thread when binding has thread id", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const worker = new OutboxWorker(config, repo, feishu, makeLogger(dir));
    repo.enqueueOutbox({
      notificationType: "console",
      feishuChatId: "chat_1",
      feishuTopicRootMessageId: "msg_root",
      feishuThreadId: "omt_1",
      payload: { text: "hello in thread" },
      dedupeKey: "threaded-hello"
    });
    await worker.flush();
    assert.equal(feishu.sent.length, 1);
    assert.equal(feishu.sent[0]?.mode, "thread");
    assert.equal(feishu.sent[0]?.root, "msg_root");
  } finally {
    cleanup();
  }
});

test("outbox sends dedicated task chat notifications as replies to the task card when available", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const worker = new OutboxWorker(config, repo, feishu, makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_dedicated_outbox",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root",
      feishuTaskCardMessageId: "om_task_card_1",
      feishuContainerKind: "dedicated_chat",
      title: "Dedicated outbox",
      status: "running",
      createdFrom: "manual_import"
    });
    repo.enqueueOutbox({
      sessionBindingId: binding.id,
      notificationType: "console",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root",
      payload: { text: "hello dedicated" },
      dedupeKey: "dedicated-hello"
    });
    await worker.flush();
    assert.equal(feishu.sent.length, 1);
    assert.equal(feishu.sent[0]?.mode, undefined);
    assert.equal(feishu.sent[0]?.chatId, "task_chat_1");
    assert.equal(feishu.sent[0]?.root, "om_task_card_1");
  } finally {
    cleanup();
  }
});

test("outbox keeps dedicated task chat notifications top-level until a real task card exists", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const worker = new OutboxWorker(config, repo, feishu, makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_dedicated_outbox_no_card",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root",
      feishuContainerKind: "dedicated_chat",
      title: "Dedicated outbox without card",
      status: "running",
      createdFrom: "manual_import"
    });
    repo.enqueueOutbox({
      sessionBindingId: binding.id,
      notificationType: "console",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root",
      payload: { text: "hello dedicated" },
      dedupeKey: "dedicated-hello-no-card"
    });
    await worker.flush();
    assert.equal(feishu.sent.length, 1);
    assert.equal(feishu.sent[0]?.chatId, "task_chat_1");
    assert.equal(feishu.sent[0]?.root, null);
  } finally {
    cleanup();
  }
});

test("outbox sends the main card before supplemental cards", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const worker = new OutboxWorker(config, repo, feishu, makeLogger(dir));
    repo.enqueueOutbox({
      notificationType: "task_completed",
      feishuChatId: "chat_1",
      payload: {
        card: { schema: "2.0", header: { title: { tag: "plain_text", content: "main" } }, body: { elements: [] } },
        cards: [
          { schema: "2.0", header: { title: { tag: "plain_text", content: "supplement" } }, body: { elements: [] } }
        ]
      },
      dedupeKey: "main-and-supplement"
    });
    await worker.flush();
    assert.equal(feishu.sent.length, 2);
    assert.equal(JSON.stringify(feishu.sent[0]?.payload).includes("main"), true);
    assert.equal(JSON.stringify(feishu.sent[1]?.payload).includes("supplement"), true);
  } finally {
    cleanup();
  }
});

test("outbox splits long text notifications instead of truncating them", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    config.bridge.maxFeishuTextLength = 1200;
    const feishu = new MockFeishu();
    const worker = new OutboxWorker(config, repo, feishu, makeLogger(dir));
    const longText = Array.from({ length: 90 }, (_, index) => `第${index + 1}条结论：这里是需要完整发送到飞书的最终结果内容。`).join("\n");
    repo.enqueueOutbox({
      notificationType: "task_completed",
      feishuChatId: "chat_1",
      payload: { text: longText },
      dedupeKey: "long-result"
    });
    await worker.flush();
    assert.equal(feishu.sent.length > 1, true);
    assert.equal(feishu.sent.every((entry) => String(entry.payload).length <= config.bridge.maxFeishuTextLength), true);
    assert.equal(feishu.sent.some((entry) => String(entry.payload).includes("第90条结论")), true);
  } finally {
    cleanup();
  }
});

test("outbox stores first task status card message id for later updates", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const worker = new OutboxWorker(config, repo, feishu, makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_status_card_bind",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root",
      feishuContainerKind: "dedicated_chat",
      title: "Status card bind",
      status: "running",
      createdFrom: "manual_import"
    });
    repo.enqueueOutbox({
      sessionBindingId: binding.id,
      notificationType: "task_status",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root",
      payload: { card: { schema: "2.0", header: { title: { tag: "plain_text", content: "test" } }, body: { elements: [] } } },
      dedupeKey: "task-status-bind"
    });
    await worker.flush();
    assert.equal(feishu.sent.length, 1);
    assert.equal(repo.findBindingById(binding.id)?.feishuTaskCardMessageId, "msg_1");
  } finally {
    cleanup();
  }
});

test("outbox respects muted global notification preference", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const worker = new OutboxWorker(config, repo, feishu, makeLogger(dir));
    repo.upsertNotificationPreference({
      scopeType: "global",
      scopeId: "bridge",
      level: "muted"
    });
    repo.enqueueOutbox({
      notificationType: "task_completed",
      feishuChatId: "chat_1",
      payload: { text: "done" },
      dedupeKey: "muted-complete"
    });
    await worker.flush();
    assert.equal(feishu.sent.length, 0);
  } finally {
    cleanup();
  }
});

test("outbox still delivers approval requests when notifications are muted", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const worker = new OutboxWorker(config, repo, feishu, makeLogger(dir));
    repo.upsertNotificationPreference({
      scopeType: "global",
      scopeId: "bridge",
      level: "muted"
    });
    repo.enqueueOutbox({
      notificationType: "approval_required",
      feishuChatId: "chat_1",
      payload: { text: "need approval" },
      dedupeKey: "muted-approval"
    });
    await worker.flush();
    assert.equal(feishu.sent.length, 1);
  } finally {
    cleanup();
  }
});

test("outbox sends only error notifications when level is errors", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const worker = new OutboxWorker(config, repo, feishu, makeLogger(dir));
    repo.upsertNotificationPreference({
      scopeType: "global",
      scopeId: "bridge",
      level: "errors"
    });
    repo.enqueueOutbox({
      notificationType: "task_completed",
      feishuChatId: "chat_1",
      payload: { text: "completed" },
      dedupeKey: "errors-complete"
    });
    repo.enqueueOutbox({
      notificationType: "task_failed",
      feishuChatId: "chat_1",
      payload: { text: "failed" },
      dedupeKey: "errors-failed"
    });
    await worker.flush();
    assert.equal(feishu.sent.length, 1);
    assert.equal(String(feishu.sent[0]?.payload), "failed");
  } finally {
    cleanup();
  }
});
