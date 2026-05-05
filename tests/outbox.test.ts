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
