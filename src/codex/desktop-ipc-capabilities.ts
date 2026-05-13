import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface DesktopIpcCapabilities {
  appAsarPath: string | null;
  requestHandlers: string[];
  requestHandlerCount: number;
  supportsHostThreadCreation: boolean;
  supportsThreadGoal: boolean;
  supportsThreadTitle: boolean;
  supportsArchiveControl: boolean;
  supportsFollowerControl: boolean;
  probeError: string | null;
}

const followerOnlyMethods = new Set([
  "thread-follower-start-turn",
  "thread-follower-compact-thread",
  "thread-follower-steer-turn",
  "thread-follower-interrupt-turn",
  "thread-follower-set-model-and-reasoning",
  "thread-follower-set-collaboration-mode",
  "thread-follower-edit-last-user-turn",
  "thread-follower-command-approval-decision",
  "thread-follower-file-approval-decision",
  "thread-follower-permissions-request-approval-response",
  "thread-follower-submit-user-input",
  "thread-follower-submit-mcp-server-elicitation-response",
  "thread-follower-set-queued-follow-ups-state"
]);

const hostThreadCreationMethods = new Set([
  "start-conversation",
  "thread/start",
  "start-thread-for-host"
]);

const goalMethods = new Set(["set-thread-goal", "thread/goal/set"]);
const titleMethods = new Set(["set-thread-title", "thread/name/set"]);
const archiveMethods = new Set(["archive-conversation", "unarchive-conversation", "thread/archive", "thread/unarchive"]);

export const detectDesktopIpcCapabilities = (): DesktopIpcCapabilities | null => {
  const appAsarPath = findCodexDesktopAppAsarPath();
  if (!appAsarPath) return null;
  try {
    const text = readFileSync(appAsarPath, "utf8");
    return parseDesktopIpcCapabilitiesFromAppAsarText(text, appAsarPath);
  } catch (error) {
    return {
      appAsarPath,
      requestHandlers: [],
      requestHandlerCount: 0,
      supportsHostThreadCreation: false,
      supportsThreadGoal: false,
      supportsThreadTitle: false,
      supportsArchiveControl: false,
      supportsFollowerControl: false,
      probeError: error instanceof Error ? error.message : String(error)
    };
  }
};

export const parseDesktopIpcCapabilitiesFromAppAsarText = (
  text: string,
  appAsarPath: string | null = null
): DesktopIpcCapabilities => {
  const requestHandlers = collectRequestHandlers(text);
  const requestHandlerSet = new Set(requestHandlers);
  return {
    appAsarPath,
    requestHandlers,
    requestHandlerCount: requestHandlers.length,
    supportsHostThreadCreation: hasAny(requestHandlerSet, hostThreadCreationMethods),
    supportsThreadGoal: hasAny(requestHandlerSet, goalMethods),
    supportsThreadTitle: hasAny(requestHandlerSet, titleMethods),
    supportsArchiveControl: hasAny(requestHandlerSet, archiveMethods),
    supportsFollowerControl: hasAny(requestHandlerSet, followerOnlyMethods),
    probeError: null
  };
};

const collectRequestHandlers = (text: string): string[] => {
  const matches = new Set<string>();
  const regex = /addRequestHandler\(`([^`]+)`/g;
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(text)) !== null) {
    const name = match[1]?.trim();
    if (name) matches.add(name);
  }
  return [...matches].sort((left, right) => left.localeCompare(right));
};

const hasAny = (present: Set<string>, expected: Set<string>): boolean => {
  for (const value of expected) {
    if (present.has(value)) return true;
  }
  return false;
};

const findCodexDesktopAppAsarPath = (): string | null => {
  const windowsAppsRoot = join(process.env.ProgramFiles ?? "C:\\Program Files", "WindowsApps");
  const windowsAppsCandidate = findNewestAppAsarUnderRoot(windowsAppsRoot, (name) => /^OpenAI\.Codex_/i.test(name));
  if (windowsAppsCandidate) return windowsAppsCandidate;
  const localProgramsRoot = join(process.env.LOCALAPPDATA ?? "", "Programs");
  const localProgramsCandidate = findNewestAppAsarUnderRoot(localProgramsRoot, (name) => /codex/i.test(name));
  return localProgramsCandidate;
};

const findNewestAppAsarUnderRoot = (root: string, matcher: (name: string) => boolean): string | null => {
  if (!existsSync(root)) return null;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory() && matcher(entry.name))
    .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true, sensitivity: "base" }));
  for (const entry of candidates) {
    const candidate = join(root, entry.name, "app", "resources", "app.asar");
    if (existsSync(candidate)) return candidate;
    const plainCandidate = join(root, entry.name, "resources", "app.asar");
    if (existsSync(plainCandidate)) return plainCandidate;
  }
  return null;
};
