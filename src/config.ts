import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { newToken } from "./core/ids.js";

const TransportModeSchema = z.enum(["long_connection", "http_callback"]);
const InteractionModeSchema = z.enum(["message_command", "hybrid", "card_callback"]);
const TaskContainerModeSchema = z.enum(["dedicated_chat", "topic"]);
const TaskChatTypeSchema = z.enum(["private", "public"]);
const SandboxModeSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
const ApprovalPolicySchema = z.enum(["untrusted", "on-failure", "on-request", "never"]);
const HttpServerModeSchema = z.enum(["auto", "enabled", "disabled"]);

const stringArrayFromEnv = z
  .union([z.array(z.string()), z.string()])
  .optional()
  .transform((value) => {
    if (!value) return [];
    const raw = Array.isArray(value) ? value.join(",") : value;
    return raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .filter((entry) => !entry.startsWith("${"));
  });

const ConfigSchema = z.object({
  machine: z
    .object({
      id: z.string().default(hostname()),
      name: z.string().default(hostname())
    })
    .default({ id: hostname(), name: hostname() }),
  server: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().positive().default(8787),
      mode: HttpServerModeSchema.default("auto"),
      adminToken: z.string().optional()
    })
    .default({ host: "127.0.0.1", port: 8787, mode: "auto" }),
  codex: z
    .object({
      command: z.string().default("codex"),
      args: z.array(z.string()).default(["app-server"]),
      connectionMode: z.enum(["auto", "desktop_proxy", "standalone"]).default("auto"),
      proxyArgs: z.array(z.string()).default(["app-server", "proxy"]),
      experimentalApi: z.boolean().default(true),
      defaultModel: z.string().default("gpt-5.4"),
      defaultReasoningEffort: z.string().default("xhigh"),
      defaultSandboxMode: SandboxModeSchema.default("danger-full-access"),
      defaultApprovalPolicy: ApprovalPolicySchema.default("never"),
      autoArchiveOnCompletion: z.boolean().default(false),
      appStatePath: z.string().default("~/.codex/.codex-global-state.json"),
      serviceName: z.string().default("feishu_codex_bridge")
    })
    .default({
      command: "codex",
      args: ["app-server"],
      connectionMode: "auto",
      proxyArgs: ["app-server", "proxy"],
      experimentalApi: true,
      defaultModel: "gpt-5.4",
      defaultReasoningEffort: "xhigh",
      defaultSandboxMode: "danger-full-access",
      defaultApprovalPolicy: "never",
      autoArchiveOnCompletion: false,
      appStatePath: "~/.codex/.codex-global-state.json",
      serviceName: "feishu_codex_bridge"
    }),
  feishu: z
    .object({
      appId: z.string().optional(),
      appSecret: z.string().optional(),
      defaultChatId: z.string().optional(),
      verificationToken: z.string().optional(),
      encryptKey: z.string().optional(),
      transport: TransportModeSchema.optional(),
      messageTransport: TransportModeSchema.optional(),
      cardActionTransport: TransportModeSchema.optional(),
      interactionMode: InteractionModeSchema.optional(),
      taskContainerMode: TaskContainerModeSchema.default("dedicated_chat"),
      taskChatNamePrefix: z.string().default("C"),
      taskChatType: TaskChatTypeSchema.default("private"),
      taskChatFallbackToTopic: z.boolean().default(true),
      taskChatSetBotManager: z.boolean().default(true),
      allowedUserIds: stringArrayFromEnv,
      allowedChatIds: stringArrayFromEnv
    })
    .default({
      transport: "long_connection",
      taskContainerMode: "dedicated_chat",
      taskChatNamePrefix: "C",
      taskChatType: "private",
      taskChatFallbackToTopic: true,
      taskChatSetBotManager: true,
      allowedUserIds: [],
      allowedChatIds: []
    }),
  storage: z
    .object({
      homeDir: z.string().default("~/.feishu-codex"),
      databasePath: z.string().default("~/.feishu-codex/bridge.db"),
      logPath: z.string().default("~/.feishu-codex/bridge.log")
    })
    .default({
      homeDir: "~/.feishu-codex",
      databasePath: "~/.feishu-codex/bridge.db",
      logPath: "~/.feishu-codex/bridge.log"
    }),
  bridge: z
    .object({
      maxFeishuTextLength: z.number().int().positive().default(3500),
      queueMergeWindowMs: z.number().int().positive().default(300000),
      outboxRetryBaseMs: z.number().int().positive().default(15000),
      outboxMaxAttempts: z.number().int().positive().default(8),
      threadListLimit: z.number().int().positive().default(20)
    })
    .default({
      maxFeishuTextLength: 3500,
      queueMergeWindowMs: 300000,
      outboxRetryBaseMs: 15000,
      outboxMaxAttempts: 8,
      threadListLimit: 20
    }),
  projects: z
    .array(
      z.object({
        id: z.string().optional(),
        name: z.string(),
        rootPath: z.string(),
        feishuChatId: z.string().optional(),
        defaultModel: z.string().optional(),
        defaultReasoningEffort: z.string().optional(),
        approvalPolicy: z.string().optional(),
        sandboxPolicy: z.string().optional()
      })
    )
    .default([])
});

type ParsedConfig = z.infer<typeof ConfigSchema>;
export type TransportMode = z.infer<typeof TransportModeSchema>;
export type InteractionMode = z.infer<typeof InteractionModeSchema>;

export type BridgeConfig = Omit<ParsedConfig, "feishu" | "storage" | "server"> & {
  feishu: ParsedConfig["feishu"] & {
    messageTransport: TransportMode;
    cardActionTransport: TransportMode;
    interactionMode: InteractionMode;
  };
  configPath: string;
  storage: ParsedConfig["storage"] & {
    homeDir: string;
    databasePath: string;
    logPath: string;
  };
  server: ParsedConfig["server"] & {
    adminToken: string;
    mode: z.infer<typeof HttpServerModeSchema>;
  };
};

const expandPath = (value: string): string => {
  const withHome = value.startsWith("~/") || value.startsWith("~\\")
    ? resolve(homedir(), value.slice(2))
    : value;
  return resolve(withHome);
};

const expandEnv = (raw: string): string =>
  raw.replace(/\$\{([^}:]+)(?::-([^}]+))?\}/g, (_match, name: string, fallback: string | undefined) => {
    const envValue = process.env[name];
    return envValue && envValue.length > 0 ? envValue : fallback ?? "";
  });

export const resolveConfigPath = (override?: string): string =>
  expandPath(
    override ??
      process.env.FEISHU_CODEX_CONFIG ??
      process.env.CODEX_FEISHU_CONFIG ??
      "~/.feishu-codex/config.json"
  );

export const loadConfig = (override?: string): BridgeConfig => {
  const configPath = resolveConfigPath(override);
  const raw = existsSync(configPath) ? readFileSync(configPath, "utf8") : "{}";
  const expanded = expandEnv(raw);
  const parsed = ConfigSchema.parse(JSON.parse(expanded) as unknown);
  const homeDir = expandPath(parsed.storage.homeDir);
  const databasePath = expandPath(parsed.storage.databasePath);
  const logPath = expandPath(parsed.storage.logPath);
  const appStatePath = expandPath(parsed.codex.appStatePath);
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(dirname(databasePath), { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true });
  return {
    ...parsed,
    codex: { ...parsed.codex, appStatePath },
    feishu: {
      ...parsed.feishu,
      messageTransport: parsed.feishu.messageTransport ?? parsed.feishu.transport ?? "long_connection",
      cardActionTransport: parsed.feishu.cardActionTransport ?? parsed.feishu.transport ?? "long_connection",
      interactionMode: parsed.feishu.interactionMode ?? "hybrid"
    },
    configPath,
    storage: { ...parsed.storage, homeDir, databasePath, logPath },
    server: {
      ...parsed.server,
      adminToken: parsed.server.adminToken || process.env.FEISHU_CODEX_ADMIN_TOKEN || newToken(18)
    }
  };
};
