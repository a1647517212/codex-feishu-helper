import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitSummary {
  repoRoot: string | null;
  branchName: string | null;
  remoteUrl: string | null;
  changedFiles: number;
  statusText: string;
}

export class GitInspector {
  async summarize(cwd: string | null | undefined): Promise<GitSummary> {
    if (!cwd) return emptySummary();
    try {
      const [root, branch, remote, status] = await Promise.all([
        this.git(cwd, ["rev-parse", "--show-toplevel"]),
        this.git(cwd, ["branch", "--show-current"]),
        this.git(cwd, ["config", "--get", "remote.origin.url"]).catch(() => ""),
        this.git(cwd, ["status", "--short"]).catch(() => "")
      ]);
      const statusText = status.trim();
      return {
        repoRoot: root.trim() || null,
        branchName: branch.trim() || null,
        remoteUrl: remote.trim() || null,
        changedFiles: statusText ? statusText.split(/\r?\n/).filter(Boolean).length : 0,
        statusText
      };
    } catch {
      return emptySummary();
    }
  }

  async diffSummary(cwd: string): Promise<string> {
    try {
      const status = await this.git(cwd, ["status", "--short"]);
      if (!status.trim()) return "当前项目没有 Git 变更。";
      const lines = status.trim().split(/\r?\n/).slice(0, 40);
      const suffix = status.trim().split(/\r?\n/).length > lines.length ? "\n..." : "";
      return `Git 变更摘要：\n${lines.join("\n")}${suffix}`;
    } catch {
      return "当前工作目录不是 Git 仓库，暂时无法展示 Git 变更。";
    }
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 1024 * 1024
    });
    return stdout;
  }
}

const emptySummary = (): GitSummary => ({
  repoRoot: null,
  branchName: null,
  remoteUrl: null,
  changedFiles: 0,
  statusText: ""
});
