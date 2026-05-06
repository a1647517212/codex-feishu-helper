import test from "node:test";
import assert from "node:assert/strict";
import { FeishuAppConfigClient } from "../src/feishu/app-config.js";
import { makeConfig, makeTempRepo } from "./helpers.js";

test("Feishu app callback diagnostic reports missing application read scopes", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const client = new FeishuAppConfigClient(config, undefined, mockFetch([
      tenantTokenResponse(),
      jsonResponse(400, {
        code: 99991672,
        msg:
          "Access denied. One of the following scopes is required: [admin:app.info:readonly, application:application:self_manage]." +
          "https://open.feishu.cn/app/cli_test/auth?q=admin:app.info:readonly,application:application:self_manage&op_from=openapi&token_type=tenant",
        error: {
          permission_violations: [
            { type: "action_scope_required", subject: "admin:app.info:readonly" },
            { type: "action_scope_required", subject: "application:application:self_manage" }
          ]
        }
      })
    ]));
    const diagnostic = await client.diagnoseCardActionCallback();
    assert.equal(diagnostic.ok, false);
    assert.equal(diagnostic.permission?.operation, "get application");
    assert.deepEqual(diagnostic.permission?.requiredScopes, [
      "admin:app.info:readonly",
      "application:application:self_manage"
    ]);
    assert.equal(diagnostic.cardCallbackConfigured, null);
    assert.equal(diagnostic.websocketConfigured, null);
  } finally {
    cleanup();
  }
});

test("Feishu app callback fix patches websocket card action callback", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const config = makeConfig(dir);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new FeishuAppConfigClient(
      config,
      undefined,
      mockFetch(
        [
          tenantTokenResponse(),
          applicationResponse({ callback_type: "webhook", subscribed_callbacks: ["url.preview.get"] }),
          jsonResponse(200, { code: 0, msg: "success", data: {} }),
          applicationResponse({ callback_type: "websocket", subscribed_callbacks: ["url.preview.get", "card.action.trigger"] })
        ],
        calls
      )
    );
    const result = await client.ensureCardActionLongConnection();
    assert.equal(result.ok, true);
    assert.equal(result.patched, true);
    assert.equal(result.diagnostic?.cardCallbackConfigured, true);
    assert.equal(result.diagnostic?.websocketConfigured, true);
    const patchCall = calls.find((call) => call.init?.method === "PATCH");
    assert.ok(patchCall);
    assert.deepEqual(JSON.parse(String(patchCall.init?.body)), {
      callback_info: {
        callback_type: "websocket",
        subscribed_callbacks: ["url.preview.get", "card.action.trigger"]
      }
    });
  } finally {
    cleanup();
  }
});

const tenantTokenResponse = (): Response =>
  jsonResponse(200, {
    code: 0,
    msg: "success",
    tenant_access_token: "tenant-token",
    expire: 7200
  });

const applicationResponse = (callbackInfo: Record<string, unknown>): Response =>
  jsonResponse(200, {
    code: 0,
    msg: "success",
    data: {
      app: {
        app_id: "cli_test",
        app_name: "Codex Bridge",
        online_version_id: "online_1",
        unaudit_version_id: "",
        callback_info: callbackInfo
      }
    }
  });

const jsonResponse = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });

const mockFetch =
  (responses: Response[], calls: Array<{ url: string; init?: RequestInit }> = []) =>
  async (input: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    const response = responses.shift();
    assert.ok(response, `unexpected fetch call: ${String(input)}`);
    return response;
  };
