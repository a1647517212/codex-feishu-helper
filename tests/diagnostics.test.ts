import test from "node:test";
import assert from "node:assert/strict";
import { DiagnosticsService } from "../src/bridge/diagnostics.js";
import { makeConfig, makeTempRepo, MockCodex } from "./helpers.js";

test("diagnostics distinguishes normal group chat from full topic-mode group", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    config.feishu.taskContainerMode = "topic";
    const diagnostics = new DiagnosticsService(config, repo, new MockCodex() as any, {
      async getChatInfo() {
        return {
          chatId: "chat_1",
          name: "Codex 控制群",
          chatMode: "group",
          groupMessageType: "chat",
          chatType: "private",
          chatStatus: "normal",
          external: false,
          raw: {}
        };
      }
    });
    const snapshot = await diagnostics.snapshot();
    assert.equal(snapshot.feishuDefaultChatDiagnostic?.ok, true);
    assert.equal(snapshot.feishuDefaultChatDiagnostic?.topicReplySupported, true);
    assert.equal(snapshot.feishuDefaultChatDiagnostic?.fullTopicMode, false);
    assert.match(snapshot.feishuDefaultChatDiagnostic?.recommendation ?? "", /reply_in_thread/);
    assert.match(snapshot.feishuDefaultChatDiagnostic?.recommendation ?? "", /group_message_type/);
  } finally {
    cleanup();
  }
});

test("diagnostics reports topic-mode group as full topic UX", async () => {
  const { repo, dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    config.feishu.taskContainerMode = "topic";
    const diagnostics = new DiagnosticsService(config, repo, new MockCodex() as any, {
      async getChatInfo() {
        return {
          chatId: "chat_1",
          name: "Codex 话题群",
          chatMode: "topic",
          groupMessageType: null,
          chatType: "private",
          chatStatus: "normal",
          external: false,
          raw: {}
        };
      }
    });
    const snapshot = await diagnostics.snapshot();
    assert.equal(snapshot.feishuDefaultChatDiagnostic?.ok, true);
    assert.equal(snapshot.feishuDefaultChatDiagnostic?.fullTopicMode, true);
    assert.match(snapshot.feishuDefaultChatDiagnostic?.recommendation ?? "", /话题消息形式/);
  } finally {
    cleanup();
  }
});
