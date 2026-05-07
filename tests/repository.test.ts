import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SecurityPolicy } from "../src/domain/security.js";
import { captureWorkspaceManifest, restoreWorkspaceFromCheckpoints } from "../src/domain/checkpoints.js";
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
      feishuThreadId: "omt_1",
      title: "Fix bug",
      cwd: "C:\\repo",
      status: "idle",
      createdFrom: "codex_app_claimed",
      createdByFeishuUserId: "user_1"
    });
    assert.equal(repo.findBindingByTopic("chat_1", "msg_root")?.id, binding.id);
    assert.equal(repo.findBindingByFeishuThreadId("chat_1", "omt_1")?.id, binding.id);
    const taskChat = repo.createOrUpdateBinding({
      codexThreadId: "thr_task_chat",
      feishuChatId: "task_chat_1",
      feishuTopicRootMessageId: "task-root",
      feishuContainerKind: "dedicated_chat",
      title: "Task chat",
      status: "idle",
      createdFrom: "manual_import"
    });
    assert.equal(repo.findBindingByChatId("task_chat_1")?.id, taskChat.id);
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

test("repository matches project path across Windows slash styles", () => {
  const { repo, cleanup } = makeTempRepo();
  try {
    const project = repo.upsertProject({ name: "Playground", rootPath: "C:/Users/EPEANZ/Documents/Playground/" });
    assert.equal(repo.findProjectForPath("C:\\Users\\EPEANZ\\Documents\\Playground")?.id, project.id);
    assert.equal(repo.findProjectForPath("C:\\Users\\EPEANZ\\Documents\\Playground\\src")?.id, project.id);
    assert.equal(
      repo.findProjectForContext({
        cwd: "C:\\Users\\EPEANZ\\Documents\\Playground\\src"
      })?.id,
      project.id
    );
  } finally {
    cleanup();
  }
});

test("repository stores notification preferences, trusted subjects, devices and thread ownership", () => {
  const { repo, cleanup } = makeTempRepo();
  try {
    const preference = repo.upsertNotificationPreference({
      scopeType: "global",
      scopeId: "bridge",
      level: "errors"
    });
    assert.equal(repo.getNotificationPreference("global", "bridge")?.level, "errors");
    assert.equal(preference.scopeType, "global");

    const device = repo.upsertBridgeDevice({
      id: "machine-a",
      machineName: "Machine A",
      codexHome: "C:\\Users\\EPEANZ\\.feishu-codex",
      status: "active"
    });
    assert.equal(repo.getBridgeDevice("machine-a")?.machineName, "Machine A");
    assert.equal(device.status, "active");

    const subject = repo.upsertTrustedFeishuSubject({
      chatId: "chat_1",
      userId: "user_1",
      role: "owner",
      status: "active"
    });
    assert.equal(repo.findTrustedFeishuSubject("chat_1", "user_1")?.id, subject.id);

    const owner = repo.upsertThreadOwnership({
      codexThreadId: "thr_1",
      ownerKind: "feishu_bridge",
      ownerClientId: "machine-a",
      confidence: "high"
    });
    assert.equal(repo.getThreadOwnership("thr_1")?.ownerKind, "feishu_bridge");
    assert.equal(owner.ownerClientId, "machine-a");
  } finally {
    cleanup();
  }
});

test("repository stores workspace checkpoints and searches bindings", () => {
  const { repo, cleanup } = makeTempRepo();
  try {
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_checkpoint",
      feishuChatId: "chat_1",
      feishuTopicRootMessageId: "root_checkpoint",
      title: "Searchable checkpoint task",
      cwd: "C:\\repo\\checkpoint",
      status: "completed",
      createdFrom: "manual_import"
    });
    const start = repo.createWorkspaceCheckpoint({
      sessionBindingId: binding.id,
      codexThreadId: binding.codexThreadId,
      turnId: null,
      workspaceRoot: "C:\\repo\\checkpoint",
      checkpointRef: "start",
      snapshotNote: "before",
      kind: "turn_start",
      manifest: { version: 1, files: [] }
    });
    repo.updateWorkspaceCheckpointTurnId(start.id, "turn_1");
    const end = repo.createWorkspaceCheckpoint({
      sessionBindingId: binding.id,
      codexThreadId: binding.codexThreadId,
      turnId: "turn_1",
      workspaceRoot: "C:\\repo\\checkpoint",
      checkpointRef: "end",
      snapshotNote: "after",
      kind: "turn_end",
      manifest: { version: 1, files: [{ path: "src/index.ts", size: 1, mtimeMs: 1, sha256: "a", sample: "x" }] }
    });
    const pair = repo.findWorkspaceCheckpointPair(binding.id, "turn_1");
    assert.equal(pair.start?.id, start.id);
    assert.equal(pair.end?.id, end.id);
    assert.equal(repo.count("workspace_checkpoints"), 2);
    assert.equal(repo.searchBindings("checkpoint")[0]?.id, binding.id);
  } finally {
    cleanup();
  }
});

test("workspace checkpoint restore reverts captured text changes only", () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const workspace = join(dir, "workspace");
    mkdirSync(join(workspace, "src"), { recursive: true });
    const file = join(workspace, "src", "index.ts");
    const added = join(workspace, "src", "new.ts");
    writeFileSync(file, "before", "utf8");
    const binding = repo.createOrUpdateBinding({
      codexThreadId: "thr_restore",
      feishuChatId: "chat_1",
      feishuTopicRootMessageId: "root_restore",
      title: "Restore task",
      cwd: workspace,
      status: "completed",
      createdFrom: "manual_import"
    });
    const start = repo.createWorkspaceCheckpoint({
      sessionBindingId: binding.id,
      codexThreadId: binding.codexThreadId,
      turnId: "turn_restore",
      workspaceRoot: workspace,
      checkpointRef: "start",
      kind: "turn_start",
      manifest: captureWorkspaceManifest(workspace)
    });
    writeFileSync(file, "after", "utf8");
    writeFileSync(added, "new", "utf8");
    const end = repo.createWorkspaceCheckpoint({
      sessionBindingId: binding.id,
      codexThreadId: binding.codexThreadId,
      turnId: "turn_restore",
      workspaceRoot: workspace,
      checkpointRef: "end",
      kind: "turn_end",
      manifest: captureWorkspaceManifest(workspace)
    });
    const result = restoreWorkspaceFromCheckpoints(start, end);
    assert.equal(readFileSync(file, "utf8"), "before");
    assert.equal(result.restored.includes("src/index.ts"), true);
    assert.equal(result.removedAdded.includes("src/new.ts"), true);
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

test("security policy allows trusted Feishu subjects outside static allowlists", () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    repo.upsertTrustedFeishuSubject({
      chatId: "trusted_chat",
      userId: "trusted_user",
      role: "owner",
      status: "active"
    });
    const config = makeConfig(dir);
    config.feishu.allowedChatIds = ["chat_1"];
    config.feishu.allowedUserIds = ["user_1"];
    const security = new SecurityPolicy(config, repo);
    security.assertFeishuAllowed("trusted_user", "trusted_chat");
  } finally {
    cleanup();
  }
});
