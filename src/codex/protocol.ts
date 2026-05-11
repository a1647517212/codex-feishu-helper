import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TaskStatus } from "../core/types.js";

export interface JsonRpcRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  id: number | string;
  result?: unknown;
  error?: { code?: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export class CodexProtocolGuard {
  private readonly knownMethods: Set<string>;

  constructor(schemaPath = resolve("schemas/codex/ClientRequest.json")) {
    this.knownMethods = existsSync(schemaPath) ? readKnownMethods(schemaPath) : new Set();
  }

  validateClientMethod(method: string): void {
    if (this.knownMethods.size > 0 && !this.knownMethods.has(method)) {
      throw new Error(`Codex protocol method is not present in generated schema: ${method}`);
    }
  }
}

export const toTaskStatus = (status: unknown): TaskStatus => {
  if (!status || typeof status !== "object" || !("type" in status)) return "idle";
  const type = String((status as { type?: unknown }).type);
  if (type === "active") return "running";
  if (type === "systemError") return "failed";
  return "idle";
};

export const textInput = (text: string): Record<string, unknown> => ({
  type: "text",
  text,
  text_elements: []
});

export type CodexLocalImageAttachment = {
  path: string;
};

export const buildUserInput = (text: string, attachments: CodexLocalImageAttachment[] = []): Record<string, unknown>[] => {
  const input: Record<string, unknown>[] = [textInput(text)];
  for (const attachment of attachments) {
    if (attachment.path.trim()) {
      input.push({ type: "localImage", path: attachment.path });
    }
  }
  return input;
};

const readKnownMethods = (schemaPath: string): Set<string> => {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
  const methods = new Set<string>();
  collectConstMethods(schema, methods);
  return methods;
};

const collectConstMethods = (node: unknown, methods: Set<string>): void => {
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (record.const && typeof record.const === "string") {
    methods.add(record.const);
  }
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      value.forEach((entry) => collectConstMethods(entry, methods));
    } else {
      collectConstMethods(value, methods);
    }
  }
};
