import test from "node:test";
import assert from "node:assert/strict";
import { CodexClient } from "../src/codex/client.js";
import { makeConfig, makeLogger, makeTempRepo } from "./helpers.js";

test("listThreads scans paginated app-server results with a bounded max page count", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const client = new CodexClient(makeConfig(dir), makeLogger(dir));
    const calls: Array<Record<string, unknown>> = [];
    const pages = [
      { data: [{ id: "thr_1", status: { type: "idle" } }], nextCursor: "next_1" },
      { data: [{ id: "thr_2", status: { type: "active" } }], nextCursor: "next_2" },
      { data: [{ id: "thr_3", status: { type: "idle" } }], nextCursor: null }
    ];
    (client as unknown as { request: (method: string, params: unknown) => Promise<unknown> }).request = async (
      method,
      params
    ) => {
      assert.equal(method, "thread/list");
      calls.push(params as Record<string, unknown>);
      return pages[calls.length - 1];
    };

    const threads = await client.listThreads(3, { pageSize: 1, maxPages: 3 });

    assert.deepEqual(
      calls.map((call) => call.cursor ?? null),
      [null, "next_1", "next_2"]
    );
    assert.equal(calls.every((call) => call.sortKey === "updated_at"), true);
    assert.deepEqual(
      threads.map((thread) => [thread.id, thread.status]),
      [
        ["thr_1", "idle"],
        ["thr_2", "running"],
        ["thr_3", "idle"]
      ]
    );
  } finally {
    cleanup();
  }
});
