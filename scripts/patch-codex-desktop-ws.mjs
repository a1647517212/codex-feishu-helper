#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync, writeSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const ORIGINAL_REGEX = /agent:new [A-Za-z0-9_$]+\.SocksProxyAgent\(`socks5h:\/\/127\.0\.0\.1:1080`\)/g;
const PATCH_PREFIX = "agent:void 0";
const PATCHED_REGEX = /agent:void 0\s*(?=,perMessageDeflate:!1)/g;

const args = parseArgs(process.argv.slice(2));

try {
  const result = run(args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printHuman(result);
  }
} catch (error) {
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(error instanceof Error ? error.message : error) }, null, 2)}\n`);
  } else {
    process.stderr.write(`Error: ${String(error instanceof Error ? error.message : error)}\n`);
  }
  process.exitCode = 1;
}

function run(options) {
  const action = options.action ?? "status";
  const asarPath = resolveAsarPath(options.asar);
  const backupDir = resolvePath(options.backupDir ?? join(homedir(), ".feishu-codex", "codex-desktop-backups"));
  if (action === "status") return status(asarPath, backupDir);
  if (action === "install") return install(asarPath, backupDir);
  if (action === "restore") return restore(asarPath, backupDir, options);
  throw new Error(`Unsupported action: ${action}`);
}

function status(asarPath, backupDir) {
  const buffer = readFileSync(asarPath);
  const originalMatches = findOriginalMatches(buffer);
  const patchedMatches = findPatchedMatches(buffer);
  const sha256 = hash(buffer);
  const writable = canWrite(asarPath);
  let state = "unknown";
  if (originalMatches.length === 1 && patchedMatches.length === 0) state = "original";
  if (originalMatches.length === 0 && patchedMatches.length === 1) state = "patched";
  return {
    ok: true,
    action: "status",
    state,
    asarPath,
    backupDir,
    sha256,
    writable,
    originalMatches: originalMatches.length,
    patchedMatches: patchedMatches.length,
    latestBackup: latestManifest(backupDir, asarPath)?.manifestPath ?? null
  };
}

function install(asarPath, backupDir) {
  const before = status(asarPath, backupDir);
  if (before.state === "patched") {
    return { ...before, action: "install", changed: false, message: "Codex Desktop WS direct patch is already installed." };
  }
  if (before.state !== "original") {
    throw new Error(`Cannot patch unexpected app.asar state: ${before.state}. originalMatches=${before.originalMatches}, patchedMatches=${before.patchedMatches}`);
  }

  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(backupDir, `${basename(asarPath)}.${stamp}.${before.sha256.slice(0, 12)}.bak`);
  const manifestPath = `${backupPath}.json`;
  copyFileSync(asarPath, backupPath);

  const match = findOriginalMatches(readFileSync(asarPath))[0];
  const patchedPattern = replacementFor(match.text);
  writeAt(asarPath, match.index, Buffer.from(patchedPattern, "utf8"));
  const after = status(asarPath, backupDir);
  if (after.state !== "patched") {
    throw new Error(`Patch write did not produce patched state: ${after.state}`);
  }

  const manifest = {
    kind: "codex-desktop-ws-direct-patch",
    installedAt: new Date().toISOString(),
    asarPath,
    backupPath,
    originalSha256: before.sha256,
    patchedSha256: after.sha256,
    offset: match.index,
    originalPattern: match.text,
    patchedPattern,
    replacement: PATCH_PREFIX
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return {
    ...after,
    action: "install",
    changed: true,
    backupPath,
    manifestPath,
    originalSha256: before.sha256,
    patchedSha256: after.sha256,
    message: "Installed Codex Desktop WS direct patch. Restart Codex Desktop for it to take effect."
  };
}

function restore(asarPath, backupDir, options) {
  const current = status(asarPath, backupDir);
  const selected = options.backup ? readManifestOrBackup(options.backup, asarPath) : latestManifest(backupDir, asarPath);
  if (!selected) {
    throw new Error(`No backup manifest found for ${asarPath}`);
  }
  const manifest = selected.manifest;
  if (!existsSync(manifest.backupPath)) {
    throw new Error(`Backup file is missing: ${manifest.backupPath}`);
  }
  const backupSha256 = hash(readFileSync(manifest.backupPath));
  if (backupSha256 !== manifest.originalSha256) {
    throw new Error(`Backup sha256 mismatch: ${manifest.backupPath}`);
  }
  if (current.sha256 === manifest.originalSha256) {
    return { ...current, action: "restore", changed: false, message: "Codex Desktop WS patch is already restored." };
  }
  if (current.sha256 !== manifest.patchedSha256 && !options.force) {
    throw new Error("Current app.asar does not match the selected patched backup. Re-run status, or use --force only if you understand the risk.");
  }
  const originalPattern = Buffer.from(manifest.originalPattern, "utf8");
  const patchedPattern = Buffer.from(manifest.patchedPattern ?? replacementFor(manifest.originalPattern), "utf8");
  const buffer = readFileSync(asarPath);
  const patchedIndexes = findAll(buffer, patchedPattern);
  if (patchedIndexes.length !== 1) {
    throw new Error(`Cannot restore because selected patched marker count is ${patchedIndexes.length}.`);
  }
  writeAt(asarPath, patchedIndexes[0], originalPattern);
  const after = status(asarPath, backupDir);
  if (after.state !== "original") {
    throw new Error(`Restore write did not produce original state: ${after.state}`);
  }
  return {
    ...after,
    action: "restore",
    changed: true,
    restoredFrom: manifest.backupPath,
    message: "Restored Codex Desktop original WS transport. Restart Codex Desktop for it to take effect."
  };
}

function parseArgs(argv) {
  const result = { action: undefined, json: false, force: false, asar: undefined, backupDir: undefined, backup: undefined };
  const actions = new Set(["status", "install", "restore"]);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (actions.has(arg)) {
      result.action = arg;
      continue;
    }
    if (arg === "--json") {
      result.json = true;
      continue;
    }
    if (arg === "--force") {
      result.force = true;
      continue;
    }
    if (arg === "--asar") {
      result.asar = argv[++index];
      continue;
    }
    if (arg === "--backup-dir") {
      result.backupDir = argv[++index];
      continue;
    }
    if (arg === "--backup") {
      result.backup = argv[++index];
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function resolveAsarPath(explicitPath) {
  if (explicitPath) return resolvePath(explicitPath);
  if (process.env.CODEX_DESKTOP_ASAR) return resolvePath(process.env.CODEX_DESKTOP_ASAR);

  if (process.platform === "win32") {
    const candidates = collectWindowsAsarCandidates()
      .filter((asarPath, index, array) => array.findIndex((candidate) => candidate.toLowerCase() === asarPath.toLowerCase()) === index)
      .filter((asarPath) => existsSync(asarPath))
      .map((asarPath) => ({ asarPath, mtimeMs: statSync(asarPath).mtimeMs }))
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
    if (candidates[0]) return candidates[0].asarPath;
  }

  throw new Error("Codex Desktop app.asar was not found. Pass --asar <path> or set CODEX_DESKTOP_ASAR.");
}

function collectWindowsAsarCandidates() {
  const candidates = [];
  for (const executablePath of windowsCommandLines("where.exe", ["Codex.exe"])) {
    candidates.push(...asarCandidatesFromExecutable(executablePath));
  }
  for (const executablePath of windowsPowerShellLines(
    "Get-CimInstance Win32_Process -Filter \"name = 'Codex.exe'\" | ForEach-Object { $_.ExecutablePath }"
  )) {
    candidates.push(...asarCandidatesFromExecutable(executablePath));
  }
  for (const installLocation of windowsPowerShellLines("Get-AppxPackage -Name OpenAI.Codex | ForEach-Object { $_.InstallLocation }")) {
    candidates.push(join(installLocation, "app", "resources", "app.asar"));
  }
  return candidates;
}

function asarCandidatesFromExecutable(executablePath) {
  if (!executablePath) return [];
  const normalized = executablePath.trim();
  const parent = dirname(normalized);
  const candidates = [join(parent, "app.asar"), join(parent, "resources", "app.asar")];
  if (basename(parent).toLowerCase() === "resources") {
    candidates.push(join(parent, "app.asar"));
  }
  if (basename(parent).toLowerCase() === "app") {
    candidates.push(join(parent, "resources", "app.asar"));
  }
  return candidates;
}

function windowsCommandLines(command, commandArgs) {
  try {
    return execFileSync(command, commandArgs, { encoding: "utf8", windowsHide: true })
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function windowsPowerShellLines(command) {
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-Command", command], { encoding: "utf8", windowsHide: true })
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function resolvePath(pathValue) {
  if (pathValue.startsWith("~/") || pathValue.startsWith("~\\")) {
    return resolve(homedir(), pathValue.slice(2));
  }
  return resolve(pathValue);
}

function findAll(buffer, needle) {
  const indexes = [];
  let offset = 0;
  while (offset < buffer.length) {
    const index = buffer.indexOf(needle, offset);
    if (index === -1) break;
    indexes.push(index);
    offset = index + needle.length;
  }
  return indexes;
}

function findOriginalMatches(buffer) {
  const text = buffer.toString("latin1");
  return Array.from(text.matchAll(ORIGINAL_REGEX), (match) => ({
    index: match.index ?? -1,
    text: match[0]
  })).filter((match) => match.index >= 0);
}

function findPatchedMatches(buffer) {
  const text = buffer.toString("latin1");
  return Array.from(text.matchAll(PATCHED_REGEX), (match) => ({
    index: match.index ?? -1,
    text: match[0]
  })).filter((match) => match.index >= 0);
}

function replacementFor(originalPattern) {
  const originalLength = Buffer.byteLength(originalPattern, "utf8");
  const prefixLength = Buffer.byteLength(PATCH_PREFIX, "utf8");
  if (prefixLength > originalLength) {
    throw new Error("Codex Desktop patch replacement is longer than original pattern.");
  }
  return PATCH_PREFIX + " ".repeat(originalLength - prefixLength);
}

function writeAt(filePath, offset, bytes) {
  const fd = openSync(filePath, "r+");
  try {
    writeSync(fd, bytes, 0, bytes.length, offset);
  } finally {
    closeSync(fd);
  }
}

function hash(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function canWrite(filePath) {
  try {
    accessSync(filePath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function latestManifest(backupDir, asarPath) {
  if (!existsSync(backupDir)) return null;
  const normalizedAsar = resolve(asarPath).toLowerCase();
  const manifests = readdirSync(backupDir)
    .filter((name) => name.endsWith(".bak.json"))
    .map((name) => {
      const manifestPath = join(backupDir, name);
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        return resolve(manifest.asarPath).toLowerCase() === normalizedAsar
          ? { manifestPath, manifest, mtimeMs: statSync(manifestPath).mtimeMs }
          : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  return manifests[0] ?? null;
}

function readManifestOrBackup(pathValue, asarPath) {
  const absolute = resolvePath(pathValue);
  if (absolute.endsWith(".json")) {
    return { manifestPath: absolute, manifest: JSON.parse(readFileSync(absolute, "utf8")) };
  }
  const manifestPath = `${absolute}.json`;
  if (existsSync(manifestPath)) {
    return { manifestPath, manifest: JSON.parse(readFileSync(manifestPath, "utf8")) };
  }
  const current = status(asarPath, dirname(absolute));
  return {
    manifestPath: null,
    manifest: {
      asarPath,
      backupPath: absolute,
      originalSha256: hash(readFileSync(absolute)),
      patchedSha256: current.sha256
    }
  };
}

function printHuman(result) {
  process.stdout.write(`Action: ${result.action}\n`);
  process.stdout.write(`State: ${result.state}\n`);
  process.stdout.write(`app.asar: ${result.asarPath}\n`);
  process.stdout.write(`Writable: ${String(result.writable)}\n`);
  process.stdout.write(`Original marker count: ${result.originalMatches}\n`);
  process.stdout.write(`Patched marker count: ${result.patchedMatches}\n`);
  if (result.backupPath) process.stdout.write(`Backup: ${result.backupPath}\n`);
  if (result.latestBackup) process.stdout.write(`Latest backup: ${result.latestBackup}\n`);
  if (result.message) process.stdout.write(`${result.message}\n`);
}
