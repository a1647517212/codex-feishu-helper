import test from "node:test";
import assert from "node:assert/strict";
import { SecurityPolicy } from "../src/domain/security.js";
import { makeConfig, makeTempRepo } from "./helpers.js";

test("repository persists bindings and keeps action requests idempotent", () => {
  const { repo, cleanup } = makeTempRepo();
  try {
    const project = repo.upsertProject({ name: "Repo", rootPath: "C:\\repo" });
    const binding = repo.createOrUpdateBinding({
      projectId: project.id,
      codexThreadId: "thr_1",
      feishuChatId: "chat_1",
      feishuTopicRootMessageId: "msg_root",
      title: "Fix bug",
      cwd: "C:\\repo",
      status: "idle",
      createdFrom: "codex_app_claimed",
      createdByFeishuUserId: "user_1"
    });
    assert.equal(repo.findBindingByTopic("chat_1", "msg_root")?.id, binding.id);
    const first = repo.beginAction({
      actionId: "act_1",
      actionType: "task_continue",
      payload: { bindingId: binding.id },
      requestedByFeishuUserId: "user_1"
    });
    const second = repo.beginAction({
      actionId: "act_1",
      actionType: "task_continue",
      payload: { bindingId: binding.id },
      requestedByFeishuUserId: "user_1"
    });
    assert.equal(first.existing, null);
    assert.equal(second.existing?.actionId, "act_1");
  } finally {
    cleanup();
  }
});

test("event seq is monotonic for projection recovery", () => {
  const { repo, cleanup } = makeTempRepo();
  try {
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_1",
      feishuChatId: "chat_1",
      feishuTopicRootMessageId: "msg_root",
      createdFrom: "manual_import"
    });
    const a = repo.insertEvent({
      sessionBindingId: binding.id,
      codexThreadId: binding.codexThreadId,
      eventType: "turn.started"
    });
    const b = repo.insertEvent({
      sessionBindingId: binding.id,
      codexThreadId: binding.codexThreadId,
      eventType: "task.completed"
    });
    assert.equal(b.seq, a.seq + 1);
  } finally {
    cleanup();
  }
});

test("repository deduplicates repeated Feishu message deliveries", () => {
  const { repo, cleanup } = makeTempRepo();
  try {
    const first = repo.beginIncomingMessage({
      messageId: "om_1",
      chatId: "chat_1",
      userId: "user_1",
      text: "/codex"
    });
    const second = repo.beginIncomingMessage({
      messageId: "om_1",
      chatId: "chat_1",
      userId: "user_1",
      text: "/codex"
    });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.deliveries, 2);
    assert.equal(repo.count("incoming_messages"), 1);
  } finally {
    cleanup();
  }
});

test("notification outbox deduplicates completed turn notifications", () => {
  const { repo, cleanup } = makeTempRepo();
  try {
    repo.enqueueOutbox({
      notificationType: "task_completed",
      feishuChatId: "chat_1",
      payload: { text: "done" },
      dedupeKey: "turn:thr_1:turn_1:completed"
    });
    repo.enqueueOutbox({
      notificationType: "task_completed",
      feishuChatId: "chat_1",
      payload: { text: "done duplicated" },
      dedupeKey: "turn:thr_1:turn_1:completed"
    });
    assert.equal(repo.listDueOutbox(10).length, 1);
  } finally {
    cleanup();
  }
});

test("security policy blocks path escape and secret files", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const security = new SecurityPolicy(makeConfig(dir));
    assert.throws(() => security.resolveInsideProject(dir, "..\\outside.txt"), /escapes project root/);
    assert.throws(() => security.resolveInsideProject(dir, ".env"), /secret-file policy/);
  } finally {
    cleanup();
  }
});
