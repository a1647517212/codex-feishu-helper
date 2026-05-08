import type { TaskEvent, TaskSubAgentProjection } from "../core/types.js";
import { asString } from "../core/json.js";

type MutableSubAgent = TaskSubAgentProjection & { sortKey: number };

export const extractSubAgentsFromThreadDetail = (detail: Record<string, unknown>): TaskSubAgentProjection[] => {
  const rawThread = detail.thread && typeof detail.thread === "object" ? (detail.thread as Record<string, unknown>) : detail;
  const turns = Array.isArray(rawThread.turns) ? rawThread.turns : [];
  const entries: MutableSubAgent[] = [];
  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const turn = turns[turnIndex];
    if (!turn || typeof turn !== "object") continue;
    const items = Array.isArray((turn as Record<string, unknown>).items) ? ((turn as Record<string, unknown>).items as unknown[]) : [];
    for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
      const parsed = parseCollabAgentItem(items[itemIndex], turnIndex * 10000 + itemIndex, null);
      entries.push(...parsed);
    }
  }
  return compactSubAgents(entries);
};

export const extractSubAgentsFromEvents = (events: TaskEvent[]): TaskSubAgentProjection[] => {
  const entries: MutableSubAgent[] = [];
  for (const event of events) {
    if (event.eventType !== "codex.subagent") continue;
    const fromPayload = parseSubAgentPayload(event.eventPayload, event.seq);
    entries.push(...fromPayload);
  }
  return compactSubAgents(entries);
};

export const subAgentEventsFromItem = (item: Record<string, unknown>, seq = Date.now()): TaskSubAgentProjection[] =>
  compactSubAgents(parseCollabAgentItem(item, seq, null));

export const formatSubAgentLines = (subAgents: TaskSubAgentProjection[], limit = 4): string => {
  if (subAgents.length === 0) return "";
  return subAgents
    .slice(0, limit)
    .map((agent, index) => {
      const name = agent.nickname || agent.role || shortThreadId(agent.threadId) || `子 agent ${index + 1}`;
      const meta = [
        subAgentStatusText(agent.status),
        agent.model ? `模型 ${agent.model}` : "模型 继承主任务/未知",
        agent.reasoningEffort ? `思考 ${agent.reasoningEffort}` : "思考 继承主任务/未知"
      ];
      const role = agent.role && agent.role !== name ? `，角色 ${agent.role}` : "";
      const message = agent.message ? `，${agent.message}` : "";
      return `${index + 1}. ${name}${role}：${meta.join(" · ")}${message}`;
    })
    .join("\n");
};

const parseSubAgentPayload = (payload: Record<string, unknown>, seq: number): MutableSubAgent[] => {
  if (Array.isArray(payload.subAgents)) {
    return payload.subAgents.flatMap((entry, index) =>
      entry && typeof entry === "object" ? [normalizeSubAgentEntry(entry as Record<string, unknown>, seq + index)] : []
    );
  }
  if (payload.threadId || payload.receiverThreadId) {
    return [normalizeSubAgentEntry(payload, seq)];
  }
  return parseCollabAgentItem(payload.item, seq, payload.updatedAt);
};

const parseCollabAgentItem = (value: unknown, sortKey: number, updatedAt: unknown): MutableSubAgent[] => {
  if (!value || typeof value !== "object") return [];
  const item = value as Record<string, unknown>;
  if (asString(item.type) !== "collabAgentToolCall") return [];
  const receiverThreadIds = Array.isArray(item.receiverThreadIds)
    ? item.receiverThreadIds.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
  if (receiverThreadIds.length === 0) return [];
  const states = item.agentsStates && typeof item.agentsStates === "object" ? (item.agentsStates as Record<string, unknown>) : {};
  return receiverThreadIds.map((threadId, index) => {
    const state = states[threadId] && typeof states[threadId] === "object" ? (states[threadId] as Record<string, unknown>) : {};
    return {
      threadId,
      nickname: null,
      role: null,
      tool: asString(item.tool),
      status: asString(state.status) ?? asString(item.status) ?? "unknown",
      model: asString(item.model),
      reasoningEffort: asString(item.reasoningEffort),
      message: asString(state.message),
      updatedAt: typeof updatedAt === "string" ? updatedAt : null,
      sortKey: sortKey + index
    };
  });
};

const normalizeSubAgentEntry = (entry: Record<string, unknown>, sortKey: number): MutableSubAgent => ({
  threadId: asString(entry.threadId) ?? asString(entry.receiverThreadId) ?? "",
  nickname: asString(entry.nickname),
  role: asString(entry.role),
  tool: asString(entry.tool),
  status: asString(entry.status) ?? "unknown",
  model: asString(entry.model),
  reasoningEffort: asString(entry.reasoningEffort),
  message: asString(entry.message),
  updatedAt: asString(entry.updatedAt),
  sortKey
});

const compactSubAgents = (entries: MutableSubAgent[]): TaskSubAgentProjection[] => {
  const byThread = new Map<string, MutableSubAgent>();
  for (const entry of entries) {
    if (!entry.threadId) continue;
    const previous = byThread.get(entry.threadId);
    byThread.set(entry.threadId, mergeSubAgent(previous, entry));
  }
  return [...byThread.values()]
    .sort((left, right) => right.sortKey - left.sortKey)
    .map(({ sortKey: _sortKey, ...entry }) => entry);
};

const mergeSubAgent = (previous: MutableSubAgent | undefined, next: MutableSubAgent): MutableSubAgent => {
  if (!previous) return next;
  return {
    threadId: next.threadId,
    nickname: next.nickname ?? previous.nickname,
    role: next.role ?? previous.role,
    tool: next.tool ?? previous.tool,
    status: next.status !== "unknown" ? next.status : previous.status,
    model: next.model ?? previous.model,
    reasoningEffort: next.reasoningEffort ?? previous.reasoningEffort,
    message: next.message ?? previous.message,
    updatedAt: next.updatedAt ?? previous.updatedAt,
    sortKey: Math.max(previous.sortKey, next.sortKey)
  };
};

const shortThreadId = (threadId: string): string =>
  threadId.length > 10 ? `${threadId.slice(0, 6)}...${threadId.slice(-4)}` : threadId;

const subAgentStatusText = (status: string): string =>
  ({
    pendingInit: "初始化中",
    inProgress: "调用中",
    running: "运行中",
    completed: "已完成",
    errored: "失败",
    interrupted: "已中断",
    shutdown: "已关闭",
    notFound: "未找到",
    failed: "失败"
  })[status] ?? status;
