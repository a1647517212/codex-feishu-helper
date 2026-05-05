import type { DiagnosticSnapshot, PendingApproval, TaskStatusProjection } from "../core/types.js";

export type FeishuCard = Record<string, unknown>;

export class CardRenderer {
  consoleCard(stats: { running: number; approvals: number; queued: number; completedToday: number }): FeishuCard {
    return card("Codex 控制台", [
      text(`运行中 ${stats.running}   待确认 ${stats.approvals}   已排队 ${stats.queued}   今日完成 ${stats.completedToday}`),
      actions([
        button("新建任务", "new_task"),
        button("接管电脑任务", "claim_sessions"),
        button("项目列表", "project_list"),
        button("诊断", "doctor")
      ])
    ]);
  }

  newTaskDraftCard(): FeishuCard {
    return card("新建任务", [
      text("请直接回复你希望 Codex 完成的事情。\n\n收到第一条任务描述后，本地 Codex 会创建新任务并开始执行。")
    ]);
  }

  claimableSessionsCard(threads: Array<{ id: string; title: string; status: string; cwd: string | null }>): FeishuCard {
    const elements: Record<string, unknown>[] = [];
    for (const thread of threads.slice(0, 10)) {
      elements.push(
        text(
          [
            `任务：${thread.title}`,
            `状态：${statusText(thread.status)}`,
            `工作目录：${thread.cwd ?? "未知"}`
          ].join("\n")
        ),
        actions([button("在飞书继续", "claim_thread", { codexThreadId: thread.id })])
      );
    }
    return card("电脑上的 Codex 任务", elements.length > 0 ? elements : [text("没有发现可接管的本机 Codex 任务。")]);
  }

  projectListCard(projects: Array<{ name: string; rootPath: string; feishuChatId: string | null }>): FeishuCard {
    if (projects.length === 0) return card("项目列表", [text("尚未配置项目。")]);
    return card(
      "项目列表",
      projects
        .slice(0, 12)
        .map((project) =>
          text([`项目：${project.name}`, `目录：${project.rootPath}`, `飞书群：${project.feishuChatId ?? "默认控制台"}`].join("\n"))
        )
    );
  }

  taskStatusCard(projection: TaskStatusProjection): FeishuCard {
    const lines = [
      `状态：${statusText(projection.status)}`,
      `项目：${projection.projectName}`,
      projection.branchName ? `分支：${projection.branchName}` : null,
      `变更：${projection.changedFiles} 个文件`,
      projection.queuedMessages > 0 ? `队列：${projection.queuedMessages} 条后续要求` : null,
      projection.pendingApprovals > 0 ? `待确认：${projection.pendingApprovals} 项` : null,
      projection.lastSummary ? `摘要：${projection.lastSummary}` : null
    ].filter(Boolean);
    return card(projection.title, [
      text(lines.join("\n")),
      actions(taskButtons(projection.status).map(([label, action]) => button(label, action, { bindingId: projection.bindingId })))
    ]);
  }

  approvalCard(approval: PendingApproval): FeishuCard {
    const target =
      approval.approvalType === "command_execution"
        ? `Codex 想执行：\n${approval.command ?? "(未提供命令)"}`
        : `Codex 准备修改 ${approval.filePaths.length} 个文件：\n${approval.filePaths.slice(0, 8).join("\n")}`;
    const buttons = [
      button("允许一次", "approval_once", { approvalId: approval.id }),
      ...(approval.riskLevel === "low"
        ? [button("本任务允许", "approval_for_task", { approvalId: approval.id })]
        : []),
      button("拒绝", "approval_deny", { approvalId: approval.id }),
      button("查看详情", "approval_detail", { approvalId: approval.id })
    ];
    return card("需要确认", [
      text(`${target}\n\n用途：${approval.reason ?? "Codex 请求继续执行"}\n风险：${riskText(approval.riskLevel)}`),
      actions(buttons.slice(0, 4))
    ]);
  }

  diagnosticCard(snapshot: DiagnosticSnapshot): FeishuCard {
    return card("Bridge 诊断", [
      text(
        [
          `电脑：${snapshot.machineName}`,
          `Codex：${snapshot.codexAvailable ? "可用" : "不可用"}`,
          `app-server：${snapshot.appServerStatus}`,
          `飞书配置：${snapshot.feishuConfigured ? "已配置" : "未完整配置"}`,
          `运行中任务：${snapshot.runningTasksCount}`,
          `待确认：${snapshot.pendingApprovalsCount}`,
          `待发送通知：${snapshot.pendingOutboxCount}`,
          `数据库：${snapshot.databasePath}`,
          `最近错误：${snapshot.lastError ?? "无"}`
        ].join("\n")
      ),
      actions([button("重试连接", "doctor"), button("发送测试通知", "send_test_notification"), button("通知历史", "notification_history")])
    ]);
  }
}

const card = (title: string, elements: Record<string, unknown>[]): FeishuCard => ({
  config: { wide_screen_mode: true },
  header: { title: { tag: "plain_text", content: title }, template: "blue" },
  elements
});

const text = (content: string): Record<string, unknown> => ({
  tag: "div",
  text: { tag: "lark_md", content: truncate(content, 3000) }
});

const actions = (items: Record<string, unknown>[]): Record<string, unknown> => ({
  tag: "action",
  actions: items.slice(0, 4)
});

const button = (label: string, action: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  tag: "button",
  text: { tag: "plain_text", content: label },
  type: action.includes("deny") || action.includes("stop") ? "danger" : "default",
  value: {
    action,
    actionId: `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ...extra
  }
});

const taskButtons = (status: string): [string, string][] => {
  switch (status) {
    case "running":
      return [
        ["查看进度", "task_status"],
        ["查看变更", "task_diff"],
        ["追加要求", "task_append_hint"],
        ["停止任务", "task_stop"]
      ];
    case "waiting_for_approval":
      return [
        ["查看详情", "approval_list"],
        ["查看变更", "task_diff"],
        ["停止任务", "task_stop"]
      ];
    case "completed":
      return [
        ["查看变更", "task_diff"],
        ["继续处理", "task_continue"],
        ["新建相关任务", "new_related_task"],
        ["归档", "task_archive"]
      ];
    case "failed":
      return [
        ["重试", "task_retry"],
        ["分析原因", "task_analyze_failure"],
        ["查看日志", "task_logs"],
        ["停止", "task_stop"]
      ];
    default:
      return [
        ["继续处理", "task_continue"],
        ["跑测试", "task_run_tests"],
        ["查看变更", "task_diff"],
        ["归档", "task_archive"]
      ];
  }
};

const statusText = (status: string): string => {
  const map: Record<string, string> = {
    draft: "草稿",
    waiting_for_prompt: "等待任务描述",
    running: "运行中",
    waiting_for_approval: "等待确认",
    idle: "可继续",
    completed: "任务完成",
    failed: "任务失败",
    interrupted: "已中断",
    archived: "已归档"
  };
  return map[status] ?? status;
};

const riskText = (risk: string): string => ({ low: "低", medium: "中", high: "高" })[risk] ?? risk;

const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 20)}\n...(已截断)` : value;
