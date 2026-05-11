import type { Repository } from "../db/repo.js";
import type { TaskStatusProjection } from "../core/types.js";
import { extractSubAgentsFromEvents } from "./subagents.js";

export class ProjectionBuilder {
  constructor(private readonly repo: Repository) {}

  buildTaskStatus(bindingId: string): TaskStatusProjection {
    const binding = this.repo.findBindingById(bindingId);
    if (!binding) throw new Error(`Session binding not found: ${bindingId}`);
    const project = binding.projectId ? this.repo.getProject(binding.projectId) : null;
    const events = this.repo.listEventsForBinding(bindingId, 50);
    const queuedMessages = this.repo.listQueuedMessages(bindingId).length;
    const pendingApprovals = this.repo.listPendingApprovals(bindingId).length + this.repo.listPendingServerRequests(bindingId).length;
    const lastSummaryEvent = [...events].reverse().find((event) =>
      ["task.completed", "task.failed", "task.summary"].includes(event.eventType)
    );
    return {
      bindingId: binding.id,
      title: binding.title ?? "Codex 任务",
      projectName: project?.name ?? "未归类项目",
      status: binding.status,
      cwd: binding.cwd,
      selectedModel: binding.selectedModel,
      selectedReasoningEffort: binding.selectedReasoningEffort,
      subAgents: extractSubAgentsFromEvents(events),
      queuedMessages,
      pendingApprovals,
      lastTurnId: binding.lastTurnId,
      lastSummary:
        typeof lastSummaryEvent?.eventPayload.text === "string"
          ? lastSummaryEvent.eventPayload.text
          : null,
      updatedAt: binding.updatedAt
    };
  }
}
