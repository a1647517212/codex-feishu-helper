import { resolve, sep } from "node:path";
import type { BridgeConfig } from "../config.js";
import type { FeishuIncomingMessage } from "../core/types.js";

const secretFilePatterns = [
  /^\.env(\.|$)/i,
  /(^|[\\/])id_rsa$/i,
  /(^|[\\/])id_ed25519$/i,
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /token/i,
  /cookie/i,
  /credential/i,
  /secret/i
];

export class SecurityPolicy {
  constructor(private readonly config: BridgeConfig) {}

  assertFeishuMessageAllowed(message: FeishuIncomingMessage): void {
    this.assertFeishuAllowed(message.userId, message.chatId);
  }

  assertFeishuAllowed(userId: string, chatId: string): void {
    const allowedUsers = this.config.feishu.allowedUserIds ?? [];
    const allowedChats = this.config.feishu.allowedChatIds ?? [];
    if (allowedUsers.length > 0 && !allowedUsers.includes(userId)) {
      throw new Error("Feishu user is not allowed to control this bridge.");
    }
    if (allowedChats.length > 0 && !allowedChats.includes(chatId)) {
      throw new Error("Feishu chat is not allowed to control this bridge.");
    }
  }

  resolveInsideProject(projectRoot: string, requestedPath = "."): string {
    const safeRoot = resolve(projectRoot);
    const target = resolve(safeRoot, requestedPath);
    if (target !== safeRoot && !target.startsWith(`${safeRoot}${sep}`)) {
      throw new Error("Requested path escapes project root.");
    }
    if (this.isSecretPath(target)) {
      throw new Error("Requested path is blocked by secret-file policy.");
    }
    return target;
  }

  isSecretPath(path: string): boolean {
    return secretFilePatterns.some((pattern) => pattern.test(path));
  }
}
