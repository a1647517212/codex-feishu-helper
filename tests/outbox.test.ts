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
