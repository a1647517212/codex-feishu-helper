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

test("outbox sends dedicated task chat notifications as normal chat messages", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const feishu = new MockFeishu();
    const worker = new OutboxWorker(config, repo, feishu, makeLogger(dir));
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_dedicated_outbox",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root",
      feishuThreadId: "omt_should_not_reply",
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
      feishuThreadId: "omt_should_not_reply",
      payload: { text: "hello dedicated" },
      dedupeKey: "dedicated-hello"
    });
    await worker.flush();
    assert.equal(feishu.sent.length, 1);
    assert.equal(feishu.sent[0]?.mode, undefined);
    assert.equal(feishu.sent[0]?.chatId, "task_chat_1");
    assert.equal(feishu.sent[0]?.root, null);
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
