import { addWorkingDays, workingDaysBetween } from "./dates";
import { buildGraph, topoSort } from "./graph";
import type { Dependency, Project, Schedule, ScheduledTask, Task } from "./types";

const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;

/** Unknown estimates are scheduled at this many days and reported as missing. */
const FALLBACK_ESTIMATE = 1;

/**
 * Deterministic list scheduler.
 * A task starts when all its predecessors have finished AND its owner is free.
 * Owners work one task at a time. This is the only place dates are calculated:
 * agents may suggest options, but never invent dates.
 */
export function schedule(
  project: Pick<Project, "startDate" | "deadline">,
  tasks: Task[],
  deps: Dependency[],
): Schedule {
  const graph = buildGraph(tasks, deps);
  const order = topoSort(graph);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const missingEstimates: string[] = [];

  const duration = (t: Task) => {
    if (t.estimateDays == null) {
      missingEstimates.push(t.id);
      return FALLBACK_ESTIMATE;
    }
    return Math.max(0, t.estimateDays);
  };

  // Ready-list scheduling: repeatedly pick the highest-priority task whose predecessors are done.
  const finish = new Map<string, number>();
  const start = new Map<string, number>();
  const ownerFree = new Map<string, number>();
  const remaining = new Set(order);
  const orderIndex = new Map(order.map((id, i) => [id, i]));

  while (remaining.size) {
    const ready = [...remaining].filter((id) =>
      graph.predecessors.get(id)!.every((p) => finish.has(p)),
    );
    ready.sort((a, b) => {
      const ta = byId.get(a)!;
      const tb = byId.get(b)!;
      // Finished work keeps its place in history; then priority; then topological order.
      const doneA = ta.status === "done" ? 0 : 1;
      const doneB = tb.status === "done" ? 0 : 1;
      if (doneA !== doneB) return doneA - doneB;
      const pa = PRIORITY_RANK[ta.priority];
      const pb = PRIORITY_RANK[tb.priority];
      if (pa !== pb) return pa - pb;
      return orderIndex.get(a)! - orderIndex.get(b)!;
    });
    const id = ready[0];
    const t = byId.get(id)!;
    const depsDone = Math.max(0, ...graph.predecessors.get(id)!.map((p) => finish.get(p)!));
    const s = Math.max(depsDone, ownerFree.get(t.ownerId) ?? 0);
    const f = s + duration(t);
    start.set(id, s);
    finish.set(id, f);
    ownerFree.set(t.ownerId, f);
    remaining.delete(id);
  }

  const finishDay = Math.max(0, ...finish.values());

  // Backward pass on the dependency graph for slack and the critical path.
  const latestFinish = new Map<string, number>();
  for (const id of [...order].reverse()) {
    const succ = graph.successors.get(id)!;
    const lf = succ.length
      ? Math.min(...succ.map((s) => latestFinish.get(s)! - duration(byId.get(s)!)))
      : finishDay;
    latestFinish.set(id, lf);
  }

  const out: Record<string, ScheduledTask> = {};
  for (const id of order) {
    const s = start.get(id)!;
    const f = finish.get(id)!;
    const slack = Math.max(0, latestFinish.get(id)! - f);
    out[id] = {
      taskId: id,
      startDay: s,
      endDay: f,
      startDate: addWorkingDays(project.startDate, s),
      endDate: addWorkingDays(project.startDate, f),
      slackDays: slack,
      onCriticalPath: slack === 0,
    };
  }

  const criticalPath = order.filter((id) => out[id].onCriticalPath);
  const deadlineDay = workingDaysBetween(project.startDate, project.deadline);
  const bufferDays = deadlineDay - finishDay;

  return {
    tasks: out,
    finishDay,
    finishDate: addWorkingDays(project.startDate, finishDay),
    deadlineDay,
    bufferDays,
    feasible: bufferDays >= 0,
    missingEstimates: [...new Set(missingEstimates)],
    criticalPath,
  };
}

export function scheduleProject(project: Project): Schedule {
  return schedule(project, project.tasks, project.dependencies);
}
