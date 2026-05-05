import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const tsOut = resolve(root, "src/generated/codex");
const schemaOut = resolve(root, "schemas/codex");

for (const dir of [tsOut, schemaOut]) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

const run = (args) => {
  const result = spawnSync("codex", args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

run(["app-server", "generate-ts", "--out", tsOut, "--experimental"]);
run(["app-server", "generate-json-schema", "--out", schemaOut, "--experimental"]);
