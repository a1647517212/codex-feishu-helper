import test from "node:test";
import assert from "node:assert/strict";
import { FeishuLongConnectionServer } from "../src/feishu/long-connection.js";
import { makeConfig, makeLogger, makeTempRepo } from "./helpers.js";

test("long connection adapter maps message and card events into task service calls", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const received: any[] = [];
    const actions: any[] = [];
    const tasks = {
      async handleMessage(message: any): Promise<void> {
        received.push(message);
      },
      async processCardActionDeferred(action: any): Promise<void> {
        actions.push(action);
      }
    };
    const diagnostics = {
      recordFeishuMessage(): void {},
      recordFeishuCardAction(): void {}
    };
    const server = new FeishuLongConnectionServer(config, tasks as any, diagnostics as any, makeLogger(dir));
    await (server as any).handleMessageEvent({
      sender: { sender_id: { open_id: "ou_1" }, sender_type: "user" },
      message: {
        message_id: "om_1",
        chat_id: "oc_1",
        root_id: "om_root",
        thread_id: "omt_1",
        create_time: "1",
        chat_type: "group",
        message_type: "text",
        content: "{\"text\":\"继续处理\"}"
      }
    });
    const result = await (server as any).handleCardActionEvent({
      context: { open_message_id: "om_root", open_chat_id: "oc_1" },
      operator: { open_id: "ou_1" },
      action: { tag: "button", value: { action: "task_status", actionId: "act_1", bindingId: "bind_1" } }
    });
    assert.deepEqual(received[0], {
      messageId: "om_1",
      chatId: "oc_1",
      rootMessageId: "om_root",
      threadId: "omt_1",
      userId: "ou_1",
      text: "继续处理",
      createTime: "1"
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(actions[0].action, "task_status");
    assert.equal(actions[0].chatId, "oc_1");
    assert.equal((result.toast as any).content, "已收到，正在处理");
  } finally {
    cleanup();
  }
});

test("long connection adapter maps v2 card action context nested under event", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const actions: any[] = [];
    const tasks = {
      async handleMessage(): Promise<void> {},
      async processCardActionDeferred(action: any): Promise<void> {
        actions.push(action);
      }
    };
    const diagnostics = {
      recordFeishuMessage(): void {},
      recordFeishuCardAction(): void {}
    };
    const server = new FeishuLongConnectionServer(config, tasks as any, diagnostics as any, makeLogger(dir));
    await (server as any).handleCardActionEvent({
      schema: "2.0",
      header: { event_type: "card.action.trigger" },
      event: {
        context: { open_message_id: "om_root", open_chat_id: "oc_1" },
        operator: { open_id: "ou_1" },
        action: { tag: "button", value: { action: "doctor", actionId: "act_v2" } }
      }
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(actions[0].action, "doctor");
    assert.equal(actions[0].actionId, "act_v2");
    assert.equal(actions[0].chatId, "oc_1");
    assert.equal(actions[0].rootMessageId, "om_root");
  } finally {
    cleanup();
  }
});
