import test from "node:test";
import assert from "node:assert/strict";
import { makeTempRepo } from "./helpers.js";

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
