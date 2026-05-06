import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";

const FEISHU_OPEN_API = "https://open.feishu.cn/open-apis";
const CARD_ACTION_CALLBACK = "card.action.trigger";

export interface FeishuCallbackInfo {
  callback_type?: string;
  request_url?: string;
  subscribed_callbacks?: string[];
}

export interface FeishuAppCallbackDiagnostic {
  ok: boolean;
  appId: string;
  appName?: string;
  onlineVersionId?: string;
  unauditVersionId?: string;
  callbackInfo?: FeishuCallbackInfo;
  desiredCallback: string;
  desiredCallbackType: "websocket";
  cardCallbackConfigured: boolean | null;
  websocketConfigured: boolean | null;
  publishRequired: boolean | null;
  recommendations: string[];
  permission?: FeishuPermissionProblem;
}

export interface FeishuCallbackFixResult {
  ok: boolean;
  patched: boolean;
  requestedCallbackInfo?: FeishuCallbackInfo;
  diagnostic?: FeishuAppCallbackDiagnostic;
  permission?: FeishuPermissionProblem;
}

export interface FeishuPermissionProblem {
  operation: string;
  code: number;
  message: string;
  requiredScopes: string[];
  consoleUrl?: string;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class FeishuPlatformApiError extends Error {
  readonly code: number;
  readonly body: Record<string, unknown>;

  constructor(
    readonly operation: string,
    readonly status: number,
    body: Record<string, unknown>
  ) {
    super(`Feishu ${operation} failed: ${String(body.msg ?? body.message ?? "unknown error")}`);
    this.code = Number(body.code ?? 0);
    this.body = body;
  }

  permissionProblem(): FeishuPermissionProblem | null {
    if (this.code !== 99991672) return null;
    return {
      operation: this.operation,
      code: this.code,
      message: String(this.body.msg ?? this.message),
      requiredScopes: extractRequiredScopes(this.body),
      consoleUrl: extractConsoleUrl(this.body)
    };
  }
}

export class FeishuAppConfigClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger?: Logger,
    private readonly fetchImpl: FetchLike = globalThis.fetch
  ) {}

  async diagnoseCardActionCallback(): Promise<FeishuAppCallbackDiagnostic> {
    try {
      const app = await this.getApplication();
      const callbackInfo = app.callbackInfo;
      const callbacks = callbackInfo?.subscribed_callbacks ?? [];
      const cardCallbackConfigured = callbackInfo ? callbacks.includes(CARD_ACTION_CALLBACK) : null;
      const websocketConfigured = callbackInfo ? callbackInfo.callback_type === "websocket" : null;
      const publishRequired = app.unauditVersionId ? true : null;
      const recommendations: string[] = [];
      if (websocketConfigured === false) {
        recommendations.push("将回调订阅方式改为长连接 websocket。");
      }
      if (cardCallbackConfigured === false) {
        recommendations.push(`在已订阅回调中添加 ${CARD_ACTION_CALLBACK}。`);
      }
      if (publishRequired) {
        recommendations.push("存在待发布版本，请发布最新应用版本后再测试新卡片按钮。");
      }
      if (callbackInfo === undefined) {
        recommendations.push("应用信息接口未返回 callback_info，可直接执行 fix-callback 通过 PATCH 写入目标配置。");
      }
      if (recommendations.length === 0) {
        recommendations.push("平台回调配置看起来已满足长连接卡片按钮要求；若旧卡片仍报错，请重新发送一张新卡片测试。");
      }
      return {
        ok: websocketConfigured !== false && cardCallbackConfigured !== false,
        appId: app.appId,
        appName: app.appName,
        onlineVersionId: app.onlineVersionId,
        unauditVersionId: app.unauditVersionId,
        callbackInfo,
        desiredCallback: CARD_ACTION_CALLBACK,
        desiredCallbackType: "websocket",
        cardCallbackConfigured,
        websocketConfigured,
        publishRequired,
        recommendations
      };
    } catch (error) {
      if (error instanceof FeishuPlatformApiError) {
        const permission = error.permissionProblem();
        if (permission) {
          return {
            ok: false,
            appId: this.config.feishu.appId ?? "",
            desiredCallback: CARD_ACTION_CALLBACK,
            desiredCallbackType: "websocket",
            cardCallbackConfigured: null,
            websocketConfigured: null,
            publishRequired: null,
            recommendations: [
              "当前应用缺少读取应用配置的应用身份权限，无法自动确认 callback_info。",
              "开通任一读取权限后重新执行 feishu-callback doctor。"
            ],
            permission
          };
        }
      }
      throw error;
    }
  }

  async ensureCardActionLongConnection(): Promise<FeishuCallbackFixResult> {
    let existingCallbacks: string[] = [];
    try {
      const app = await this.getApplication();
      existingCallbacks = app.callbackInfo?.subscribed_callbacks ?? [];
    } catch (error) {
      const permission = error instanceof FeishuPlatformApiError ? error.permissionProblem() : null;
      if (permission) {
        this.logger?.warn("Feishu application read permission is missing; continuing with minimal callback patch", {
          scopes: permission.requiredScopes
        });
      } else {
        throw error;
      }
    }
    const subscribedCallbacks = Array.from(new Set([...existingCallbacks, CARD_ACTION_CALLBACK]));
    const requestedCallbackInfo: FeishuCallbackInfo = {
      callback_type: "websocket",
      subscribed_callbacks: subscribedCallbacks
    };
    try {
      await this.patchApplicationCallback(requestedCallbackInfo);
    } catch (error) {
      if (error instanceof FeishuPlatformApiError) {
        const permission = error.permissionProblem();
        if (permission) {
          return { ok: false, patched: false, requestedCallbackInfo, permission };
        }
      }
      throw error;
    }
    return {
      ok: true,
      patched: true,
      requestedCallbackInfo,
      diagnostic: await this.diagnoseCardActionCallback()
    };
  }

  private async getApplication(): Promise<{
    appId: string;
    appName?: string;
    onlineVersionId?: string;
    unauditVersionId?: string;
    callbackInfo?: FeishuCallbackInfo;
  }> {
    const appId = this.config.feishu.appId;
    if (!appId) throw new Error("Feishu appId is required.");
    const body = await this.request("get application", `/application/v6/applications/${encodeURIComponent(appId)}?lang=zh_cn`);
    const data = getObject(body.data);
    const app = getObject(data.app);
    return {
      appId: String(app.app_id ?? appId),
      appName: optionalString(app.app_name),
      onlineVersionId: optionalString(app.online_version_id),
      unauditVersionId: optionalString(app.unaudit_version_id),
      callbackInfo: normalizeCallbackInfo(app.callback_info ?? app.callback)
    };
  }

  private async patchApplicationCallback(callbackInfo: FeishuCallbackInfo): Promise<void> {
    const appId = this.config.feishu.appId;
    if (!appId) throw new Error("Feishu appId is required.");
    await this.request("patch application callback", `/application/v6/applications/${encodeURIComponent(appId)}?lang=zh_cn`, {
      method: "PATCH",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ callback_info: callbackInfo })
    });
  }

  private async request(operation: string, path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const token = await this.getTenantAccessToken();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    const response = await this.fetchImpl(`${FEISHU_OPEN_API}${path}`, { ...init, headers });
    const text = await response.text();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok || Number(body.code ?? 0) !== 0) {
      throw new FeishuPlatformApiError(operation, response.status, body);
    }
    return body;
  }

  private async getTenantAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAt - 60_000 > now) return this.token.value;
    if (!this.config.feishu.appId || !this.config.feishu.appSecret) {
      throw new Error("Feishu appId/appSecret are required for Feishu platform API.");
    }
    const response = await this.fetchImpl(`${FEISHU_OPEN_API}/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        app_id: this.config.feishu.appId,
        app_secret: this.config.feishu.appSecret
      })
    });
    const text = await response.text();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok || Number(body.code ?? 0) !== 0) {
      throw new FeishuPlatformApiError("get tenant token", response.status, body);
    }
    const token = String(body.tenant_access_token ?? "");
    const expire = Number(body.expire ?? 7200);
    this.token = { value: token, expiresAt: now + expire * 1000 };
    return token;
  }
}

const normalizeCallbackInfo = (value: unknown): FeishuCallbackInfo | undefined => {
  const raw = getObject(value);
  if (Object.keys(raw).length === 0) return undefined;
  const callbacks = Array.isArray(raw.subscribed_callbacks)
    ? raw.subscribed_callbacks.map(String)
    : Array.isArray(raw.subscribedCallbacks)
      ? raw.subscribedCallbacks.map(String)
      : undefined;
  return {
    callback_type: optionalString(raw.callback_type ?? raw.callbackType),
    request_url: optionalString(raw.request_url ?? raw.requestUrl),
    subscribed_callbacks: callbacks
  };
};

const getObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const optionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value;
};

const extractRequiredScopes = (body: Record<string, unknown>): string[] => {
  const error = getObject(body.error);
  const violations = Array.isArray(error.permission_violations) ? error.permission_violations : [];
  const scopes = violations
    .map((violation) => getObject(violation).subject)
    .filter((scope): scope is string => typeof scope === "string" && scope.length > 0);
  if (scopes.length > 0) return scopes;
  const message = String(body.msg ?? "");
  const match = message.match(/\[([a-z0-9_:,.\-\s]+)\]/i);
  return match?.[1]
    ? match[1]
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean)
    : [];
};

const extractConsoleUrl = (body: Record<string, unknown>): string | undefined => {
  const message = String(body.msg ?? "");
  const match = message.match(/https:\/\/open\.feishu\.cn\/app\/[^\s，]+/);
  return match?.[0];
};
