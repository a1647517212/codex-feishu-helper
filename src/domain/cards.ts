import type {
  DiagnosticSnapshot,
  NotificationOutboxItem,
  PendingApproval,
  QueuedMessage,
  TaskEvent,
  TaskStatusProjection
} from "../core/types.js";
import type { InteractionMode } from "../config.js";

export type FeishuCard = Record<string, unknown>;

export class CardRenderer {
  constructor(private readonly interactionMode: InteractionMode = "hybrid") {}

  consoleCard(stats: { running: number; approvals: number; queued: number; completedToday: number }): FeishuCard {
    const elements = [
      text(`运行中 ${stats.running}   待确认 ${stats.approvals}   已排队 ${stats.queued}   今日完成 ${stats.completedToday}`),
      commandText(["/tasks", "/projects", "/doctor", "/notify test", "/notify history"]),
      maybeActions(this.interactionMode, [
        button("新建任务", "new_task"),
        button("接管电脑任务", "claim_sessions"),
        button("项目列表", "project_list"),
        button("诊断", "doctor")
      ])
    ].filter(Boolean) as Record<string, unknown>[];
    return card("Codex 控制台", elements);
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
            `工作目录：${thread.cwd ?? "未知"}`,
            `继续命令：/claim ${thread.id}`
          ].join("\n")
        )
      );
      pushMaybe(elements, maybeActions(this.interactionMode, [button("在飞书继续", "claim_thread", { codexThreadId: thread.id })]));
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
      projection.lastSummary ? `摘要：${projection.lastSummary}` : null,
      commandHintForStatus(projection.status)
    ].filter(Boolean);
    const elements = [
      text(lines.join("\n")),
      maybeActions(
        this.interactionMode,
        taskButtons(projection.status).map(([label, action]) => button(label, action, { bindingId: projection.bindingId }))
      )
    ].filter(Boolean) as Record<string, unknown>[];
    return card(projection.title, elements);
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
    const elements = [
      text(
        `${target}\n\n用途：${approval.reason ?? "Codex 请求继续执行"}\n风险：${riskText(approval.riskLevel)}\n\n` +
          [`允许一次：/approval once ${approval.id}`, ...(approval.riskLevel === "low" ? [`本任务允许：/approval task ${approval.id}`] : []), `拒绝：/approval deny ${approval.id}`, `详情：/approval detail ${approval.id}`].join("\n")
      )
    ];
    pushMaybe(elements, maybeActions(this.interactionMode, buttons.slice(0, 4)));
    return card("需要确认", elements);
  }

  approvalDetailCard(approval: PendingApproval): FeishuCard {
    return card("审批详情", [
      text(
        [
          `类型：${approval.approvalType === "command_execution" ? "命令执行" : "文件修改"}`,
          `状态：${approval.status}`,
          `风险：${riskText(approval.riskLevel)}`,
          approval.command ? `命令：${approval.command}` : null,
          approval.filePaths.length > 0 ? `文件：\n${approval.filePaths.slice(0, 12).join("\n")}` : null,
          approval.reason ? `原因：${approval.reason}` : null,
          `请求时间：${approval.requestedAt}`,
          approval.resolvedAt ? `处理时间：${approval.resolvedAt}` : null
        ]
          .filter(Boolean)
          .join("\n")
      )
    ]);
  }

  approvalListCard(approvals: PendingApproval[]): FeishuCard {
    if (approvals.length === 0) return card("待确认列表", [text("当前没有待确认项。")]);
    const elements: Record<string, unknown>[] = [];
    for (const approval of approvals.slice(0, 10)) {
      elements.push(
        text(
          [
            `类型：${approval.approvalType === "command_execution" ? "命令执行" : "文件修改"}`,
            `风险：${riskText(approval.riskLevel)}`,
            approval.command ? `命令：${approval.command}` : `文件数：${approval.filePaths.length}`,
            `时间：${approval.requestedAt}`,
            `命令：/approval detail ${approval.id}`
          ].join("\n")
        )
      );
      pushMaybe(elements, maybeActions(this.interactionMode, [button("查看详情", "approval_detail", { approvalId: approval.id })]));
    }
    return card("待确认列表", elements);
  }

  queueCard(bindingId: string, queued: QueuedMessage[]): FeishuCard {
    if (queued.length === 0) return card("后续要求队列", [text("当前没有排队中的后续要求。")]);
    const elements: Record<string, unknown>[] = [];
    for (const item of queued.slice(0, 10)) {
      elements.push(text([`位置：${item.position}`, `内容：${item.text}`, `时间：${item.createdAt}`, `取消命令：/queue cancel ${item.id}`].join("\n")));
      pushMaybe(elements, maybeActions(this.interactionMode, [button("取消这条", "queue_cancel", { bindingId, queueId: item.id })]));
    }
    return card("后续要求队列", elements);
  }

  eventListCard(title: string, events: TaskEvent[]): FeishuCard {
    if (events.length === 0) return card(title, [text("暂无记录。")]);
    return card(
      title,
      events.slice(0, 12).map((event) =>
        text(
          [
            `#${event.seq} ${event.eventType}`,
            event.codexTurnId ? `turn：${event.codexTurnId}` : null,
            event.eventPayload.text ? `内容：${String(event.eventPayload.text)}` : null,
            `时间：${event.createdAt}`
          ]
            .filter(Boolean)
            .join("\n")
        )
      )
    );
  }

  notificationHistoryCard(items: NotificationOutboxItem[]): FeishuCard {
    if (items.length === 0) return card("通知历史", [text("暂无通知记录。")]);
    return card(
      "通知历史",
      items.slice(0, 12).map((item) =>
        text(
          [
            `类型：${item.notificationType}`,
            `状态：${item.status}`,
            `尝试：${item.attempts}`,
            item.lastError ? `错误：${item.lastError}` : null,
            `时间：${item.createdAt}`
          ]
            .filter(Boolean)
            .join("\n")
        )
      )
    );
  }

  diagnosticCard(snapshot: DiagnosticSnapshot): FeishuCard {
    const elements = [
      text(
        [
          `电脑：${snapshot.machineName}`,
          `Codex：${snapshot.codexAvailable ? "可用" : "不可用"}`,
          `app-server：${snapshot.appServerStatus}`,
          `飞书配置：${snapshot.feishuConfigured ? "已配置" : "未完整配置"}`,
          `消息接入：${snapshot.feishuMessageTransport === "long_connection" ? "长连接" : "HTTP 回调"}`,
          `卡片回调：${snapshot.feishuCardActionTransport === "long_connection" ? "长连接" : "HTTP 回调"}`,
          `交互模式：${interactionModeText(snapshot.feishuInteractionMode)}`,
          `运行中任务：${snapshot.runningTasksCount}`,
          `待确认：${snapshot.pendingApprovalsCount}`,
          `待发送通知：${snapshot.pendingOutboxCount}`,
          `最近消息：${snapshot.lastFeishuMessageAt ? `${snapshot.lastFeishuMessageAt} (${snapshot.lastFeishuMessageId ?? "unknown"})` : "暂无"}`,
          `最近卡片点击：${
            snapshot.lastFeishuCardActionAt
              ? `${snapshot.lastFeishuCardActionAt} (${snapshot.lastFeishuCardAction ?? "unknown"} / ${snapshot.lastFeishuCardActionId ?? "unknown"})`
              : "暂无"
          }`,
          `数据库：${snapshot.databasePath}`,
          `最近错误：${snapshot.lastError ?? "无"}`
        ].join("\n")
      ),
      commandText(["/doctor", "/notify test", "/notify history"]),
      maybeActions(this.interactionMode, [button("重试连接", "doctor"), button("发送测试通知", "send_test_notification"), button("通知历史", "notification_history")])
    ].filter(Boolean) as Record<string, unknown>[];
    return card("Bridge 诊断", elements);
  }
}

const card = (title: string, elements: Record<string, unknown>[]): FeishuCard => ({
  schema: "2.0",
  header: { title: { tag: "plain_text", content: title }, template: "blue" },
  body: {
    elements
  }
});

const text = (content: string): Record<string, unknown> => ({
  tag: "markdown",
  content: truncate(content, 3000)
});

const actions = (items: Record<string, unknown>[]): Record<string, unknown> => ({
  tag: "column_set",
  horizontal_align: "left",
  columns: items.slice(0, 4).map((item) => ({
    tag: "column",
    width: "weighted",
    weight: 1,
    vertical_align: "top",
    elements: [item]
  }))
});

const maybeActions = (mode: InteractionMode, items: Record<string, unknown>[]): Record<string, unknown> | null =>
  mode === "message_command" ? null : actions(items);

const pushMaybe = (elements: Record<string, unknown>[], element: Record<string, unknown> | null): void => {
  if (element) elements.push(element);
};

const commandText = (commands: string[]): Record<string, unknown> =>
  text(`可直接发送命令：\n${commands.map((command) => `- ${command}`).join("\n")}`);

const button = (label: string, action: string, extra: Record<string, unknown> = {}): Record<string, unknown> => {
  const actionId = `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const value = {
    action,
    actionId,
    ...extra
  };
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type: action.includes("deny") || action.includes("stop") ? "danger_filled" : "default",
    width: "default",
    size: "medium",
    name: `Button_${action}`,
    behaviors: [
      {
        type: "callback",
        value
      }
    ]
  };
};

const taskButtons = (status: string): [string, string][] => {
  switch (status) {
    case "running":
      return [
        ["查看进度", "task_status"],
        ["查看队列", "queue_view"],
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

const commandHintForStatus = (status: string): string => {
  switch (status) {
    case "running":
      return "命令：/status、/queue、/stop；直接回复可追加要求";
    case "waiting_for_approval":
      return "命令：/approval list、/diff、/stop";
    case "completed":
      return "命令：/diff、/archive；直接回复可继续处理";
    case "failed":
      return "命令：/retry、/analyze-failure、/logs、/stop";
    default:
      return "命令：/status、/run-tests、/diff、/archive；直接回复可继续处理";
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

const interactionModeText = (mode: string): string =>
  ({ message_command: "消息命令", hybrid: "按钮+消息命令", card_callback: "卡片按钮" })[mode] ?? mode;

const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 20)}\n...(已截断)` : value;
