import { formatShort } from "./dates";
import { buildGraph, downstreamOf, hasCycle } from "./graph";
import { schedule } from "./schedule";
import type {
  AgentRun,
  Dependency,
  FeasibilityReport,
  Finding,
  ImpactReport,
  Project,
  ProposedChange,
  Schedule,
  Task,
} from "./types";

/* ------------------------------------------------------------------ */
/* Request understanding                                               */
/* ------------------------------------------------------------------ */

const LEXICON: Record<string, string[]> = {
  auth: ["otp", "login", "log in", "auth", "authentication", "sso", "password", "signup", "sign up", "2fa", "mfa", "oauth", "session"],
  payment: ["payment", "pay", "checkout", "upi", "refund", "billing", "pine labs", "invoice", "card"],
  ui: ["design", "ui", "screen", "page", "layout", "figma", "theme", "ux", "mockup"],
  api: ["api", "endpoint", "backend", "server", "database", "schema", "integration"],
  test: ["test", "qa", "bug", "regression", "coverage"],
  release: ["release", "launch", "deploy", "ship", "go-live", "go live", "date", "deadline"],
  dashboard: ["dashboard", "analytics", "report", "chart"],
};

const STOP = new Set(["the", "and", "but", "for", "with", "that", "this", "cannot", "can't", "need", "needs", "want", "wants", "add", "client", "before", "after", "into", "from", "our", "we", "to", "a", "an", "of", "on", "in", "be", "it", "is", "so", "can"]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

export function detectDomains(text: string): string[] {
  const t = ` ${text.toLowerCase()} `;
  return Object.entries(LEXICON)
    .filter(([, words]) => words.some((w) => new RegExp(`[^a-z]${w.replace(/[-]/g, "\\-")}[^a-z]`).test(t)))
    .map(([d]) => d);
}

const wantsFixedDeadline = (text: string) =>
  /(date|deadline|launch).{0,30}(cannot|can't|must not|won't|should not|fixed|same)|(cannot|can't|must not|don't).{0,20}(move|change|slip).{0,20}(date|deadline|launch)/i.test(text);

const wantsDeferral = (text: string) => /\b(move|push|defer|drop|cut|postpone)\b.{0,40}\b(next release|later|v2|phase 2|after launch)\b/i.test(text);

/** Scores how strongly a task relates to the request. Uses tags first, then title/description words. */
function relevance(task: Task, domains: string[], words: string[]): number {
  let score = 0;
  for (const d of domains) if (task.tags.includes(d)) score += 3;
  const hay = `${task.title} ${task.description} ${task.tags.join(" ")}`.toLowerCase();
  for (const w of words) if (hay.includes(w)) score += 1;
  return score;
}

/* ------------------------------------------------------------------ */
/* Change templates: what new work a request usually implies           */
/* ------------------------------------------------------------------ */

interface Template {
  id: string;
  test: (text: string) => boolean;
  interpretation: string;
  build: (p: Project, ctx: Ctx) => ProposedChange[];
  questions: string[];
}

interface Ctx {
  owner: (role: RegExp, fallback?: string) => string;
  taskWith: (tag: string, prefer?: (t: Task) => boolean) => Task | undefined;
  nextId: () => string;
}

const TEMPLATES: Template[] = [
  {
    id: "otp",
    test: (t) => /\b(otp|one[- ]time|2fa|mfa|two[- ]factor)\b/i.test(t),
    interpretation: "Add one-time-password verification to sign-in, keeping the launch date fixed.",
    questions: [
      "Will OTPs go by SMS, email or WhatsApp? It changes the provider work and the cost per login.",
      "Is OTP required on every login or only on new devices?",
    ],
    build: (p, c) => {
      const api = c.taskWith("auth", (t) => t.tags.includes("api"));
      const design = c.taskWith("design");
      const integ = c.taskWith("integration") ?? c.taskWith("frontend");
      const test = c.taskWith("test", (t) => t.tags.includes("login"));
      const out: ProposedChange[] = [];
      const otpId = c.nextId();
      out.push({
        id: `chg-${otpId}`,
        type: "add_task",
        agent: "scope",
        summary: "Add task: build OTP issue and verify endpoints",
        reason: `Sign-in now needs an OTP step. ${api ? `${api.id} covers password login only.` : ""}`.trim(),
        basis: "ai_inference",
        newTask: {
          id: otpId,
          title: "Build OTP issue and verify endpoints",
          description: "Generate, deliver and verify one-time passwords with expiry and retry limits.",
          ownerId: api?.ownerId ?? c.owner(/backend|api/i),
          status: "not_started",
          priority: "high",
          estimateDays: 2,
          acceptanceCriteria: ["OTP expires after 5 minutes", "Max 3 attempts, then cool-down", "Contract shared with frontend before build"],
          tags: ["api", "backend", "auth", "otp"],
        },
        dependencies: [
          ...(api ? [{ from: api.id, to: otpId }] : []),
          ...(integ ? [{ from: otpId, to: integ.id }] : []),
        ],
        recommended: true,
      });
      if (design) {
        const dId = c.nextId();
        out.push({
          id: `chg-${dId}`,
          type: "add_task",
          agent: "scope",
          summary: "Add task: design the OTP entry step",
          reason: `${design.id} "${design.title}" is ${design.status === "done" ? "already done" : "in progress"} and has no OTP screen.`,
          basis: "ai_inference",
          newTask: {
            id: dId,
            title: "Design OTP entry step",
            description: "Code entry, resend timer, expired-code and too-many-attempts states.",
            ownerId: design.ownerId,
            status: "not_started",
            priority: "medium",
            estimateDays: 1,
            acceptanceCriteria: ["Resend and expired states designed"],
            tags: ["design", "ui", "auth", "otp"],
          },
          dependencies: integ ? [{ from: dId, to: integ.id }] : [],
          recommended: true,
        });
      }
      if (test) {
        out.push({
          id: `chg-crit-${test.id}`,
          type: "append_criteria",
          agent: "scope",
          summary: `Extend ${test.id} for OTP cases (+1 day)`,
          reason: `${test.id} "${test.title}" does not cover OTP expiry, invalid codes or retries.`,
          basis: "ai_inference",
          taskId: test.id,
          criteria: ["OTP expiry", "Invalid and reused codes", "Retry and cool-down limits"],
          estimateDays: (test.estimateDays ?? 1) + 1,
          recommended: true,
        });
      }
      return out;
    },
  },
  {
    id: "payment",
    test: (t) => /\b(upi|checkout|payment|pine labs|pay)\b/i.test(t),
    interpretation: "Add a new payment path to checkout before launch.",
    questions: [
      "Which payment methods are in scope for launch: UPI only, or cards and wallets too?",
      "Do we have Pine Labs test credentials yet?",
    ],
    build: (p, c) => {
      const pay = c.taskWith("payment");
      const fe = c.taskWith("frontend", (t) => t.tags.includes("dashboard")) ?? c.taskWith("frontend");
      const id = c.nextId();
      return [
        {
          id: `chg-${id}`,
          type: "add_task",
          agent: "scope",
          summary: "Add task: integrate Pine Labs UPI checkout",
          reason: pay ? `${pay.id} hardens the existing payment API but adds no UPI flow.` : "No task covers a UPI checkout.",
          basis: "ai_inference",
          newTask: {
            id,
            title: "Integrate Pine Labs UPI checkout",
            description: "Create orders, open the Pine Labs checkout and handle success, failure and pending callbacks.",
            ownerId: pay?.ownerId ?? c.owner(/backend|api/i),
            status: "not_started",
            priority: "high",
            estimateDays: null,
            acceptanceCriteria: ["Test-mode payment succeeds end to end", "Pending payments reconcile"],
            tags: ["payment", "api", "backend", "checkout"],
          },
          dependencies: [...(pay ? [{ from: id, to: pay.id }] : []), ...(fe ? [{ from: id, to: fe.id }] : [])],
          recommended: true,
        },
      ];
    },
  },
];

/* ------------------------------------------------------------------ */
/* Applying proposals to a copy of the plan                            */
/* ------------------------------------------------------------------ */

export function applyChanges(project: Project, changes: ProposedChange[]): { tasks: Task[]; dependencies: Dependency[] } {
  let tasks: Task[] = project.tasks.map((t) => ({ ...t, acceptanceCriteria: [...t.acceptanceCriteria] }));
  let dependencies: Dependency[] = project.dependencies.map((d) => ({ ...d }));
  for (const ch of changes) {
    if (ch.type === "add_task" && ch.newTask) {
      tasks.push({ ...ch.newTask, version: 1 });
      dependencies.push(...(ch.dependencies ?? []));
    } else if (ch.type === "update_estimate" && ch.taskId) {
      tasks = tasks.map((t) => (t.id === ch.taskId ? { ...t, estimateDays: ch.estimateDays ?? t.estimateDays, version: t.version + 1 } : t));
    } else if (ch.type === "append_criteria" && ch.taskId) {
      tasks = tasks.map((t) =>
        t.id === ch.taskId
          ? {
              ...t,
              acceptanceCriteria: [...t.acceptanceCriteria, ...(ch.criteria ?? [])],
              estimateDays: ch.estimateDays ?? t.estimateDays,
              version: t.version + 1,
            }
          : t,
      );
    } else if (ch.type === "defer_task" && ch.taskId) {
      // Deferred work leaves this release: drop its outgoing edges and mark it low priority.
      dependencies = dependencies.filter((d) => d.from !== ch.taskId);
      tasks = tasks.map((t) => (t.id === ch.taskId ? { ...t, priority: "low", tags: [...t.tags, "deferred"], version: t.version + 1 } : t));
    } else if (ch.type === "add_dependency" && ch.dependencies) {
      dependencies.push(...ch.dependencies);
    } else if (ch.type === "remove_dependency" && ch.dependencies) {
      const drop = new Set(ch.dependencies.map((d) => `${d.from}>${d.to}`));
      dependencies = dependencies.filter((d) => !drop.has(`${d.from}>${d.to}`));
    }
  }
  // Never let a proposal introduce a cycle.
  if (hasCycle(tasks, dependencies)) return { tasks: project.tasks, dependencies: project.dependencies };
  return { tasks, dependencies };
}

function scheduleWith(project: Project, changes: ProposedChange[]): Schedule {
  const { tasks, dependencies } = applyChanges(project, changes);
  return schedule(project, tasks, dependencies);
}

/* ------------------------------------------------------------------ */
/* Timeline mitigations: search for options that recover the deadline  */
/* ------------------------------------------------------------------ */

function mitigations(project: Project, base: ProposedChange[], nextId: () => string): ProposedChange[] {
  const { tasks, dependencies } = applyChanges(project, base);
  const current = schedule(project, tasks, dependencies);
  if (current.bufferDays >= 0) return [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const candidates: ProposedChange[] = [];

  // 1. Pull test preparation forward: split a long test task on the critical path.
  for (const id of current.criticalPath) {
    const t = byId.get(id)!;
    if (t.status === "done" || !t.tags.includes("test") || (t.estimateDays ?? 0) < 2) continue;
    const prepId = nextId();
    candidates.push({
      id: `chg-${prepId}`,
      type: "add_task",
      agent: "timeline",
      summary: `Write ${t.title.toLowerCase()} cases now, in parallel`,
      reason: `${t.id} sits on the critical path. Preparing its test cases before the build lands shortens it by a day.`,
      basis: "schedule",
      newTask: {
        id: prepId,
        title: `Prepare test cases for ${t.title.toLowerCase()}`,
        description: "Write cases and test data before the feature is ready.",
        ownerId: t.ownerId,
        status: "not_started",
        priority: "medium",
        estimateDays: 1,
        acceptanceCriteria: ["Cases reviewed by the developer"],
        tags: ["test", "qa", "prep"],
      },
      dependencies: [],
      estimateDays: Math.max(1, (t.estimateDays ?? 1) - 1),
      taskId: t.id,
      recommended: true,
    });
  }

  // 2. Contract-first: decouple a cross-owner hand-off on the critical path.
  for (const d of dependencies) {
    const a = byId.get(d.from);
    const b = byId.get(d.to);
    if (!a || !b || a.status === "done" || b.status === "done" || a.ownerId === b.ownerId) continue;
    if (!current.criticalPath.includes(a.id) || !current.criticalPath.includes(b.id)) continue;
    if (!a.tags.includes("api") || !(b.tags.includes("frontend") || b.tags.includes("integration"))) continue;
    candidates.push({
      id: `chg-contract-${a.id}-${b.id}`,
      type: "remove_dependency",
      agent: "timeline",
      summary: `Agree the ${a.title.toLowerCase()} contract first so ${b.id} can start against a mock`,
      reason: `${b.id} waits for ${a.id} to finish. With an agreed API contract the two can overlap.`,
      basis: "schedule",
      dependencies: [{ from: a.id, to: b.id }],
      taskId: b.id,
      recommended: false,
    });
  }

  // 3. Defer medium/low-priority work that feeds the release.
  for (const t of tasks) {
    if (t.status !== "not_started" || (t.priority !== "medium" && t.priority !== "low")) continue;
    if (!dependencies.some((d) => d.from === t.id)) continue;
    candidates.push({
      id: `chg-defer-${t.id}`,
      type: "defer_task",
      agent: "timeline",
      summary: `Move ${t.id} "${t.title}" to the next release`,
      reason: `${t.id} is ${t.priority} priority. Taking it off the launch path frees its owner.`,
      basis: "schedule",
      taskId: t.id,
      recommended: false,
    });
  }

  // Keep only candidates that actually help, best first.
  const scored = candidates
    .map((c) => {
      const s = evaluateMitigation(project, base, c);
      return { c, gain: s.bufferDays - current.bufferDays, s };
    })
    .filter((x) => x.gain > 0)
    .sort((a, b) => b.gain - a.gain);
  return scored.slice(0, 3).map((x, i) => ({ ...x.c, recommended: i === 0 }));
}

/** Recovery options for the plan as it stands (used after member updates). */
export function mitigationsFor(project: Project, nextId: () => string): ProposedChange[] {
  return mitigations(project, [], nextId);
}

function evaluateMitigation(project: Project, base: ProposedChange[], m: ProposedChange): Schedule {
  return scheduleWith(project, [...base, ...expandMitigation(m)]);
}

/**
 * A test-prep mitigation is two edits: add the prep task, and shorten the original test task.
 * Everything else applies as-is.
 */
export function expandMitigation(m: ProposedChange): ProposedChange[] {
  if (m.type === "add_task" && m.taskId && m.estimateDays != null) {
    const { newTask, ...rest } = m;
    return [m, { ...rest, id: `${m.id}-est`, type: "update_estimate" }];
  }
  return [m];
}

/* ------------------------------------------------------------------ */
/* Main entry: run the specialist agents and reconcile                 */
/* ------------------------------------------------------------------ */

export interface AnalyzeOptions {
  now?: Date;
  /** Override for the report id (tests). */
  id?: string;
}

export function analyzeChange(project: Project, request: string, opts: AnalyzeOptions = {}): ImpactReport {
  const t0 = Date.now();
  const text = request.trim();
  // "The launch date cannot change" is a constraint, not a change to release work.
  const domains = detectDomains(text).filter((d) => !(d === "release" && wantsFixedDeadline(text)));
  const words = tokens(text);
  const graph = buildGraph(project.tasks, project.dependencies);
  const byId = new Map(project.tasks.map((t) => [t.id, t]));
  const memberName = (id: string) => project.members.find((m) => m.id === id)?.name ?? id;

  let seq = project.tasks.filter((t) => /^N\d+$/.test(t.id)).length;
  const nextId = () => `N${++seq}`;
  const ctx: Ctx = {
    owner: (role, fallback) => project.members.find((m) => role.test(m.role))?.id ?? fallback ?? project.members[0].id,
    taskWith: (tag, prefer) => {
      const list = project.tasks.filter((t) => t.tags.includes(tag));
      return (prefer ? list.find(prefer) : undefined) ?? list[0];
    },
    nextId,
  };

  /* ---------- Scope agent ---------- */
  const scopeStart = Date.now();
  const scored = project.tasks
    .map((t) => ({ t, s: relevance(t, domains, words) }))
    .filter((x) => x.s >= 3)
    .sort((a, b) => b.s - a.s);
  const direct = scored.filter((x) => x.s >= 4 || x.t.tags.some((tag) => domains.includes(tag) && ["api", "auth", "payment"].includes(tag))).map((x) => x.t);
  // Finished work is never "directly affected"; it becomes a review candidate instead.
  const directIds = [...new Set(direct.filter((t) => t.status !== "done").slice(0, 3).map((t) => t.id))];
  const doneMatches = direct.filter((t) => t.status === "done").map((t) => t.id);

  const template = TEMPLATES.find((tp) => tp.test(text));
  const deferMatch = wantsDeferral(text) ? scored[0]?.t : undefined;
  let scopeChanges: ProposedChange[] = template ? template.build(project, ctx) : [];
  if (deferMatch) {
    scopeChanges = [
      {
        id: `chg-defer-${deferMatch.id}`,
        type: "defer_task",
        agent: "scope",
        summary: `Move ${deferMatch.id} "${deferMatch.title}" to the next release`,
        reason: "The request asks to take this work out of the launch.",
        basis: "ai_inference",
        taskId: deferMatch.id,
        recommended: true,
      },
    ];
  }
  if (!template && !deferMatch && text.length > 0) {
    const anchor = direct[0];
    const id = nextId();
    scopeChanges.push({
      id: `chg-${id}`,
      type: "add_task",
      agent: "scope",
      summary: `Add task: ${text.replace(/[.!]+$/, "")}`,
      reason: anchor ? `Closest existing work is ${anchor.id} "${anchor.title}".` : "No existing task covers this request.",
      basis: "ai_inference",
      newTask: {
        id,
        title: text.length > 60 ? `${text.slice(0, 57)}…` : text.replace(/[.!]+$/, ""),
        description: text,
        ownerId: anchor?.ownerId ?? project.members[0].id,
        status: "not_started",
        priority: "medium",
        estimateDays: null,
        acceptanceCriteria: [],
        tags: domains,
      },
      dependencies: anchor ? graph.successors.get(anchor.id)!.slice(0, 1).map((to) => ({ from: id, to })) : [],
      recommended: true,
    });
  }
  const newTaskIds = scopeChanges.filter((c) => c.newTask).map((c) => c.newTask!.id);
  const scopeFindings: Finding[] = [
    ...directIds.map((id, i) => ({
      id: `f-scope-${i}`,
      agent: "scope" as const,
      title: `${id} "${byId.get(id)!.title}" matches the request`,
      detail: `Shares ${byId.get(id)!.tags.filter((tag) => domains.includes(tag)).join(", ") || "keywords"} with the change.`,
      basis: "graph" as const,
      taskIds: [id],
      severity: "info" as const,
    })),
    ...scopeChanges.map((c, i) => ({
      id: `f-scope-new-${i}`,
      agent: "scope" as const,
      title: c.summary,
      detail: c.reason,
      basis: c.basis,
      taskIds: [c.taskId ?? c.newTask?.id ?? ""].filter(Boolean),
      severity: "warning" as const,
    })),
  ];
  const scopeRun: AgentRun = {
    agent: "scope",
    label: "Scope agent",
    question: "What work needs to change?",
    status: "done",
    summary: scopeChanges.length
      ? `${scopeChanges.length} change${scopeChanges.length > 1 ? "s" : ""} proposed across ${directIds.length} directly related task${directIds.length === 1 ? "" : "s"}.`
      : "No existing work matches. Needs clarification.",
    findings: scopeFindings,
    durationMs: Date.now() - scopeStart,
  };

  /* ---------- Conflict & impact agent ---------- */
  const conflictStart = Date.now();
  const after = applyChanges(project, scopeChanges);
  const afterGraph = buildGraph(after.tasks, after.dependencies);
  const seeds = [...directIds, ...newTaskIds];
  const downstream = downstreamOf(afterGraph, seeds).filter((id) => !newTaskIds.includes(id) && !directIds.includes(id));
  const inferred = [...doneMatches, ...scopeChanges.flatMap((c) => c.reason.match(/\bT\d+\b/g) ?? [])].filter(
    (id) => byId.has(id) && !directIds.includes(id) && !downstream.includes(id),
  );
  const conflictFindings: Finding[] = [];
  for (const id of downstream) {
    const t = byId.get(id)!;
    const via = afterGraph.predecessors.get(id)!.filter((p) => seeds.includes(p) || downstream.includes(p));
    conflictFindings.push({
      id: `f-con-${id}`,
      agent: "conflict",
      title: `${id} "${t.title}" is downstream`,
      detail: `Depends on ${via.join(", ")}. Owner: ${memberName(t.ownerId)}.`,
      basis: "graph",
      taskIds: [id],
      severity: t.status === "done" ? "info" : "warning",
    });
  }
  for (const id of [...new Set(inferred)]) {
    const t = byId.get(id)!;
    conflictFindings.push({
      id: `f-con-inf-${id}`,
      agent: "conflict",
      title: `${id} "${t.title}" may need review`,
      detail: t.status === "done" ? "Already marked done, but its output may no longer match the new flow." : "Its output may change.",
      basis: "ai_inference",
      taskIds: [id],
      severity: "warning",
    });
  }
  // Owner load: count open work per owner before and after.
  const beforeSched = schedule(project, project.tasks, project.dependencies);
  const afterSched = schedule(project, after.tasks, after.dependencies);
  const owners = new Set(after.tasks.filter((t) => newTaskIds.includes(t.id)).map((t) => t.ownerId));
  for (const owner of owners) {
    const open = after.tasks.filter((t) => t.ownerId === owner && t.status !== "done");
    const lastBefore = Math.max(0, ...project.tasks.filter((t) => t.ownerId === owner).map((t) => beforeSched.tasks[t.id].endDay));
    const lastAfter = Math.max(0, ...open.map((t) => afterSched.tasks[t.id].endDay));
    if (open.length >= 3 || (open.length >= 2 && lastAfter > lastBefore)) {
      conflictFindings.push({
        id: `f-con-load-${owner}`,
        agent: "conflict",
        title: `${memberName(owner)} is now carrying ${open.length} open tasks`,
        detail: `${open.map((t) => t.id).join(", ")}. Their last task now finishes on ${formatShort(afterSched.tasks[open[open.length - 1].id].endDate)} instead of day ${lastBefore}.`,
        basis: "schedule",
        taskIds: open.map((t) => t.id),
        severity: "critical",
      });
    }
  }
  const conflictRun: AgentRun = {
    agent: "conflict",
    label: "Conflict & impact agent",
    question: "What could conflict, and who is affected?",
    status: "done",
    summary: `${downstream.length} downstream task${downstream.length === 1 ? "" : "s"} from the graph, ${new Set(inferred).size} flagged for review.`,
    findings: conflictFindings,
    durationMs: Date.now() - conflictStart,
  };

  /* ---------- Timeline & feasibility agent ---------- */
  const timelineStart = Date.now();
  // "After" = every scope change applied, nothing else adjusted.
  const naive = scheduleWith(project, scopeChanges);
  const mitig = mitigations(project, scopeChanges, nextId);
  const recommended = [...scopeChanges.filter((c) => c.recommended)];
  for (const m of mitig.filter((x) => x.recommended)) recommended.push(...expandMitigation(m));
  const withRec = scheduleWith(project, recommended);

  const timelineFindings: Finding[] = [
    {
      id: "f-tl-naive",
      agent: "timeline",
      title: naive.feasible
        ? `Still fits: finishes ${formatShort(naive.finishDate)} with ${naive.bufferDays} day${naive.bufferDays === 1 ? "" : "s"} to spare`
        : `Slips by ${-naive.bufferDays} working day${naive.bufferDays === -1 ? "" : "s"}: finishes ${formatShort(naive.finishDate)}`,
      detail: `Deadline is ${formatShort(project.deadline)}. Before the change the plan finished ${formatShort(beforeSched.finishDate)}.`,
      basis: "schedule",
      taskIds: naive.criticalPath,
      severity: naive.feasible ? "info" : "critical",
    },
    ...mitig.map((m, i) => ({
      id: `f-tl-m-${i}`,
      agent: "timeline" as const,
      title: m.summary,
      detail: m.reason,
      basis: "schedule" as const,
      taskIds: [m.taskId ?? ""].filter(Boolean),
      severity: "info" as const,
    })),
  ];
  if (naive.missingEstimates.length) {
    timelineFindings.push({
      id: "f-tl-missing",
      agent: "timeline",
      title: `Missing estimates for ${naive.missingEstimates.join(", ")}`,
      detail: "Scheduled at 1 day each until the owner confirms. Hades will ask them.",
      basis: "schedule",
      taskIds: naive.missingEstimates,
      severity: "warning",
    });
  }
  const timelineRun: AgentRun = {
    agent: "timeline",
    label: "Timeline & feasibility agent",
    question: "Can we still make the deadline?",
    status: "done",
    summary: withRec.feasible
      ? naive.feasible
        ? "The deadline holds."
        : `Recoverable: with ${mitig.filter((m) => m.recommended).length} adjustment the plan lands on ${formatShort(withRec.finishDate)}.`
      : `At risk even with adjustments. Trade-offs needed.`,
    findings: timelineFindings,
    durationMs: Date.now() - timelineStart,
  };

  /* ---------- Orchestrator reconciliation ---------- */
  const allChanges = [...scopeChanges, ...mitig];
  const affected = new Set<string>();
  for (const id of [...directIds, ...downstream, ...inferred]) affected.add(byId.get(id)!.ownerId);
  for (const c of allChanges) if (c.newTask) affected.add(c.newTask.ownerId);

  const verdict: FeasibilityReport["verdict"] = !withRec.feasible ? "slips" : withRec.bufferDays <= 1 ? "tight" : "fits";
  const feasibility: FeasibilityReport = {
    before: beforeSched,
    after: naive,
    withRecommended: withRec,
    verdict,
    headline:
      verdict === "slips"
        ? `Launch slips to ${formatShort(withRec.finishDate)} even with the recommended plan.`
        : naive.feasible
          ? `Launch holds on ${formatShort(project.deadline)}.`
          : `Launch holds on ${formatShort(project.deadline)} if you approve the recommended plan.`,
  };

  const openQuestions = [
    ...(template?.questions ?? []),
    ...(naive.missingEstimates.length ? [`Estimates needed from ${[...new Set(naive.missingEstimates.map((id) => memberName((after.tasks.find((t) => t.id === id) ?? byId.get(id))!.ownerId)))].join(", ")}.`] : []),
    ...(!template && !deferMatch && directIds.length === 0 ? ["Which part of the project does this change touch?"] : []),
  ];
  if (wantsFixedDeadline(text) && !naive.feasible) {
    openQuestions.push("You said the date is fixed. Which lower-priority work can move if the recommended plan is not enough?");
  }

  const orchestratorRun: AgentRun = {
    agent: "orchestrator",
    label: "Orchestrator",
    question: "What should the manager decide?",
    status: "done",
    summary: `${allChanges.length} proposed edits, ${affected.size} people affected. ${feasibility.headline}`,
    findings: [],
    durationMs: Date.now() - t0,
  };

  return {
    id: opts.id ?? `imp-${Date.now().toString(36)}`,
    projectId: project.id,
    projectVersion: project.version,
    request: text,
    interpretation: template?.interpretation ?? (deferMatch ? `Take ${deferMatch.id} out of this release.` : text),
    directTaskIds: directIds,
    downstreamTaskIds: downstream,
    inferredTaskIds: [...new Set(inferred)],
    affectedMemberIds: [...affected],
    agents: [scopeRun, conflictRun, timelineRun, orchestratorRun],
    changes: allChanges,
    feasibility,
    openQuestions,
    engine: "deterministic",
    createdAt: (opts.now ?? new Date()).toISOString(),
  };
}
