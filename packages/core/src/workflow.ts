import { applyChanges, expandMitigation, mitigationsFor } from "./analyze";
import { formatShort } from "./dates";
import { scheduleProject } from "./schedule";
import type { AuditEvent, ImpactReport, MemberMessage, Project, ProposedChange, Schedule, TaskStatus } from "./types";

const uid = (p: string) => `${p}-${Math.random().toString(36).slice(2, 9)}`;

export class StaleProposalError extends Error {
  constructor(public expected: number, public actual: number) {
    super(`The project changed since this analysis (v${expected} → v${actual}). Re-run the analysis before approving.`);
  }
}

export interface ApprovalResult {
  project: Project;
  applied: ProposedChange[];
  rejected: ProposedChange[];
  events: AuditEvent[];
  messages: MemberMessage[];
}

/**
 * Applies only the changes the manager approved. Enforced here, not by the agents:
 * - stale proposals are refused,
 * - unapproved edits never touch the plan,
 * - the project version moves forward exactly once.
 */
export function approveChanges(
  project: Project,
  report: ImpactReport,
  approvedIds: string[],
  actor = "manager",
  now = new Date(),
): ApprovalResult {
  if (report.projectVersion !== project.version) throw new StaleProposalError(report.projectVersion, project.version);
  const approved = report.changes.filter((c) => approvedIds.includes(c.id));
  const rejected = report.changes.filter((c) => !approvedIds.includes(c.id));
  const expanded = approved.flatMap(expandMitigation);
  const { tasks, dependencies } = applyChanges(project, expanded);
  const next: Project = { ...project, tasks, dependencies, version: project.version + 1 };
  const at = now.toISOString();

  const events: AuditEvent[] = [
    ...approved.map((c) => ({
      id: uid("ev"),
      at,
      actor,
      action: "change_approved" as const,
      summary: c.summary,
      projectVersion: next.version,
      meta: { changeId: c.id, reportId: report.id },
    })),
    ...rejected.map((c) => ({
      id: uid("ev"),
      at,
      actor,
      action: "change_rejected" as const,
      summary: c.summary,
      projectVersion: next.version,
      meta: { changeId: c.id, reportId: report.id },
    })),
  ];

  const messages = notifyMembers(next, report, approved, now);
  for (const m of messages) {
    events.push({
      id: uid("ev"),
      at,
      actor: "member-agent",
      action: "member_notified",
      summary: `Told ${next.members.find((x) => x.id === m.memberId)?.name} about ${m.taskIds.join(", ")}`,
      projectVersion: next.version,
      meta: { memberId: m.memberId },
    });
  }
  return { project: next, applied: approved, rejected, events, messages };
}

/** Member agents: one short, specific message per affected person. */
export function notifyMembers(project: Project, report: ImpactReport, approved: ProposedChange[], now = new Date()): MemberMessage[] {
  const byMember = new Map<string, { tasks: Set<string>; lines: string[] }>();
  const add = (memberId: string, taskId: string, line: string) => {
    if (!byMember.has(memberId)) byMember.set(memberId, { tasks: new Set(), lines: [] });
    const e = byMember.get(memberId)!;
    e.tasks.add(taskId);
    e.lines.push(line);
  };
  for (const c of approved) {
    if (c.newTask) {
      const est = c.newTask.estimateDays == null ? "Can you give me an estimate?" : `I've pencilled in ${c.newTask.estimateDays} day${c.newTask.estimateDays === 1 ? "" : "s"}. Does that hold?`;
      add(c.newTask.ownerId, c.newTask.id, `New task for you: "${c.newTask.title}" (${c.newTask.id}). ${est}`);
    } else if (c.taskId) {
      const t = project.tasks.find((x) => x.id === c.taskId);
      if (!t) continue;
      if (c.type === "append_criteria") add(t.ownerId, t.id, `${t.id} "${t.title}" now also needs to cover: ${c.criteria?.join(", ")}.`);
      if (c.type === "defer_task") add(t.ownerId, t.id, `${t.id} "${t.title}" moved to the next release. You can drop it for now.`);
      if (c.type === "remove_dependency") add(t.ownerId, t.id, `You can start ${t.id} "${t.title}" against the agreed API contract instead of waiting.`);
    }
  }
  for (const id of report.downstreamTaskIds) {
    const t = project.tasks.find((x) => x.id === id);
    if (t && t.status !== "done" && !byMember.get(t.ownerId)?.tasks.has(id)) {
      add(t.ownerId, id, `Heads-up: ${id} "${t.title}" sits downstream of this change. No action yet; I'll tell you if its dates move.`);
    }
  }
  const sched = scheduleProject(project);
  return [...byMember.entries()].map(([memberId, e]) => {
    const name = project.members.find((m) => m.id === memberId)?.name ?? memberId;
    const firstTask = [...e.tasks][0];
    const due = sched.tasks[firstTask] ? ` Current plan has it done by ${formatShort(sched.tasks[firstTask].endDate)}.` : "";
    return {
      id: uid("msg"),
      memberId,
      at: now.toISOString(),
      from: "agent" as const,
      text: `Hi ${name}, the manager approved a change: "${report.request}"\n\n${e.lines.join("\n")}${due}`,
      taskIds: [...e.tasks],
    };
  });
}

export interface MemberUpdateInput {
  memberId: string;
  taskId: string;
  estimateDays?: number;
  status?: TaskStatus;
  note: string;
}

export interface Reassessment {
  schedule: Schedule;
  suggestions: ProposedChange[];
  headline: string;
}

/** Records what a member reported and re-plans. Members can update their own task's estimate and status only. */
export function applyMemberUpdate(project: Project, input: MemberUpdateInput, now = new Date()) {
  const task = project.tasks.find((t) => t.id === input.taskId);
  if (!task) throw new Error(`Unknown task ${input.taskId}`);
  if (task.ownerId !== input.memberId) throw new Error(`${input.memberId} does not own ${input.taskId}`);
  const before = scheduleProject(project);
  const tasks = project.tasks.map((t) =>
    t.id === input.taskId
      ? { ...t, estimateDays: input.estimateDays ?? t.estimateDays, status: input.status ?? t.status, version: t.version + 1 }
      : t,
  );
  const next: Project = { ...project, tasks, version: project.version + 1 };
  const reassessment = reassess(next, before);
  const at = now.toISOString();
  const name = project.members.find((m) => m.id === input.memberId)?.name ?? input.memberId;
  const events: AuditEvent[] = [
    { id: uid("ev"), at, actor: input.memberId, action: "member_update", summary: `${name} on ${input.taskId}: "${input.note}"`, projectVersion: next.version },
    { id: uid("ev"), at, actor: "timeline-agent", action: "reassessed", summary: reassessment.headline, projectVersion: next.version },
  ];
  const message: MemberMessage = { id: uid("msg"), memberId: input.memberId, at, from: "member", text: input.note, taskIds: [input.taskId] };
  return { project: next, reassessment, events, message };
}

export function reassess(project: Project, before?: Schedule): Reassessment {
  const s = scheduleProject(project);
  let seq = project.tasks.filter((t) => /^N\d+$/.test(t.id)).length;
  const suggestions = s.feasible ? [] : mitigationsFor(project, () => `N${++seq}`);
  const moved = before ? s.finishDay - before.finishDay : 0;
  const headline = s.feasible
    ? `Plan still lands ${formatShort(s.finishDate)}${moved > 0 ? `, ${moved} day${moved === 1 ? "" : "s"} later than before` : ""}. ${s.bufferDays} day${s.bufferDays === 1 ? "" : "s"} of buffer left.`
    : `Launch now slips ${-s.bufferDays} working day${s.bufferDays === -1 ? "" : "s"} to ${formatShort(s.finishDate)}. ${suggestions.length ? `${suggestions.length} way${suggestions.length === 1 ? "" : "s"} to recover found.` : "No automatic fix found; scope needs to move."}`;
  return { schedule: s, suggestions, headline };
}
