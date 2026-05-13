import test from "node:test";
import assert from "node:assert/strict";
import { parseDesktopIpcCapabilitiesFromAppAsarText } from "../src/codex/desktop-ipc-capabilities.js";

test("desktop ipc capability probe detects follower-only stock desktop runtime", () => {
  const text = [
    "r.add(n.addRequestHandler(`thread-follower-start-turn`,i,async t=>{}))",
    "r.add(n.addRequestHandler(`thread-follower-steer-turn`,i,async t=>{}))",
    "r.add(n.addRequestHandler(`thread-follower-submit-user-input`,i,async t=>{}))"
  ].join("\n");
  const capabilities = parseDesktopIpcCapabilitiesFromAppAsarText(text, "C:\\Codex\\app.asar");

  assert.equal(capabilities.appAsarPath, "C:\\Codex\\app.asar");
  assert.equal(capabilities.supportsFollowerControl, true);
  assert.equal(capabilities.supportsHostThreadCreation, false);
  assert.equal(capabilities.supportsThreadGoal, false);
  assert.equal(capabilities.supportsThreadTitle, false);
  assert.equal(capabilities.supportsArchiveControl, false);
  assert.deepEqual(capabilities.requestHandlers, [
    "thread-follower-start-turn",
    "thread-follower-steer-turn",
    "thread-follower-submit-user-input"
  ]);
});

test("desktop ipc capability probe detects host creation support when request handler is present", () => {
  const text = [
    "r.add(n.addRequestHandler(`thread-follower-start-turn`,i,async t=>{}))",
    "r.add(n.addRequestHandler(`start-conversation`,i,async t=>{}))",
    "r.add(n.addRequestHandler(`set-thread-goal`,i,async t=>{}))",
    "r.add(n.addRequestHandler(`set-thread-title`,i,async t=>{}))",
    "r.add(n.addRequestHandler(`archive-conversation`,i,async t=>{}))"
  ].join("\n");
  const capabilities = parseDesktopIpcCapabilitiesFromAppAsarText(text);

  assert.equal(capabilities.supportsFollowerControl, true);
  assert.equal(capabilities.supportsHostThreadCreation, true);
  assert.equal(capabilities.supportsThreadGoal, true);
  assert.equal(capabilities.supportsThreadTitle, true);
  assert.equal(capabilities.supportsArchiveControl, true);
});
