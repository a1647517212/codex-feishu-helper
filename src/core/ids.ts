import { randomBytes, randomUUID } from "node:crypto";

export const newId = (prefix: string): string => `${prefix}_${randomUUID().replaceAll("-", "")}`;

export const newToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");
