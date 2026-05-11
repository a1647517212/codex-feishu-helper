import type {
  NotificationLevel,
  DiagnosticSnapshot,
  NotificationPreference,
  NotificationOutboxItem,
  PendingApproval,
  QueuedMessage,
  TaskEvent,
  TaskProcessProjection,
  TaskProgressProjection,
  TaskReportProjection,
  TaskStatusProjection,
  TaskSubAgentProjection,
  WorkspaceCheckpoint
} from "../core/types.js";
import type { WorkspaceImpactSummary, WorkspaceRestoreSummary } from "./checkpoints.js";
import type { InteractionMode } from "../config.js";

export type FeishuCard = Record<string, unknown>;

export class CardRenderer {
  constructor(private readonly interactionMode: InteractionMode = "hybrid") {}

  consoleCard(input: {
    running: number;
    approvals: number;
    queued: number;
    completedToday: number;
    recentTasks?: Array<{
      title: string;
      status: string;
      projectName?: string | null;
      model?: string | null;
      reasoningEffort?: string | null;
    }>;
  }): FeishuCard {
    const elements = [
      sectionBlock(
        "概览",
        [
          `运行中 ${input.running}`,
          `待确认 ${input.approvals}`,
          `排队中 ${input.queued}`,
          `今日完成 ${input.completedToday}`
        ].join("  ")
      ),
      maybeActions(this.interactionMode, [
        button("项目", "project_list"),
        button("最近任务", "task_list_recent")
      ]),
      maybeActions(this.interactionMode, [
        button("运行中", "task_list_running"),
        button("待确认", "approval_list_all")
      ]),
      maybeActions(this.interactionMode, [
        button("已完成", "task_list_completed"),
        button("归档", "task_list_archived")
      ])
    ].filter(Boolean) as Record<string, unknown>[];
    if (input.recentTasks && input.recentTasks.length > 0) {
      elements.push(divider());
      elements.push(sectionBlock("最近任务", formatRecentTasks(input.recentTasks)));
    }
    if (this.interactionMode === "message_command") {
      elements.push(divider());
      elements.push(commandText(["/tasks", "/projects", "/unclassified", "/search 关键词", "/doctor", "/notify history"]));
    }
    pushMaybe(elements, maybeActions(this.interactionMode, [button("未归类", "unclassified_threads")]));
    pushMaybe(
      elements,
      maybeActions(this.interactionMode, [button("诊断", "doctor"), button("通知", "notification_settings_global")])
    );
    return card("Codex 控制台", elements);
  }

  newTaskDraftCard(): FeishuCard {
    return card("新建任务", [
      text("请直接回复你希望 Codex 完成的事情。\n\n收到第一条任务描述后，本地 Codex 会创建新任务并开始执行。")
    ]);
  }

  waitingForPromptCard(project: { name: string; rootPath: string }): FeishuCard {
    const elements = [
      text(`项目：${project.name}\n状态：等待任务描述\n目录：${project.rootPath}\n\n请直接回复你希望 Codex 完成的事情。`)
    ] as Record<string, unknown>[];
    pushMaybe(elements, maybeActions(this.interactionMode, [button("设置", "task_settings"), button("取消", "task_archive")]));
    if (this.interactionMode === "message_command") {
      elements.push(commandText(["直接回复任务描述", "/projects", "/doctor"]));
    }
    return card("新任务", elements);
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
            })
          ]
        : [
            button("在飞书继续", "claim_thread", { codexThreadId: thread.id }),
            button("查看摘要", "claim_summary", { codexThreadId: thread.id }),
            button("忽略", "claim_ignore", { codexThreadId: thread.id })
          ];
      pushActionRows(elements, this.interactionMode, actionsForThread);
    }
    return card("电脑上的 Codex 任务", elements.length > 0 ? elements : [text("没有发现可接管的本机 Codex 任务。")]);
  }

  codexOnlyCompletionCard(thread: {
    id: string;
    title: string;
    status: string;
    cwd: string | null;
    projectName?: string | null;
    updatedAt?: number | null;
    summary?: string | null;
  }): FeishuCard {
    const lines = [
      thread.projectName ? kvLine("项目", thread.projectName) : null,
      kvLine("任务", thread.title),
      kvLine("状态", statusText(thread.status)),
      thread.cwd ? kvLine("工作目录", thread.cwd) : null,
      thread.updatedAt ? kvLine("结束时间", formatTime(new Date(thread.updatedAt).toISOString())) : null,
      thread.summary ? `\n**摘要**\n\n${thread.summary}` : null
    ].filter(Boolean);
    const elements: Record<string, unknown>[] = [text(lines.join("\n"))];
    pushActionRows(elements, this.interactionMode, [
      button("在飞书继续", "claim_thread", { codexThreadId: thread.id }),
      button("查看摘要", "claim_summary", { codexThreadId: thread.id }),
      button("忽略", "claim_ignore", { codexThreadId: thread.id })
    ]);
    if (this.interactionMode === "message_command") {
      elements.push(commandText([`/claim ${thread.id}`, `/claim summary ${thread.id}`, `/claim ignore ${thread.id}`]));
    }
    return card(codexOnlyCompletionTitle(thread.status), elements);
  }

  projectListCard(
    projects: Array<{ id: string; name: string; rootPath: string; feishuChatId: string | null }>,
    options: { pendingPromptId?: string | null } = {}
  ): FeishuCard {
    if (projects.length === 0) return card("选择项目", [text("还没有发现 Codex Desktop 工作区。请先在 Codex Desktop 打开一个项目。")]);
    const elements: Record<string, unknown>[] = [
      text(options.pendingPromptId ? "选择项目后，会用刚才那条需求创建任务会话。" : "选择一个项目后，可以查看这个项目里的对话、运行状态和项目设置。")
    ];
    for (const project of projects.slice(0, 12)) {
      elements.push(text([`项目：${project.name}`, `目录：${project.rootPath}`].join("\n")));
      pushActionRows(elements, this.interactionMode, [
        button(options.pendingPromptId ? "开始" : "进入", options.pendingPromptId ? "project_start_prompt" : "project_open", {
          projectId: project.id,
          pendingPromptId: options.pendingPromptId
        }),
        button("设置", "project_settings", { projectId: project.id })
      ]);
    }
    return card("选择项目", elements);
  }

  projectCard(project: {
    id: string;
    name: string;
    rootPath: string;
    runningCount: number;
    pendingApprovals: number;
    completedCount: number;
    defaultModel: string;
    defaultReasoningEffort: string;
  }): FeishuCard {
    const elements = [
      text(
        [
          kvLine("路径", project.rootPath),
          kvLine("运行中", String(project.runningCount)),
          kvLine("待确认", String(project.pendingApprovals)),
          kvLine("最近完成", String(project.completedCount)),
          kvLine("默认模型", project.defaultModel),
          kvLine("默认思考", project.defaultReasoningEffort)
        ].join("\n")
      )
    ] as Record<string, unknown>[];
    pushActionRows(
      elements,
      this.interactionMode,
      [
        button("新任务", "new_task", { projectId: project.id }),
        button("对话", "project_tasks", { projectId: project.id }),
        button("运行中", "project_running", { projectId: project.id }),
        button("设置", "project_settings", { projectId: project.id })
      ]
    );
    pushActionRows(
      elements,
      this.interactionMode,
      [
        button("已完成", "project_completed", { projectId: project.id }),
        button("接管", "claim_sessions", { projectId: project.id }),
        button("未归类", "unclassified_threads", { projectId: project.id }),
        button("返回项目", "project_list")
      ]
    );
    return card(project.name, elements);
  }

  taskStatusCard(projection: TaskStatusProjection): FeishuCard {
    const summaryItems = [
      kvLine("状态", statusText(projection.status)),
      kvLine("项目", projection.projectName),
      projection.selectedModel ? kvLine("模型", projection.selectedModel) : null,
      projection.selectedReasoningEffort ? kvLine("思考", projection.selectedReasoningEffort) : null,
      projection.subAgents.length > 0 ? kvLine("子 Agent", `${projection.subAgents.length} 个`) : null,
      projection.queuedMessages > 0 ? kvLine("队列", `${projection.queuedMessages} 条后续要求`) : null,
      projection.pendingApprovals > 0 ? kvLine("待确认", `${projection.pendingApprovals} 项`) : null
    ].filter(Boolean) as string[];
    const elements: Record<string, unknown>[] = [text(summaryItems.join("\n"))];
    if (projection.subAgents.length > 0) {
      elements.push(divider());
      elements.push(sectionBlock("子 Agent", formatSubAgents(projection.subAgents)));
    }
    if (projection.lastSummary) {
      elements.push(divider());
      elements.push(sectionBlock("当前结论", projection.lastSummary));
    }
    elements.push(divider());
    elements.push(tipBlock(commandHintForStatus(projection.status)));
    pushActionRows(
      elements,
      this.interactionMode,
      taskButtons(projection.status).map(([label, action]) => button(label, action, { bindingId: projection.bindingId }))
    );
    if (projection.status !== "waiting_for_prompt") {
      pushActionRows(elements, this.interactionMode, [
        button("本次影响", "task_impact", { bindingId: projection.bindingId }),
        button("详情", "task_detail", { bindingId: projection.bindingId }),
        button("设置", "task_settings", { bindingId: projection.bindingId })
      ]);
      if (this.interactionMode === "message_command") {
        elements.push(commandText(["/impact", "/detail"]));
      }
    }
    return card(projection.title, elements);
  }

  taskProgressCard(projection: TaskProgressProjection): FeishuCard {
    const elements: Record<string, unknown>[] = [text(taskMetaLines(projection.status, projection.projectName, projection.updatedAt).join("\n"))];
    if (projection.subAgents && projection.subAgents.length > 0) {
      elements.push(divider());
      elements.push(sectionBlock("子 Agent", formatSubAgents(projection.subAgents, 3)));
    }
    for (const section of projection.sections.slice(0, 4)) {
      elements.push(divider());
      elements.push(sectionBlock(section.label, section.text));
    }
    return card(`${projection.title}｜处理进度`, elements);
  }

  taskReportCard(projection: TaskReportProjection): FeishuCard {
    const elements: Record<string, unknown>[] = [text(taskMetaLines(projection.status, projection.projectName, projection.updatedAt, "完成时间").join("\n"))];
    if (projection.highlights && projection.highlights.length > 0) {
      elements.push(divider());
      elements.push(sectionBlock("关键信息", projection.highlights.map((item, index) => `${index + 1}. ${item}`).join("\n")));
    }
    if (projection.changeItems && projection.changeItems.length > 0) {
      elements.push(divider());
      elements.push(sectionBlock("本次改动", projection.changeItems.map((item, index) => `${index + 1}. ${item}`).join("\n")));
    }
    if (projection.verificationItems && projection.verificationItems.length > 0) {
      elements.push(divider());
      elements.push(sectionBlock("验证情况", projection.verificationItems.map((item, index) => `${index + 1}. ${item}`).join("\n")));
    }
    if (projection.subAgents && projection.subAgents.length > 0) {
      elements.push(divider());
      elements.push(sectionBlock("子 Agent", formatSubAgents(projection.subAgents)));
    }
    if (projection.reasoningSummary) {
      elements.push(divider());
      pushMarkdownSections(elements, "处理摘要", projection.reasoningSummary, { maxChunkLength: 1800, maxSections: 2 });
    }
    const finalResult = projection.fullFinalResult ?? projection.finalResult;
    if (finalResult) {
      const finalChunks = splitTaskReportFinalResult(finalResult);
      elements.push(divider());
      pushMarkdownChunks(elements, "最终结论", finalChunks.slice(0, TASK_REPORT_MAIN_FINAL_CHUNKS));
      if (finalChunks.length > TASK_REPORT_MAIN_FINAL_CHUNKS) {
        elements.push(divider());
        elements.push(tipBlock(this.shouldSendTaskReportFullText(projection) ? "最终结论很长，系统会先补充卡片，再补发完整文本。" : "最终结论较长，系统会继续补充卡片。"));
      }
    }
    if (projection.nextSteps && projection.nextSteps.length > 0) {
      elements.push(divider());
      elements.push(sectionBlock("建议后续", projection.nextSteps.map((item, index) => `${index + 1}. ${item}`).join("\n")));
    }
    if (!projection.reasoningSummary && !finalResult) {
      elements.push(divider());
      elements.push(tipBlock("未提取到可展示的结果内容，请发送 /logs 查看本地任务记录。"));
    }
    return card(`${projection.title}｜处理完成`, elements);
  }

  taskReportSupplementCards(projection: TaskReportProjection): FeishuCard[] {
    const finalResult = projection.fullFinalResult ?? projection.finalResult;
    if (!finalResult) return [];
    const overflow = splitTaskReportFinalResult(finalResult).slice(TASK_REPORT_MAIN_FINAL_CHUNKS);
    if (overflow.length === 0) return [];
    const groups = groupChunks(overflow, TASK_REPORT_SUPPLEMENT_CHUNKS_PER_CARD).slice(0, TASK_REPORT_MAX_SUPPLEMENT_CARDS);
    return groups.map((chunks, index) => {
      const elements: Record<string, unknown>[] = [
        text(taskMetaLines(projection.status, projection.projectName, projection.updatedAt, "完成时间").join("\n"))
      ];
      pushMarkdownChunks(elements, `最终结论补充 ${index + 1}`, chunks);
      if (index === groups.length - 1 && this.shouldSendTaskReportFullText(projection)) {
        elements.push(divider());
        elements.push(tipBlock("剩余内容仍较长，系统会补发完整文本。"));
      }
      return card(`${projection.title}｜最终结论补充 ${index + 1}/${groups.length}`, elements);
    });
  }

  shouldSendTaskReportFullText(projection: TaskReportProjection): boolean {
    const finalResult = projection.fullFinalResult ?? projection.finalResult;
    if (!finalResult) return false;
    return splitTaskReportFinalResult(finalResult).length > TASK_REPORT_TOTAL_CARD_FINAL_CHUNKS;
  }

  taskProcessCard(projection: TaskProcessProjection): FeishuCard {
    const elements: Record<string, unknown>[] = [text(taskMetaLines(projection.status, projection.projectName, projection.updatedAt).join("\n"))];
    if (projection.subAgents && projection.subAgents.length > 0) {
      elements.push(divider());
      elements.push(sectionBlock("子 Agent", formatSubAgents(projection.subAgents)));
    }
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

  taskImpactCard(input: {
    bindingId: string;
    title: string;
    impact: WorkspaceImpactSummary | null;
    startCheckpoint: WorkspaceCheckpoint | null;
    endCheckpoint: WorkspaceCheckpoint | null;
    detailUrl?: string | null;
  }): FeishuCard {
    const elements: Record<string, unknown>[] = [
      sectionBlock("本次影响", formatImpactSummary(input.impact)),
      divider(),
      text(
        [
          input.startCheckpoint ? kvLine("开始检查点", formatTime(input.startCheckpoint.createdAt)) : "开始检查点：暂无",
          input.endCheckpoint ? kvLine("结束检查点", formatTime(input.endCheckpoint.createdAt)) : "结束检查点：暂无",
          input.detailUrl ? kvLine("本地详情", input.detailUrl) : null
        ]
          .filter(Boolean)
          .join("\n")
      )
    ];
    pushActionRows(elements, this.interactionMode, [button("处理记录", "task_logs", { bindingId: input.bindingId })]);
    if (input.impact && (input.impact.added.length > 0 || input.impact.modified.length > 0 || input.impact.deleted.length > 0)) {
      pushActionRows(elements, this.interactionMode, [button("撤销本次继续", "task_restore_confirm", { bindingId: input.bindingId })]);
    }
    return card(`${input.title}｜本次影响`, elements);
  }

  taskRestoreConfirmCard(input: {
    bindingId: string;
    title: string;
    impact: WorkspaceImpactSummary | null;
  }): FeishuCard {
    const elements: Record<string, unknown>[] = [
      sectionBlock(
        "撤销确认",
        [
          "将按检查点恢复已完整保存的小文本文件，并删除本次新增的小文本文件。",
          "大文件、二进制文件、未完整保存的文件不会自动修改。"
        ].join("\n")
      ),
      divider(),
      sectionBlock("影响范围", formatImpactSummary(input.impact))
    ];
    pushActionRows(elements, this.interactionMode, [
      button("确认撤销", "task_restore_apply", { bindingId: input.bindingId }),
      button("取消", "task_impact", { bindingId: input.bindingId })
    ]);
    return card(`${input.title}｜撤销本次继续`, elements);
  }

  taskRestoreResultCard(input: {
    title: string;
    result: WorkspaceRestoreSummary;
  }): FeishuCard {
    return card(`${input.title}｜撤销结果`, [
      sectionBlock(
        "已处理",
        [
          `恢复 ${input.result.restored.length} 个文件`,
          `删除新增 ${input.result.removedAdded.length} 个文件`,
          `跳过 ${input.result.skipped.length} 个文件`
        ].join("\n")
      ),
      divider(),
      sectionBlock("恢复文件", formatImpactGroup("恢复", input.result.restored) ?? "无"),
      sectionBlock("删除新增", formatImpactGroup("删除", input.result.removedAdded) ?? "无"),
      input.result.skipped.length > 0
        ? sectionBlock(
            "跳过",
            input.result.skipped
              .slice(0, 8)
              .map((item) => `- ${item.path}：${item.reason}`)
              .join("\n")
          )
        : tipBlock("未跳过文件。")
    ]);
  }

  taskSearchCard(input: {
    query: string;
    tasks: Array<{
      bindingId: string;
      title: string;
      status: string;
      projectName: string;
      updatedAt: string;
    }>;
  }): FeishuCard {
    if (input.tasks.length === 0) {
      return card("任务搜索", [text(`没有找到与“${input.query}”相关的任务。`)]);
    }
    const elements: Record<string, unknown>[] = [text(`关键词：${input.query}`)];
    for (const task of input.tasks.slice(0, 10)) {
      elements.push(
        text(
          [
            `任务：${task.title}`,
            `状态：${statusText(task.status)}`,
            `项目：${task.projectName}`,
            `更新时间：${formatTime(task.updatedAt)}`
          ].join("\n")
        )
      );
      pushActionRows(elements, this.interactionMode, [
        button("状态", "task_status", { bindingId: task.bindingId }),
        button("记录", "task_logs", { bindingId: task.bindingId }),
        button("影响", "task_impact", { bindingId: task.bindingId }),
        button("详情", "task_detail", { bindingId: task.bindingId })
      ]);
    }
    return card("任务搜索", elements);
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
    pushActionRows(elements, this.interactionMode, buttons);
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

  pendingServerRequestListCard(requests: Array<{ title: string; requestId: string; createdAt: string; detail: string }>): FeishuCard {
    if (requests.length === 0) return card("待处理请求", [text("当前没有待处理请求。")]);
    const elements: Record<string, unknown>[] = [];
    for (const request of requests.slice(0, 10)) {
      elements.push(
        text(
          [
            `类型：${request.title}`,
            `请求：${request.requestId}`,
            request.detail,
            `时间：${request.createdAt}`,
            `命令：/request detail ${request.requestId}`
          ]
            .filter(Boolean)
            .join("\n")
        )
      );
      pushMaybe(elements, maybeActions(this.interactionMode, [button("查看详情", "server_request_detail", { requestId: request.requestId })]));
    }
    return card("待处理请求", elements);
  }

  serverRequestCard(input: {
    title: string;
    body: string;
    buttons?: Array<{
      label: string;
      action: string;
      payload?: Record<string, unknown>;
    }>;
    form?: {
      submitLabel?: string;
      fields: Array<{
        name: string;
        label: string;
        kind: "text" | "textarea" | "select" | "multi_select" | "boolean" | "number";
        required?: boolean;
        secret?: boolean;
        placeholder?: string;
        value?: string;
        options?: Array<{ label: string; value: string }>;
      }>;
      submitPayload?: Record<string, unknown>;
    };
    commands?: string[];
  }): FeishuCard {
    const elements: Record<string, unknown>[] = [text(input.body)];
    if (input.form && input.form.fields.length > 0) {
      elements.push(divider());
      for (const field of input.form.fields.slice(0, 12)) {
        pushMaybe(elements, renderServerRequestFormField(field));
      }
      pushActionRows(
        elements,
        this.interactionMode,
        [
          button(input.form.submitLabel ?? "提交", "server_request_resolve", {
            ...(input.form.submitPayload ?? {}),
            resolution: "submit_form"
          })
        ]
      );
    }
    if (input.buttons && input.buttons.length > 0) {
      pushActionRows(
        elements,
        this.interactionMode,
        input.buttons.map((item) => button(item.label, item.action, item.payload ?? {}))
      );
    }
    if (input.commands && input.commands.length > 0) {
      elements.push(divider());
      elements.push(commandText(input.commands));
    }
    return card(input.title, elements);
  }

  serverRequestDetailCard(input: {
    title: string;
    body: string;
    commands?: string[];
  }): FeishuCard {
    const elements: Record<string, unknown>[] = [text(input.body)];
    if (input.commands && input.commands.length > 0) {
      elements.push(divider());
      elements.push(commandText(input.commands));
    }
    return card(input.title, elements);
  }

  taskDetailCard(input: {
    bindingId: string;
    title: string;
    status: string;
    projectName: string;
    cwd: string | null;
    model: string | null;
    reasoningEffort: string | null;
    subAgents?: TaskSubAgentProjection[];
    queuedMessages: number;
    pendingApprovals: number;
    checkpoints: number;
    updatedAt: string;
    lastSummary: string | null;
    detailUrl?: string | null;
  }): FeishuCard {
    const elements: Record<string, unknown>[] = [
      text(
        [
          kvLine("状态", statusText(input.status)),
          kvLine("项目", input.projectName),
          input.cwd ? kvLine("目录", input.cwd) : null,
          input.model ? kvLine("模型", input.model) : null,
          input.reasoningEffort ? kvLine("思考", input.reasoningEffort) : null,
          input.subAgents && input.subAgents.length > 0 ? kvLine("子 Agent", `${input.subAgents.length} 个`) : null,
          kvLine("队列", `${input.queuedMessages} 条`),
          kvLine("待确认", `${input.pendingApprovals} 项`),
          kvLine("检查点", `${input.checkpoints} 个`),
          kvLine("更新时间", formatTime(input.updatedAt)),
          input.detailUrl ? kvLine("本地详情", input.detailUrl) : null
        ]
          .filter(Boolean)
          .join("\n")
      )
    ];
    if (input.lastSummary) {
      elements.push(divider());
      elements.push(sectionBlock("当前结论", input.lastSummary));
    }
    if (input.subAgents && input.subAgents.length > 0) {
      elements.push(divider());
      elements.push(sectionBlock("子 Agent", formatSubAgents(input.subAgents)));
    }
    pushActionRows(elements, this.interactionMode, [
      button("继续", "task_continue", { bindingId: input.bindingId }),
      button("处理记录", "task_logs", { bindingId: input.bindingId }),
      button("本次影响", "task_impact", { bindingId: input.bindingId }),
      button("设置", "task_settings", { bindingId: input.bindingId })
    ]);
    return card(`${input.title}｜详情`, elements);
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
      pushActionRows(elements, this.interactionMode, [
        button("在飞书继续", "claim_thread", { codexThreadId: thread.id }),
        button("查看摘要", "claim_summary", { codexThreadId: thread.id })
      ]);
      pushActionRows(elements, this.interactionMode, [
        ...(thread.canCreateProject ? [button("创建为新项目", "unclassified_create_project", { codexThreadId: thread.id })] : []),
        button("归入已有项目", "unclassified_pick_project", { codexThreadId: thread.id }),
        button("忽略", "claim_ignore", { codexThreadId: thread.id })
      ]);
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
    const trustedPreview =
      snapshot.trustedSubjects.length > 0
        ? snapshot.trustedSubjects
            .slice(0, 3)
            .map((subject) => `${subject.role}:${subject.chatId ?? subject.userId ?? subject.id}`)
            .join(" / ")
        : "暂无";
    const elements = [
      text(
        [
          `电脑：${snapshot.machineName}`,
          `Codex：${snapshot.codexAvailable ? "可用" : "不可用"}`,
          `Desktop运行时：${snapshot.appServerStatus}`,
          `Codex连接：${codexConnectionText(snapshot.codexConnectionMode, snapshot.codexConnectionKind)}`,
          snapshot.codexDesktopIpc
            ? `Desktop IPC：${snapshot.codexDesktopIpc.pipePath} / ${snapshot.codexDesktopIpc.status} / ${snapshot.codexDesktopIpc.observedThreads} 个线程`
            : null,
          `飞书配置：${snapshot.feishuConfigured ? "已配置" : "未完整配置"}`,
          `消息接入：${snapshot.feishuMessageTransport === "long_connection" ? "长连接" : "HTTP 回调"}`,
          `卡片回调：${snapshot.feishuCardActionTransport === "long_connection" ? "长连接" : "HTTP 回调"}`,
          `交互模式：${interactionModeText(snapshot.feishuInteractionMode)}`,
          `任务承载：${snapshot.feishuTaskContainerMode === "dedicated_chat" ? "一任务一独立会话" : "主控群内话题"}`,
          `默认群：${chatDiagnosticText(snapshot)}`,
          `运行中任务：${snapshot.runningTasksCount}`,
          `待确认：${snapshot.pendingApprovalsCount}`,
          `待发送通知：${snapshot.pendingOutboxCount}`,
          `通知设置：${snapshot.notificationPreferenceCount}`,
          `设备登记：${snapshot.bridgeDevicesCount}`,
          `已信任对象：${snapshot.trustedSubjectsCount}`,
          `当前设备：${snapshot.currentDevice ? `${snapshot.currentDevice.machineName} (${snapshot.currentDevice.status})` : "未登记"}`,
          `最近信任对象：${trustedPreview}`,
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
      maybeActions(this.interactionMode, [button("恢复连接", "diagnostic_recover"), button("发送测试通知", "send_test_notification")]),
      maybeActions(this.interactionMode, [button("通知历史", "notification_history"), button("通知设置", "notification_settings_global")])
    ].filter(Boolean) as Record<string, unknown>[];
    return card("Bridge 诊断", elements);
  }

  taskListCard(
    title: string,
    tasks: Array<{
      bindingId: string;
      title: string;
      status: string;
      projectName: string;
      model?: string | null;
      reasoningEffort?: string | null;
    }>
  ): FeishuCard {
    if (tasks.length === 0) return card(title, [text("当前没有可展示的任务。")]);
    const elements: Record<string, unknown>[] = [];
    for (const task of tasks.slice(0, 10)) {
      elements.push(
        text(
          [
            `任务：${task.title}`,
            `状态：${statusText(task.status)}`,
            `项目：${task.projectName}`,
            task.model ? `模型：${task.model}` : null,
            task.reasoningEffort ? `思考：${task.reasoningEffort}` : null
          ]
            .filter(Boolean)
            .join("\n")
        )
      );
      pushActionRows(
        elements,
        this.interactionMode,
        [
          button("状态", "task_status", { bindingId: task.bindingId }),
          button("记录", "task_logs", { bindingId: task.bindingId }),
          button("设置", "task_settings", { bindingId: task.bindingId })
        ]
      );
    }
    return card(title, elements);
  }

  archivedTaskCenterCard(tasks: Array<{
    bindingId: string;
    title: string;
    projectName: string;
    status: string;
    updatedAt: string;
  }>): FeishuCard {
    if (tasks.length === 0) return card("归档任务", [text("当前没有已归档任务。")]);
    const elements: Record<string, unknown>[] = [];
    for (const task of tasks.slice(0, 10)) {
      elements.push(
        text(
          [
            `任务：${task.title}`,
            `项目：${task.projectName}`,
            `状态：${statusText(task.status)}`,
            `更新时间：${task.updatedAt}`
        ].filter(Boolean).join("\n")
      )
    );
      pushActionRows(
        elements,
        this.interactionMode,
        [
          button("恢复", "task_unarchive", { bindingId: task.bindingId }),
          button("状态", "task_status", { bindingId: task.bindingId }),
          button("记录", "task_logs", { bindingId: task.bindingId })
        ]
      );
    }
    return card("归档任务", elements);
  }

  taskSettingsCard(input: {
    bindingId: string;
    title: string;
    projectName: string;
    currentModel: string;
    currentReasoningEffort: string;
    currentNotificationLevel: NotificationLevel;
    modelOptions: string[];
    reasoningOptions: string[];
  }): FeishuCard {
    const elements: Record<string, unknown>[] = [
      text(
        [
          `任务：${input.title}`,
          `项目：${input.projectName}`,
          `当前模型：${input.currentModel}`,
          `当前思考：${input.currentReasoningEffort}`,
          `通知级别：${notificationLevelText(input.currentNotificationLevel)}`
        ].join("\n")
      ),
      divider(),
      sectionBlock("切换模型", input.modelOptions.slice(0, 8).join(" / ")),
      ...actionRows(
        this.interactionMode,
        input.modelOptions.slice(0, 4).map((model) =>
          button(modelLabel(model), "task_setting_model", { bindingId: input.bindingId, model })
        )
      ),
      divider(),
      sectionBlock("切换思考强度", input.reasoningOptions.slice(0, 8).join(" / ")),
      ...actionRows(
        this.interactionMode,
        input.reasoningOptions.slice(0, 4).map((effort) =>
          button(reasoningLabel(effort), "task_setting_reasoning", { bindingId: input.bindingId, reasoningEffort: effort })
        )
      ),
      divider(),
      sectionBlock("通知偏好", "只影响主动推送，不影响当前任务状态卡刷新。"),
      ...actionRows(
        this.interactionMode,
        (["all", "important", "errors", "muted"] as NotificationLevel[]).map((level) =>
          button(notificationLevelButton(level), "notification_level_set", {
            scopeType: "session",
            scopeId: input.bindingId,
            level
          })
        )
      )
    ].filter(Boolean) as Record<string, unknown>[];
    return card("任务设置", elements);
  }

  projectSettingsCard(input: {
    projectId: string;
    projectName: string;
    rootPath: string;
    currentModel: string;
    currentReasoningEffort: string;
    currentNotificationLevel: string;
    modelOptions: string[];
    reasoningOptions: string[];
  }): FeishuCard {
    const elements: Record<string, unknown>[] = [
      text(
        [
          `项目：${input.projectName}`,
          `目录：${input.rootPath}`,
          `默认模型：${input.currentModel}`,
          `默认思考：${input.currentReasoningEffort}`,
          `通知级别：${notificationLevelText(input.currentNotificationLevel)}`
        ].join("\n")
      ),
      divider(),
      sectionBlock("切换默认模型", input.modelOptions.slice(0, 8).join(" / ")),
      ...actionRows(
        this.interactionMode,
        input.modelOptions.slice(0, 4).map((model) =>
          button(modelLabel(model), "project_setting_model", { projectId: input.projectId, model })
        )
      ),
      divider(),
      sectionBlock("切换默认思考强度", input.reasoningOptions.slice(0, 8).join(" / ")),
      ...actionRows(
        this.interactionMode,
        input.reasoningOptions.slice(0, 4).map((effort) =>
          button(reasoningLabel(effort), "project_setting_reasoning", {
            projectId: input.projectId,
            reasoningEffort: effort
          })
        )
      ),
      divider(),
      sectionBlock("通知偏好", "只影响主动推送，不影响任务状态卡刷新。"),
      ...actionRows(
        this.interactionMode,
        (["all", "important", "errors", "muted"] as NotificationLevel[]).map((level) =>
          button(notificationLevelButton(level), "project_notification_level", {
            projectId: input.projectId,
            level
          })
        )
      )
    ].filter(Boolean) as Record<string, unknown>[];
    return card("项目设置", elements);
  }

  notificationSettingsCard(input: {
    title: string;
    scopeType: "global" | "project" | "session";
    scopeId: string;
    currentLevel: NotificationLevel;
    description: string;
  }): FeishuCard {
    const elements: Record<string, unknown>[] = [
      text([input.description, `当前级别：${notificationLevelText(input.currentLevel)}`].join("\n\n")),
      ...actionRows(
        this.interactionMode,
        (["all", "important", "errors", "muted"] as NotificationLevel[]).map((level) =>
          button(notificationLevelButton(level), "notification_level_set", {
            scopeType: input.scopeType,
            scopeId: input.scopeId,
            level
          })
        )
      )
    ];
    return card(input.title, elements);
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

const TASK_REPORT_FINAL_CHUNK_LENGTH = 2200;
const TASK_REPORT_MAIN_FINAL_CHUNKS = 2;
const TASK_REPORT_SUPPLEMENT_CHUNKS_PER_CARD = 3;
const TASK_REPORT_MAX_SUPPLEMENT_CARDS = 4;
const TASK_REPORT_TOTAL_CARD_FINAL_CHUNKS =
  TASK_REPORT_MAIN_FINAL_CHUNKS + TASK_REPORT_SUPPLEMENT_CHUNKS_PER_CARD * TASK_REPORT_MAX_SUPPLEMENT_CARDS;

const kvLine = (label: string, value: string): string => `**${label}**  ${value}`;

const sectionBlock = (title: string, body: string): Record<string, unknown> =>
  text(`**${title}**\n\n${body}`);

// Keep report Markdown readable by splitting on natural paragraph and line boundaries before Feishu truncates a block.
const pushMarkdownSections = (
  elements: Record<string, unknown>[],
  title: string,
  body: string,
  options: { maxChunkLength: number; maxSections: number }
): void => {
  const chunks = splitMarkdownForCard(body, options.maxChunkLength).slice(0, options.maxSections);
  chunks.forEach((chunk, index) => {
    elements.push(sectionBlock(index === 0 ? title : `${title}（续 ${index + 1}）`, chunk));
    if (index < chunks.length - 1) elements.push(divider());
  });
};

const splitTaskReportFinalResult = (body: string): string[] =>
  splitMarkdownForCard(body, TASK_REPORT_FINAL_CHUNK_LENGTH);

const pushMarkdownChunks = (
  elements: Record<string, unknown>[],
  title: string,
  chunks: string[]
): void => {
  chunks.forEach((chunk, index) => {
    if (index > 0) elements.push(divider());
    elements.push(sectionBlock(index === 0 ? title : `${title}（续 ${index + 1}）`, chunk));
  });
};

const groupChunks = <T>(items: T[], size: number): T[][] => {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
};

const splitMarkdownForCard = (body: string, maxChunkLength: number): string[] => {
  const normalized = body.replace(/\r\n?/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
  if (!normalized) return [];
  if (normalized.length <= maxChunkLength) return [normalized];
  const blocks = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (trimmed.length > maxChunkLength) {
      if (current) {
        chunks.push(current.trim());
        current = "";
      }
      chunks.push(...splitLongMarkdownBlock(trimmed, maxChunkLength));
      continue;
    }
    const candidate = current ? `${current}\n\n${trimmed}` : trimmed;
    if (candidate.length > maxChunkLength) {
      if (current) chunks.push(current.trim());
      current = trimmed;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks;
};

const splitLongMarkdownBlock = (block: string, maxChunkLength: number): string[] => {
  const lines = block.split("\n");
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxChunkLength && current) {
      chunks.push(current.trim());
      current = line;
      continue;
    }
    if (candidate.length > maxChunkLength) {
      chunks.push(...hardSplitMarkdown(line, maxChunkLength));
      current = "";
      continue;
    }
    current = candidate;
  }
  if (current) chunks.push(current.trim());
  return chunks;
};

const hardSplitMarkdown = (value: string, maxChunkLength: number): string[] => {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    const next = value.slice(offset, offset + maxChunkLength);
    chunks.push(next.trim());
    offset += maxChunkLength;
  }
  return chunks.filter(Boolean);
};

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
  columns: items.slice(0, 2).map((item) => ({
    tag: "column",
    width: "weighted",
    weight: 1,
    vertical_align: "top",
    elements: [item]
  }))
});

const maybeActions = (mode: InteractionMode, items: Record<string, unknown>[]): Record<string, unknown> | null =>
  mode === "message_command" ? null : actions(items);

const actionRows = (mode: InteractionMode, items: Record<string, unknown>[]): Record<string, unknown>[] => {
  if (mode === "message_command") return [];
  const rows: Record<string, unknown>[] = [];
  for (let index = 0; index < items.length; index += 2) {
    rows.push(actions(items.slice(index, index + 2)));
  }
  return rows;
};

const pushMaybe = (elements: Record<string, unknown>[], element: Record<string, unknown> | null): void => {
  if (element) elements.push(element);
};

const pushActionRows = (elements: Record<string, unknown>[], mode: InteractionMode, items: Record<string, unknown>[]): void => {
  for (const row of actionRows(mode, items)) {
    elements.push(row);
  }
};

const commandText = (commands: string[]): Record<string, unknown> =>
  text(`可直接发送命令：\n${commands.map((command) => `- ${command}`).join("\n")}`);

const renderServerRequestFormField = (field: {
  name: string;
  label: string;
  kind: "text" | "textarea" | "select" | "multi_select" | "boolean" | "number";
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
  value?: string;
  options?: Array<{ label: string; value: string }>;
}): Record<string, unknown> | null => {
  const title = `${field.label}${field.required ? " *" : ""}`;
  const hint = field.secret ? "提交后会按保密字段处理。" : null;
  const labelBlock = text([`**${title}**`, hint].filter(Boolean).join("\n"));
  const componentId = field.name;
  const placeholder = field.placeholder ?? field.label;
  switch (field.kind) {
    case "text":
    case "number":
      return {
        tag: "column_set",
        horizontal_align: "left",
        columns: [
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            elements: [
              labelBlock,
              {
                tag: "input",
                name: componentId,
                component_id: componentId,
                placeholder: { tag: "plain_text", content: placeholder },
                default_value: field.value ?? ""
              }
            ]
          }
        ]
      };
    case "textarea":
      return {
        tag: "column_set",
        horizontal_align: "left",
        columns: [
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            elements: [
              labelBlock,
              {
                tag: "textarea",
                name: componentId,
                component_id: componentId,
                placeholder: { tag: "plain_text", content: placeholder },
                default_value: field.value ?? ""
              }
            ]
          }
        ]
      };
    case "select":
      return {
        tag: "column_set",
        horizontal_align: "left",
        columns: [
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            elements: [
              labelBlock,
              {
                tag: "select_static",
                name: componentId,
                component_id: componentId,
                placeholder: { tag: "plain_text", content: placeholder },
                initial_option: field.value ?? undefined,
                options: (field.options ?? []).slice(0, 50).map((option) => ({
                  text: { tag: "plain_text", content: option.label },
                  value: option.value
                }))
              }
            ]
          }
        ]
      };
    case "multi_select":
      return sectionBlock(
        title,
        [
          hint,
          "飞书多选表单控件在当前桥接里先回落为文本输入，请用逗号分隔多个值。",
          field.options && field.options.length > 0
            ? `可选：${field.options.map((option) => option.label).join(" / ")}`
            : null
        ]
          .filter(Boolean)
          .join("\n")
      );
    case "boolean":
      return {
        tag: "column_set",
        horizontal_align: "left",
        columns: [
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            elements: [
              labelBlock,
              {
                tag: "select_static",
                name: componentId,
                component_id: componentId,
                placeholder: { tag: "plain_text", content: placeholder },
                initial_option: field.value ?? undefined,
                options: [
                  { text: { tag: "plain_text", content: "是" }, value: "true" },
                  { text: { tag: "plain_text", content: "否" }, value: "false" }
                ]
              }
            ]
          }
        ]
      };
    default:
      return null;
  }
};

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
    case "waiting_for_prompt":
      return [
        ["设置", "task_settings"],
        ["取消", "task_archive"]
      ];
    case "running":
      return [
        ["进度", "task_status"],
        ["追加", "task_append_hint"],
        ["队列", "queue_view"],
        ["停止", "task_stop"]
      ];
    case "waiting_for_approval":
      return [
        ["待确认", "approval_list"],
        ["停止", "task_stop"]
      ];
    case "completed":
      return [
        ["记录", "task_logs"],
        ["继续", "task_continue"],
        ["相关任务", "new_related_task"],
        ["归档", "task_archive"]
      ];
    case "failed":
      return [
        ["重试", "task_retry"],
        ["分析", "task_analyze_failure"],
        ["记录", "task_logs"],
        ["停止", "task_stop"]
      ];
    default:
      return [
        ["继续", "task_continue"],
        ["测试", "task_run_tests"],
        ["记录", "task_logs"],
        ["归档", "task_archive"]
      ];
  }
};

const commandHintForStatus = (status: string): string => {
  switch (status) {
    case "waiting_for_prompt":
      return "先设置模型，或直接回复任务描述；需要时可用 /settings、/archive";
    case "running":
      return "直接回复即可继续补充；需要时可用 /status、/queue、/stop";
    case "waiting_for_approval":
      return "先处理待确认；需要时可用 /approval list、/logs、/stop";
    case "completed":
      return "直接回复即可继续处理；需要时可用 /logs、/archive";
    case "failed":
      return "优先重试或分析；需要时可用 /retry、/analyze-failure、/logs、/stop";
    default:
      return "直接回复即可继续处理；需要时可用 /status、/run-tests、/logs、/archive";
  }
};

const modelLabel = (model: string): string =>
  model.replace(/^gpt-/, "").replace(/^o/, "o").trim();

const reasoningLabel = (effort: string): string =>
  ({
    minimal: "极低",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "极高"
  })[effort] ?? effort;

const notificationLevelText = (level: string): string =>
  ({
    all: "全部通知",
    important: "重要通知",
    errors: "仅失败/异常",
    muted: "静音"
  })[level] ?? level;

const notificationLevelButton = (level: NotificationLevel): string =>
  ({
    all: "全部",
    important: "重要",
    errors: "异常",
    muted: "静音"
  })[level];

const formatRecentTasks = (
  tasks: Array<{
    title: string;
    status: string;
    projectName?: string | null;
    model?: string | null;
    reasoningEffort?: string | null;
  }>
): string =>
  tasks
    .slice(0, 5)
    .map((task, index) =>
      [
        `${index + 1}. ${task.title}`,
        `${statusText(task.status)}${task.projectName ? ` · ${task.projectName}` : ""}${task.model ? ` · ${task.model}` : ""}${task.reasoningEffort ? ` · ${task.reasoningEffort}` : ""}`
      ].join("\n")
    )
    .join("\n\n");

const formatSubAgents = (subAgents: TaskSubAgentProjection[], limit = 4): string => {
  const visible = subAgents.slice(0, limit).map((agent, index) => {
    const name = agent.nickname || agent.role || shortThreadId(agent.threadId) || `子 Agent ${index + 1}`;
    const role = agent.role && agent.role !== name ? `角色：${agent.role}` : null;
    const meta = [
      subAgentStatusText(agent.status),
      agent.model ? `模型：${agent.model}` : "模型：继承主任务/未知",
      agent.reasoningEffort ? `思考：${agent.reasoningEffort}` : "思考：继承主任务/未知",
      role,
      agent.message ? `说明：${agent.message}` : null
    ].filter(Boolean);
    return `${index + 1}. **${name}**\n${meta.join(" · ")}`;
  });
  const hidden = subAgents.length > visible.length ? `\n\n... 还有 ${subAgents.length - visible.length} 个子 Agent` : "";
  return `${visible.join("\n\n")}${hidden}`;
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

const codexOnlyCompletionTitle = (status: string): string =>
  ({
    completed: "Codex Desktop 任务已完成",
    failed: "Codex Desktop 任务失败",
    interrupted: "Codex Desktop 任务已中断"
  })[status] ?? "Codex Desktop 任务已结束";

const codexConnectionText = (mode: string, kind: string): string => {
  const modeText = ({ desktop_ipc: "Desktop IPC" } as Record<string, string>)[mode] ?? mode;
  const kindText =
    ({
      desktop_ipc: "普通 Desktop IPC",
      not_started: "未启动",
      unknown: "未知"
    } as Record<string, string>)[kind] ?? kind;
  return `${modeText} / ${kindText}`;
};

const formatImpactSummary = (impact: WorkspaceImpactSummary | null): string => {
  if (!impact) return "还没有可对比的检查点。下一轮任务完成后会自动生成。";
  const parts = [
    `新增 ${impact.added.length} 个，修改 ${impact.modified.length} 个，删除 ${impact.deleted.length} 个。`,
    impact.truncated ? "检查点较大，已按安全上限截取；列表可能不是全量。" : null,
    formatImpactGroup("新增", impact.added.map((file) => file.path)),
    formatImpactGroup("修改", impact.modified.map((item) => item.after.path)),
    formatImpactGroup("删除", impact.deleted.map((file) => file.path))
  ].filter(Boolean);
  return parts.join("\n\n");
};

const formatImpactGroup = (label: string, paths: string[]): string | null => {
  if (paths.length === 0) return null;
  const visible = paths.slice(0, 8).map((path) => `- ${path}`);
  const hidden = paths.length > visible.length ? `\n... 还有 ${paths.length - visible.length} 个` : "";
  return `**${label}**\n${visible.join("\n")}${hidden}`;
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
