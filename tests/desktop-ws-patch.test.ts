import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const patcher = resolve("scripts", "patch-codex-desktop-ws.mjs");

test("desktop ws patcher installs and restores a same-length direct websocket patch", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-desktop-ws-patch-"));
  try {
    const asarPath = join(dir, "app.asar");
    const backupDir = join(dir, "backups");
    mkdirSync(backupDir);
    const original =
      "prefix " +
      "agent:new Qm.SocksProxyAgent(`socks5h://127.0.0.1:1080`),perMessageDeflate:!1" +
      " suffix";
    writeFileSync(asarPath, original, "utf8");

    const before = runPatch(["status", "--asar", asarPath, "--backup-dir", backupDir, "--json"]);
    assert.equal(before.state, "original");
    assert.equal(before.originalMatches, 1);
    assert.equal(before.patchedMatches, 0);

    const installed = runPatch(["install", "--asar", asarPath, "--backup-dir", backupDir, "--json"]);
    assert.equal(installed.state, "patched");
    assert.equal(installed.changed, true);
    const patchedText = readFileSync(asarPath, "utf8");
    assert.match(patchedText, /agent:void 0\s+,perMessageDeflate:!1/);
    assert.equal(Buffer.byteLength(patchedText), Buffer.byteLength(original));

    const restored = runPatch(["restore", "--asar", asarPath, "--backup-dir", backupDir, "--json"]);
    assert.equal(restored.state, "original");
    assert.equal(restored.changed, true);
    assert.equal(readFileSync(asarPath, "utf8"), original);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("desktop ws patcher rejects unexpected marker counts", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-desktop-ws-patch-"));
  try {
    const asarPath = join(dir, "app.asar");
    writeFileSync(asarPath, "no websocket transport here", "utf8");
    const failed = runPatchFailure(["install", "--asar", asarPath, "--backup-dir", join(dir, "backups"), "--json"]);
    assert.notEqual(failed.status, 0);
    assert.match(String(failed.body.error), /Cannot patch unexpected app.asar state/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

const runPatch = (args: string[]): Record<string, unknown> => {
  const output = execFileSync(process.execPath, [patcher, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return JSON.parse(output) as Record<string, unknown>;
};

const runPatchFailure = (args: string[]): { status: number | null; body: Record<string, unknown> } => {
  const result = spawnSync(process.execPath, [patcher, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return {
    status: result.status,
    body: JSON.parse(result.stdout) as Record<string, unknown>
  };
};
