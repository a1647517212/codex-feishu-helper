export const classifyCommandRisk = (command: string | null | undefined): "low" | "medium" | "high" => {
  const normalized = (command ?? "").toLowerCase();
  if (!normalized) return "medium";
  if (/\b(rm|del|remove-item|rd|rmdir|git\s+reset|git\s+clean|deploy|ssh|scp|push|format)\b/.test(normalized)) {
    return "high";
  }
  if (/\b(npm\s+i|npm\s+install|pnpm\s+i|yarn\s+add|build|checkout|branch|start-process)\b/.test(normalized)) {
    return "medium";
  }
  if (/\b(test|lint|typecheck|git\s+status|git\s+diff|ls|dir|cat|get-content|select-string|rg)\b/.test(normalized)) {
    return "low";
  }
  return "medium";
};

export const commandApprovalDecision = (decision: "once" | "task" | "deny") => {
  if (decision === "once") return "accept";
  if (decision === "task") return "acceptForSession";
  return "decline";
};

export const fileApprovalDecision = (decision: "once" | "task" | "deny") => {
  if (decision === "once") return "accept";
  if (decision === "task") return "acceptForSession";
  return "decline";
};
