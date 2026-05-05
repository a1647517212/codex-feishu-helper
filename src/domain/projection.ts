import type { Repository } from "../db/repo.js";
import type { TaskStatusProjection } from "../core/types.js";

export class ProjectionBuilder {
  constructor(private readonly repo: Repository) {}

  buildTaskStatus(bindingId: string): TaskStatusProjection {
    const binding = this.repo.findBindingById(bindingId);
    if (!binding) throw new Error(`Session binding not found: ${bindingId}`);
    const project = binding.projectId ? this.repo.getProject(binding.projectId) : null;
    const events = this.repo.listEventsForBinding(bindingId, 50);
    const queuedMessages = this.repo.listQueuedMessages(bindingId).length;
    const pendingApprovals = this.repo.listPendingApprovals(bindingId).length;
    const lastSummaryEvent = [...events].reverse().find((event) =>
      ["task.completed", "task.failed", "task.summary", "codex.agent_delta"].includes(event.eventType)
    );
    const changedEvent = [...events].reverse().find((event) => event.eventType === "git.changed_files");
    return {
      bindingId: binding.id,
      title: binding.title ?? "Codex 任务",
      projectName: project?.name ?? "未归类项目",
      status: binding.status,
      cwd: binding.cwd,
      branchName: binding.branchName,
      changedFiles:
        typeof changedEvent?.eventPayload.count === "number" ? changedEvent.eventPayload.count : 0,
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
