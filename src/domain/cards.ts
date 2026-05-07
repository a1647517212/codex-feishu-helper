import type {
  DiagnosticSnapshot,
  NotificationOutboxItem,
  PendingApproval,
  QueuedMessage,
  TaskEvent,
  TaskProcessProjection,
  TaskProgressProjection,
  TaskReportProjection,
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

  waitingForPromptCard(project: { name: string; rootPath: string }): FeishuCard {
    return card("新任务", [
      text(`项目：${project.name}\n状态：等待任务描述\n目录：${project.rootPath}\n\n请直接回复你希望 Codex 完成的事情。`),
      commandText(["直接回复任务描述", "/projects", "/doctor"])
    ]);
  }

  claimableSessionsCard(
    threads: Array<{
      id: string;
      title: string;
      status: string;
      cwd: string | null;
      projectName?: string | null;
      claimed?: boolean;
      bindingId?: string | null;
      rootMessageId?: string | null;
      unclassified?: boolean;
    }>
  ): FeishuCard {
    const elements: Record<string, unknown>[] = [];
    for (const thread of threads.slice(0, 10)) {
      elements.push(
        text(
          [
            thread.projectName ? `项目：${thread.projectName}` : null,
            `任务：${thread.title}`,
            `状态：${statusText(thread.status)}`,
            `工作目录：${thread.cwd ?? "未知"}`,
            thread.unclassified ? "归类：未归类任务" : null,
            thread.claimed ? "状态：这个任务已经可以在飞书继续" : `继续命令：/claim ${thread.id}`
          ]
            .filter(Boolean)
            .join("\n")
        )
      );
      const actionsForThread = thread.claimed
        ? [
            button("打开任务", "open_bound_topic", {
              bindingId: thread.bindingId,
              rootMessageId: thread.rootMessageId ?? thread.bindingId
            }),
            button("查看摘要", "claim_summary", { codexThreadId: thread.id })
          ]
        : [
            button("在飞书继续", "claim_thread", { codexThreadId: thread.id }),
            button("查看摘要", "claim_summary", { codexThreadId: thread.id }),
            button("忽略", "claim_ignore", { codexThreadId: thread.id })
          ];
      pushMaybe(elements, maybeActions(this.interactionMode, actionsForThread));
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

  projectCard(project: {
    id: string;
    name: string;
    rootPath: string;
    runningCount: number;
    pendingApprovals: number;
    completedCount: number;
  }): FeishuCard {
    const elements = [
      text(
        [
          `路径：${project.rootPath}`,
          `运行中：${project.runningCount}`,
          `待确认：${project.pendingApprovals}`,
          `最近完成：${project.completedCount}`
        ]
          .filter(Boolean)
          .join("\n")
      ),
      maybeActions(this.interactionMode, [
        button("新建任务", "new_task", { projectId: project.id }),
        button("接管任务", "claim_sessions", { projectId: project.id }),
        button("运行中任务", "project_running", { projectId: project.id })
      ])
    ].filter(Boolean) as Record<string, unknown>[];
    return card(project.name, elements);
  }

  taskStatusCard(projection: TaskStatusProjection): FeishuCard {
    const summaryItems = [
      kvLine("状态", statusText(projection.status)),
      kvLine("项目", projection.projectName),
      projection.queuedMessages > 0 ? kvLine("队列", `${projection.queuedMessages} 条后续要求`) : null,
      projection.pendingApprovals > 0 ? kvLine("待确认", `${projection.pendingApprovals} 项`) : null
    ].filter(Boolean) as string[];
    const elements: Record<string, unknown>[] = [text(summaryItems.join("\n"))];
    if (projection.lastSummary) {
      elements.push(divider());
      elements.push(sectionBlock("当前结论", projection.lastSummary));
    }
    elements.push(divider());
    elements.push(tipBlock(commandHintForStatus(projection.status)));
    pushMaybe(
      elements,
      maybeActions(
        this.interactionMode,
        taskButtons(projection.status).map(([label, action]) => button(label, action, { bindingId: projection.bindingId }))
      )
    );
    return card(projection.title, elements);
  }

  taskProgressCard(projection: TaskProgressProjection): FeishuCard {
    const elements: Record<string, unknown>[] = [text(taskMetaLines(projection.status, projection.projectName, projection.updatedAt).join("\n"))];
    for (const section of projection.sections.slice(0, 4)) {
      elements.push(divider());
      elements.push(sectionBlock(section.label, section.text));
    }
    return card(`${projection.title}｜处理进度`, elements);
  }

  taskReportCard(projection: TaskReportProjection): FeishuCard {
    const elements: Record<string, unknown>[] = [text(taskMetaLines(projection.status, projection.projectName, projection.updatedAt, "完成时间").join("\n"))];
    if (projection.reasoningSummary) {
      elements.push(divider());
      elements.push(sectionBlock("处理摘要", projection.reasoningSummary));
    }
    if (projection.finalResult) {
      elements.push(divider());
      elements.push(sectionBlock("最终结论", projection.finalResult));
    }
    if (!projection.reasoningSummary && !projection.finalResult) {
      elements.push(divider());
      elements.push(tipBlock("未提取到可展示的结果内容，请发送 /logs 查看本地任务记录。"));
    }
    return card(`${projection.title}｜处理完成`, elements);
  }

  taskProcessCard(projection: TaskProcessProjection): FeishuCard {
    const elements: Record<string, unknown>[] = [text(taskMetaLines(projection.status, projection.projectName, projection.updatedAt).join("\n"))];
    for (const section of projection.sections.slice(0, 6)) {
      elements.push(divider());
      elements.push(sectionBlock(section.label, section.text));
    }
    if (projection.sections.length === 0) {
      elements.push(divider());
      elements.push(tipBlock("暂时还没有可展示的处理记录。"));
    }
    return card(`${projection.title}｜处理记录`, elements);
  }

  taskProcessFallbackCard(title: string): FeishuCard {
    return card(title, [text("暂时还没有可展示的处理记录。")]);
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
        text(formatEventSummary(event))
      )
    );
  }

  unclassifiedThreadsCard(
    threads: Array<{
      id: string;
      title: string;
      cwd: string | null;
      status: string;
      canCreateProject?: boolean;
    }>
  ): FeishuCard {
    if (threads.length === 0) return card("未归类任务", [text("当前没有未归类任务。")]);
    const elements: Record<string, unknown>[] = [];
    for (const thread of threads.slice(0, 10)) {
      elements.push(
        text(
          [
            `任务：${thread.title}`,
            `状态：${statusText(thread.status)}`,
            `路径：${thread.cwd ?? "未知"}`,
            this.interactionMode === "message_command" ? `继续：/claim ${thread.id}` : null,
            this.interactionMode === "message_command" ? `摘要：/claim summary ${thread.id}` : null,
            this.interactionMode === "message_command" && thread.canCreateProject ? `创建项目：/create-project ${thread.id}` : null,
            this.interactionMode === "message_command" ? `归入已有项目：/pick-project ${thread.id}` : null,
            this.interactionMode === "message_command" ? `忽略：/claim ignore ${thread.id}` : null
          ]
            .filter(Boolean)
            .join("\n")
        )
      );
      pushMaybe(
        elements,
        maybeActions(this.interactionMode, [
          button("在飞书继续", "claim_thread", { codexThreadId: thread.id }),
          button("查看摘要", "claim_summary", { codexThreadId: thread.id })
        ])
      );
      pushMaybe(
        elements,
        maybeActions(this.interactionMode, [
          ...(thread.canCreateProject ? [button("创建为新项目", "unclassified_create_project", { codexThreadId: thread.id })] : []),
          button("归入已有项目", "unclassified_pick_project", { codexThreadId: thread.id }),
          button("忽略", "claim_ignore", { codexThreadId: thread.id })
        ])
      );
    }
    return card("未归类任务", elements);
  }

  projectAssignmentCard(
    thread: { id: string; title: string; cwd: string | null },
    projects: Array<{ id: string; name: string; rootPath: string }>
  ): FeishuCard {
    const elements: Record<string, unknown>[] = [
      text(
        [
          `任务：${thread.title}`,
          `路径：${thread.cwd ?? "未知"}`,
          projects.length === 0 ? `创建项目：/create-project ${thread.id}` : null
        ]
          .filter(Boolean)
          .join("\n")
      )
    ];
    if (projects.length === 0) {
      elements.push(text("当前没有可归入的项目，请先创建为新项目。"));
      return card("归入已有项目", elements);
    }
    for (const project of projects.slice(0, 10)) {
      elements.push(
        text(
          [
            `项目：${project.name}`,
            `目录：${project.rootPath}`,
            this.interactionMode === "message_command" ? `归入命令：/assign-project ${thread.id} ${project.id}` : null
          ]
            .filter(Boolean)
            .join("\n")
        )
      );
      pushMaybe(
        elements,
        maybeActions(this.interactionMode, [
          button("归入这个项目", "unclassified_assign_project", {
            codexThreadId: thread.id,
            projectId: project.id
          })
        ])
      );
    }
    return card("归入已有项目", elements);
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
          `任务承载：${snapshot.feishuTaskContainerMode === "dedicated_chat" ? "一任务一独立会话" : "主控群内话题"}`,
          `默认群：${chatDiagnosticText(snapshot)}`,
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

const kvLine = (label: string, value: string): string => `**${label}**  ${value}`;

const sectionBlock = (title: string, body: string): Record<string, unknown> =>
  text(`**${title}**\n${body}`);

const tipBlock = (body: string): Record<string, unknown> =>
  text(`**操作提示**\n${body}`);

const taskMetaLines = (status: string, projectName: string, updatedAt: string, timeLabel = "更新时间"): string[] => [
  kvLine("状态", statusText(status)),
  kvLine("项目", projectName),
  kvLine(timeLabel, formatTime(updatedAt))
];

const divider = (): Record<string, unknown> => ({ tag: "hr" });

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
    name: `Button_${actionId}`,
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
        ["停止任务", "task_stop"]
      ];
    case "completed":
      return [
        ["处理记录", "task_logs"],
        ["继续处理", "task_continue"],
        ["新建相关任务", "new_related_task"],
        ["归档", "task_archive"]
      ];
    case "failed":
      return [
        ["重试", "task_retry"],
        ["分析原因", "task_analyze_failure"],
        ["处理记录", "task_logs"],
        ["停止", "task_stop"]
      ];
    default:
      return [
        ["继续处理", "task_continue"],
        ["跑测试", "task_run_tests"],
        ["处理记录", "task_logs"],
        ["归档", "task_archive"]
      ];
  }
};

const commandHintForStatus = (status: string): string => {
  switch (status) {
    case "running":
      return "命令：/status、/queue、/stop；直接回复可追加要求";
    case "waiting_for_approval":
      return "命令：/approval list、/logs、/stop";
    case "completed":
      return "命令：/logs、/archive；直接回复可继续处理";
    case "failed":
      return "命令：/retry、/analyze-failure、/logs、/stop";
    default:
      return "命令：/status、/run-tests、/logs、/archive；直接回复可继续处理";
  }
};

const formatEventSummary = (event: TaskEvent): string => {
  const lines = [
    `#${event.seq} ${eventLabel(event.eventType)}`,
    event.codexTurnId ? `轮次：${event.codexTurnId}` : null,
    event.eventType === "codex.agent_delta"
      ? "内容：Codex 有新的处理输出，原始内容已保留在本地记录中。"
      : safeEventText(event.eventPayload.text),
    `时间：${event.createdAt}`
  ].filter(Boolean);
  return lines.join("\n");
};

const safeEventText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  return `内容：${truncate(compact, 240)}`;
};

const eventLabel = (type: string): string =>
  ({
    "task.created_from_feishu": "收到任务",
    "turn.started": "开始处理",
    "turn.requested_from_feishu": "继续处理",
    "turn.steer_requested_from_feishu": "追加要求",
    "codex.agent_delta": "处理中",
    "task.completed": "处理完成",
    "task.failed": "处理失败",
    "task.interrupted": "已中断",
    "approval.requested": "等待确认",
    "approval.resolved": "确认完成",
    "queue.cancelled": "队列已取消"
  })[type] ?? type;

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

const formatTime = (value: string): string => value.replace("T", " ").replace(/\.\d{3}Z$/, "");

const interactionModeText = (mode: string): string =>
  ({ message_command: "消息命令", hybrid: "按钮+消息命令", card_callback: "卡片按钮" })[mode] ?? mode;

const chatDiagnosticText = (snapshot: DiagnosticSnapshot): string => {
  const chat = snapshot.feishuDefaultChatDiagnostic;
  if (!snapshot.feishuDefaultChatId) return "未配置";
  if (!chat) return `${snapshot.feishuDefaultChatId}（未检查）`;
  if (!chat.ok) return `${snapshot.feishuDefaultChatId}（检查失败：${truncate(chat.error ?? chat.recommendation, 120)}）`;
  const mode = chat.fullTopicMode ? "话题消息形式" : "普通会话消息形式";
  return [chat.name ?? snapshot.feishuDefaultChatId, mode, chat.recommendation].join("\n");
};

const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 20)}\n...(已截断)` : value;
