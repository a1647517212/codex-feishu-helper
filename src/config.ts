import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { newToken } from "./core/ids.js";

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
      adminToken: z.string().optional()
    })
    .default({ host: "127.0.0.1", port: 8787 }),
  codex: z
    .object({
      command: z.string().default("codex"),
      args: z.array(z.string()).default(["app-server"]),
      experimentalApi: z.boolean().default(true),
      defaultModel: z.string().default("gpt-5.4"),
      defaultReasoningEffort: z.string().default("medium"),
      serviceName: z.string().default("feishu_codex_bridge")
    })
    .default({
      command: "codex",
      args: ["app-server"],
      experimentalApi: true,
      defaultModel: "gpt-5.4",
      defaultReasoningEffort: "medium",
      serviceName: "feishu_codex_bridge"
    }),
  feishu: z
    .object({
      appId: z.string().optional(),
      appSecret: z.string().optional(),
      defaultChatId: z.string().optional(),
      verificationToken: z.string().optional(),
      allowedUserIds: stringArrayFromEnv,
      allowedChatIds: stringArrayFromEnv
    })
    .default({ allowedUserIds: [], allowedChatIds: [] }),
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
        approvalPolicy: z.string().optional(),
        sandboxPolicy: z.string().optional()
      })
    )
    .default([])
});

export type BridgeConfig = z.infer<typeof ConfigSchema> & {
  configPath: string;
  storage: z.infer<typeof ConfigSchema>["storage"] & {
    homeDir: string;
    databasePath: string;
    logPath: string;
  };
  server: z.infer<typeof ConfigSchema>["server"] & {
    adminToken: string;
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
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(dirname(databasePath), { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true });
  return {
    ...parsed,
    configPath,
    storage: { ...parsed.storage, homeDir, databasePath, logPath },
    server: {
      ...parsed.server,
      adminToken: parsed.server.adminToken || process.env.FEISHU_CODEX_ADMIN_TOKEN || newToken(18)
    }
  };
};
