import { createHash } from "node:crypto";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { WorkspaceCheckpoint } from "../core/types.js";

export type WorkspaceManifestFile = {
  path: string;
  size: number;
  mtimeMs: number;
  sha256: string | null;
  sample: string | null;
  skipped?: string;
};

export type WorkspaceManifest = {
  version: 1;
  root: string;
  capturedAt: string;
  files: WorkspaceManifestFile[];
  truncated: boolean;
  limits: {
    maxFiles: number;
    maxFileBytes: number;
    maxSampleBytes: number;
  };
  skipped: {
    directories: string[];
    files: string[];
  };
};

export type WorkspaceImpactSummary = {
  added: WorkspaceManifestFile[];
  modified: Array<{
    before: WorkspaceManifestFile;
    after: WorkspaceManifestFile;
  }>;
  deleted: WorkspaceManifestFile[];
  unchangedCount: number;
  truncated: boolean;
};

export type WorkspaceRestoreSummary = {
  restored: string[];
  removedAdded: string[];
  skipped: Array<{
    path: string;
    reason: string;
  }>;
};

const DEFAULT_MAX_FILES = 1200;
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_SAMPLE_BYTES = 32 * 1024;
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  ".vite",
  "target",
  "out",
  "bin",
  "obj",
  ".gradle",
  ".idea",
  ".vscode"
]);
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".7z",
  ".rar",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".class",
  ".jar",
  ".sqlite",
  ".db"
]);

export const captureWorkspaceManifest = (
  root: string,
  options: {
    maxFiles?: number;
    maxFileBytes?: number;
    maxSampleBytes?: number;
  } = {}
): WorkspaceManifest => {
  const workspaceRoot = resolve(root);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxSampleBytes = options.maxSampleBytes ?? DEFAULT_MAX_SAMPLE_BYTES;
  const manifest: WorkspaceManifest = {
    version: 1,
    root: workspaceRoot,
    capturedAt: new Date().toISOString(),
    files: [],
    truncated: false,
    limits: {
      maxFiles,
      maxFileBytes,
      maxSampleBytes
    },
    skipped: {
      directories: [],
      files: []
    }
  };
  if (!existsSync(workspaceRoot)) return manifest;
  walk(workspaceRoot, workspaceRoot, manifest);
  manifest.files.sort((left, right) => left.path.localeCompare(right.path));
  return manifest;
};

export const compareWorkspaceManifests = (
  beforeCheckpoint: WorkspaceCheckpoint | null,
  afterCheckpoint: WorkspaceCheckpoint | null
): WorkspaceImpactSummary | null => {
  const before = parseManifest(beforeCheckpoint?.manifest);
  const after = parseManifest(afterCheckpoint?.manifest);
  if (!before || !after) return null;
  const beforeByPath = new Map(before.files.map((file) => [file.path, file]));
  const afterByPath = new Map(after.files.map((file) => [file.path, file]));
  const added: WorkspaceManifestFile[] = [];
  const modified: WorkspaceImpactSummary["modified"] = [];
  const deleted: WorkspaceManifestFile[] = [];
  let unchangedCount = 0;
  for (const afterFile of after.files) {
    const beforeFile = beforeByPath.get(afterFile.path);
    if (!beforeFile) {
      added.push(afterFile);
      continue;
    }
    if (fileSignature(beforeFile) !== fileSignature(afterFile)) {
      modified.push({ before: beforeFile, after: afterFile });
    } else {
      unchangedCount += 1;
    }
  }
  for (const beforeFile of before.files) {
    if (!afterByPath.has(beforeFile.path)) deleted.push(beforeFile);
  }
  return {
    added,
    modified,
    deleted,
    unchangedCount,
    truncated: before.truncated || after.truncated
  };
};

export const formatWorkspaceImpact = (impact: WorkspaceImpactSummary | null): string => {
  if (!impact) return "还没有可对比的检查点。下一轮任务完成后会自动生成本次影响。";
  const lines = [
    `新增 ${impact.added.length} 个文件，修改 ${impact.modified.length} 个文件，删除 ${impact.deleted.length} 个文件。`,
    impact.truncated ? "检查点较大，已按安全上限截取；影响列表可能不是全量。" : null,
    formatFileGroup("新增", impact.added.map((file) => file.path)),
    formatFileGroup("修改", impact.modified.map((item) => item.after.path)),
    formatFileGroup("删除", impact.deleted.map((file) => file.path))
  ].filter(Boolean);
  return lines.join("\n\n");
};

export const restoreWorkspaceFromCheckpoints = (
  beforeCheckpoint: WorkspaceCheckpoint,
  afterCheckpoint: WorkspaceCheckpoint
): WorkspaceRestoreSummary => {
  const before = parseManifest(beforeCheckpoint.manifest);
  const after = parseManifest(afterCheckpoint.manifest);
  if (!before || !after) throw new Error("检查点数据不完整，无法撤销。");
  if (resolve(before.root) !== resolve(after.root)) throw new Error("检查点工作区不一致，无法撤销。");
  const impact = compareWorkspaceManifests(beforeCheckpoint, afterCheckpoint);
  if (!impact) throw new Error("没有可撤销的检查点影响。");
  const summary: WorkspaceRestoreSummary = { restored: [], removedAdded: [], skipped: [] };
  for (const item of impact.modified) {
    restoreFile(before.root, item.before, summary);
  }
  for (const file of impact.deleted) {
    restoreFile(before.root, file, summary);
  }
  for (const file of impact.added) {
    removeAddedFile(before.root, file, summary);
  }
  return summary;
};

const walk = (root: string, current: string, manifest: WorkspaceManifest): void => {
  if (manifest.truncated) return;
  let entries: string[];
  try {
    entries = readdirSync(current);
  } catch {
    manifest.skipped.directories.push(toRelative(root, current));
    return;
  }
  for (const entry of entries) {
    if (manifest.files.length >= manifest.limits.maxFiles) {
      manifest.truncated = true;
      return;
    }
    const absolute = resolve(current, entry);
    const relativePath = toRelative(root, absolute);
    let stats;
    try {
      stats = statSync(absolute);
    } catch {
      manifest.skipped.files.push(relativePath);
      continue;
    }
    if (stats.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(entry)) {
        manifest.skipped.directories.push(relativePath);
        continue;
      }
      walk(root, absolute, manifest);
      continue;
    }
    if (!stats.isFile()) continue;
    manifest.files.push(captureFile(absolute, relativePath, stats.size, stats.mtimeMs, manifest.limits));
  }
};

const captureFile = (
  absolute: string,
  relativePath: string,
  size: number,
  mtimeMs: number,
  limits: WorkspaceManifest["limits"]
): WorkspaceManifestFile => {
  if (size > limits.maxFileBytes) {
    return { path: relativePath, size, mtimeMs, sha256: null, sample: null, skipped: "large_file" };
  }
  if (BINARY_EXTENSIONS.has(extname(relativePath).toLowerCase())) {
    return { path: relativePath, size, mtimeMs, sha256: null, sample: null, skipped: "binary_file" };
  }
  try {
    const bytes = readFileSync(absolute);
    if (looksBinary(bytes)) {
      return { path: relativePath, size, mtimeMs, sha256: null, sample: null, skipped: "binary_file" };
    }
    return {
      path: relativePath,
      size,
      mtimeMs,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sample: bytes.subarray(0, Math.min(bytes.length, limits.maxSampleBytes)).toString("utf8")
    };
  } catch {
    return { path: relativePath, size, mtimeMs, sha256: null, sample: null, skipped: "read_failed" };
  }
};

const restoreFile = (root: string, file: WorkspaceManifestFile, summary: WorkspaceRestoreSummary): void => {
  const target = safeResolve(root, file.path);
  if (!file.sample || Buffer.byteLength(file.sample, "utf8") !== file.size) {
    summary.skipped.push({ path: file.path, reason: file.skipped ?? "content_not_fully_captured" });
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, file.sample, { encoding: "utf8" });
  summary.restored.push(file.path);
};

const removeAddedFile = (root: string, file: WorkspaceManifestFile, summary: WorkspaceRestoreSummary): void => {
  const target = safeResolve(root, file.path);
  if (!existsSync(target)) return;
  try {
    const stats = statSync(target);
    if (!stats.isFile()) {
      summary.skipped.push({ path: file.path, reason: "not_a_file" });
      return;
    }
    unlinkSync(target);
    summary.removedAdded.push(file.path);
  } catch (error) {
    summary.skipped.push({ path: file.path, reason: error instanceof Error ? error.message : String(error) });
  }
};

const safeResolve = (root: string, relativePath: string): string => {
  const safeRoot = resolve(root);
  const target = resolve(safeRoot, relativePath);
  if (target !== safeRoot && !target.startsWith(`${safeRoot}${sep}`)) {
    throw new Error(`checkpoint path escapes workspace root: ${relativePath}`);
  }
  return target;
};

const parseManifest = (value: Record<string, unknown> | undefined): WorkspaceManifest | null => {
  if (!value || value.version !== 1 || !Array.isArray(value.files)) return null;
  return value as WorkspaceManifest;
};

const fileSignature = (file: WorkspaceManifestFile): string =>
  [file.sha256 ?? "nohash", file.size, Math.round(file.mtimeMs), file.skipped ?? ""].join(":");

const toRelative = (root: string, absolute: string): string => {
  const value = relative(root, absolute).split(sep).join("/");
  return value || ".";
};

const looksBinary = (bytes: Buffer): boolean => {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8000));
  return sample.includes(0);
};

const formatFileGroup = (label: string, paths: string[]): string | null => {
  if (paths.length === 0) return null;
  const visible = paths.slice(0, 12).map((path) => `- ${path}`);
  const hidden = paths.length > visible.length ? `\n... 还有 ${paths.length - visible.length} 个` : "";
  return `**${label}**\n${visible.join("\n")}${hidden}`;
};
