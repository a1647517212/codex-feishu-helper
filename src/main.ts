#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { BridgeApp } from "./app.js";
import { FeishuAppConfigClient } from "./feishu/app-config.js";
import { FeishuClient } from "./feishu/client.js";
import { Logger } from "./logger.js";

const command = process.argv[2] ?? "serve";
const configArgIndex = process.argv.findIndex((arg) => arg === "--config" || arg === "-c");
const configPath = configArgIndex >= 0 ? process.argv[configArgIndex + 1] : undefined;
const config = loadConfig(configPath);

if (command === "serve") {
  const app = new BridgeApp(config);
  const shutdown = async () => {
    await app.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await app.start();
  console.log(`feishu-codex listening on http://${config.server.host}:${config.server.port}`);
  console.log(`admin token: ${config.server.adminToken}`);
} else if (command === "doctor") {
  const app = new BridgeApp(config);
  await app.tasks.bootstrapProjectsFromConfig();
  const snapshot = await app.diagnostics.snapshot();
  console.log(JSON.stringify(snapshot, null, 2));
  app.database.close();
} else if (command === "feishu-callback") {
  const action = process.argv[3] ?? "doctor";
  const client = new FeishuAppConfigClient(config);
  if (action === "doctor") {
    const diagnostic = await client.diagnoseCardActionCallback();
    console.log(JSON.stringify(diagnostic, null, 2));
  } else if (action === "fix") {
    const result = await client.ensureCardActionLongConnection();
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error(`Unknown feishu-callback action: ${action}`);
    process.exit(2);
  }
} else if (command === "feishu-chat") {
  const action = process.argv[3] ?? "doctor";
  const chatId = argumentAfter("--chat-id") ?? config.feishu.defaultChatId;
  if (!chatId) {
    console.error("Missing chat id. Configure feishu.defaultChatId or pass --chat-id <oc_xxx>.");
    process.exit(2);
  }
  const feishu = new FeishuClient(config, new Logger(config.storage.logPath));
  try {
    if (action === "doctor") {
      const info = await feishu.getChatInfo(chatId);
      const fullTopicMode = info.chatMode === "topic" || info.groupMessageType === "thread";
      console.log(
        JSON.stringify(
          {
            ok: true,
            chatId,
            name: info.name,
            chatMode: info.chatMode,
            groupMessageType: info.groupMessageType,
            fullTopicMode,
            recommendation: fullTopicMode
              ? "当前群已经是话题消息形式。"
              : "当前群不是全量话题消息形式；桥接可创建 reply_in_thread 任务话题，但群主界面仍是普通消息流。需要全量话题 UX 时可执行 feishu-chat set-topic-mode。"
          },
          null,
          2
        )
      );
    } else if (action === "set-topic-mode") {
      await feishu.setGroupMessageType(chatId, "thread");
      const info = await feishu.getChatInfo(chatId);
      console.log(
        JSON.stringify(
          {
            ok: true,
            patched: true,
            chatId,
            chatMode: info.chatMode,
            groupMessageType: info.groupMessageType
          },
          null,
          2
        )
      );
    } else {
      console.error(`Unknown feishu-chat action: ${action}`);
      process.exit(2);
    }
  } catch (error) {
    console.log(JSON.stringify(chatOperationFailure(error), null, 2));
    process.exit(1);
  }
} else {
  console.error(`Unknown command: ${command}`);
  console.error("Available commands: serve, doctor, feishu-callback doctor, feishu-callback fix, feishu-chat doctor, feishu-chat set-topic-mode");
  process.exit(2);
}

function argumentAfter(name: string): string | undefined {
  const index = process.argv.findIndex((arg) => arg === name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function chatOperationFailure(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  const codeMatch = message.match(/"code":(\d+)/);
  const code = codeMatch ? Number(codeMatch[1]) : null;
  const recommendation =
    code === 232016
      ? "飞书拒绝更新 group_message_type：当前机器人不是群主或群管理员。请把机器人设为群管理员，或由群主在飞书客户端把群消息形式改为话题消息后重试。"
      : "飞书群设置更新失败。请检查机器人是否在群内、是否有 im:chat:update 或 im:chat 权限，以及当前操作者是否有群管理权限。";
  return {
    ok: false,
    code,
    error: message,
    recommendation,
    requiredScopes: ["im:chat:update", "im:chat"],
    docs: "https://open.feishu.cn/document/server-docs/group/chat/update-2.md"
  };
}
