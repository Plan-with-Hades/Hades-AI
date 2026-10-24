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
  // Event management
  sponsor: ["sponsor", "sponsors", "sponsorship", "funding", "budget", "funds"],
  budget: ["budget", "money", "cost", "funds", "cheaper", "expensive"],
  venue: ["venue", "auditorium", "hall", "ground", "location", "room", "estate office"],
  guest: ["chief guest", "guest", "speaker", "keynote", "panel", "judge"],
  marketing: ["poster", "posters", "creative", "creatives", "backdrop", "instagram", "social", "promo", "banner"],
  registration: ["registration", "registrations", "ticket", "tickets", "pass", "passes", "signup"],
  vendor: ["vendor", "vendors", "catering", "food", "caterer", "av", "sound", "lights", "stage"],
  merch: ["merch", "t-shirt", "tshirt", "goodies", "swag"],
  schedule: ["schedule", "run-of-show", "slot", "timing", "pm", "am"],
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
  /(date|deadline|launch|fest|event).{0,30}(cannot|can't|must not|won't|should not|fixed|same)|(cannot|can't|must not|don't).{0,20}(move|change|slip).{0,20}(date|deadline|launch|fest|event)/i.test(text);

const wantsDeferral = (text: string) =>
  /\b(move|push|defer|drop|cut|postpone|skip)\b.{0,40}\b(next release|later|v2|phase 2|after launch|this year|next year|next month|focus)\b/i.test(text);

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
  /* ---------------- Events ---------------- */
  {
    id: "sponsor-pullout",
    test: (t) => /sponsor.{0,40}(pull|drop|back(ed)? out|withdr|cancel|left|exit)|(less|cut|reduc|lost).{0,20}(budget|funding)|budget.{0,20}(cut|less|reduc|short)/i.test(t),
    interpretation: "A major source of funding is gone. Replace or cover the money without moving the event date.",
    questions: [
      "How much of the gap should new sponsors cover, and how much can paid passes cover?",
      "Which spend is non-negotiable: AV, food, or speaker travel?",
    ],
    build: (p, c) => {
      const sponsor = c.taskWith("sponsor");
      const vendor = c.taskWith("vendor");
      const reg = c.taskWith("registration");
      const design = c.taskWith("marketing");
      const out: ProposedChange[] = [];
      if (sponsor) {
        out.push({
          id: `chg-upd-${sponsor.id}`,
          type: "update_task",
          agent: "scope",
          summary: `Turn ${sponsor.id} into "Replace the title sponsor" (+1 day)`,
          reason: `${sponsor.id} "${sponsor.title}" can no longer finish as planned. Pitching backup sponsors takes about a day more.`,
          basis: "ai_inference",
          taskId: sponsor.id,
          patch: {
            title: "Replace the title sponsor",
            description: "Pitch three backup sponsors and close at least one before creatives go to print.",
            estimateDays: (sponsor.estimateDays ?? 3) + 1,
          },
          recommended: true,
        });
      }
      if (vendor) {
        const id = c.nextId();
        out.push({
          id: `chg-${id}`,
          type: "add_task",
          agent: "scope",
          summary: "Add task: re-quote vendors at the reduced budget",
          reason: `${vendor.id} "${vendor.title}" was planned against the old budget.`,
          basis: "ai_inference",
          newTask: {
            id,
            title: "Re-quote vendors at the reduced budget",
            description: "Ask AV and catering for a leaner package; keep safety-critical items.",
            ownerId: vendor.ownerId,
            status: "not_started",
            priority: "high",
            estimateDays: 1,
            acceptanceCriteria: ["New quotes within the revised budget"],
            tags: ["vendor", "budget"],
          },
          dependencies: [...(sponsor ? [{ from: sponsor.id, to: id }] : []), { from: id, to: vendor.id }],
          recommended: true,
        });
      }
      if (reg) {
        out.push({
          id: `chg-crit-${reg.id}`,
          type: "append_criteria",
          agent: "scope",
          summary: `Sell paid passes with Pine Labs UPI in ${reg.id} (+1 day)`,
          reason: `Paid passes can cover part of the gap, but ${reg.id} "${reg.title}" only planned free signups.`,
          basis: "ai_inference",
          taskId: reg.id,
          criteria: ["Paid pass checkout via Pine Labs UPI", "Payment receipt on confirmation"],
          estimateDays: (reg.estimateDays ?? 1) + 1,
          recommended: true,
        });
      }
      if (design) {
        out.push({
          id: `chg-crit-${design.id}`,
          type: "append_criteria",
          agent: "scope",
          summary: `Remove the old sponsor from ${design.id} creatives`,
          reason: `${design.id} "${design.title}" carries the old sponsor's logo.`,
          basis: "ai_inference",
          taskId: design.id,
          criteria: ["Old sponsor logo removed", "Space reserved for the new sponsor"],
          recommended: true,
        });
      }
      return out;
    },
  },
  {
    id: "venue-change",
    test: (t) => /(venue|auditorium|hall|ground|location).{0,60}(move|moved|chang|shift|instead|to the)|(moved|shifted|changed).{0,40}(venue|auditorium|hall|ground)/i.test(t),
    interpretation: "The event moves to a different venue on the same date.",
    questions: ["Is there a rain backup for an open-air venue?", "Does the new venue need a fresh permission or a power backup?"],
    build: (p, c) => {
      const approval = c.taskWith("approval");
      const vendor = c.taskWith("vendor");
      const design = c.taskWith("marketing");
      const brief = c.taskWith("volunteers");
      const out: ProposedChange[] = [];
      const id = c.nextId();
      out.push({
        id: `chg-${id}`,
        type: "add_task",
        agent: "scope",
        summary: "Add task: get permission and a rain plan for the new venue",
        reason: approval ? `${approval.id} "${approval.title}" approved the old venue only.` : "The new venue has no approval yet.",
        basis: "ai_inference",
        newTask: {
          id,
          title: "Permission and rain plan for the new venue",
          description: "Estate office sign-off, power backup and a covered fallback space.",
          ownerId: approval?.ownerId ?? c.owner(/lead|manager/i),
          status: "not_started",
          priority: "high",
          estimateDays: 1,
          acceptanceCriteria: ["Written sign-off", "Rain fallback booked"],
          tags: ["venue", "approval"],
        },
        dependencies: [...(vendor ? [{ from: id, to: vendor.id }] : []), ...(brief ? [{ from: id, to: brief.id }] : [])],
        recommended: true,
      });
      if (vendor)
        out.push({
          id: `chg-crit-${vendor.id}`,
          type: "append_criteria",
          agent: "scope",
          summary: `Re-plan AV and stage for the new venue in ${vendor.id} (+1 day)`,
          reason: `${vendor.id} "${vendor.title}" was quoted for the old venue.`,
          basis: "ai_inference",
          taskId: vendor.id,
          criteria: ["Outdoor-rated sound and lights", "Generator backup"],
          estimateDays: (vendor.estimateDays ?? 1) + 1,
          recommended: true,
        });
      if (design)
        out.push({
          id: `chg-crit-${design.id}`,
          type: "append_criteria",
          agent: "scope",
          summary: `Update the venue on ${design.id} creatives`,
          reason: `${design.id} "${design.title}" names the old venue.`,
          basis: "ai_inference",
          taskId: design.id,
          criteria: ["New venue and map on every creative"],
          recommended: true,
        });
      return out;
    },
  },
  {
    id: "guest-change",
    test: (t) => /(chief guest|guest|speaker|keynote)/i.test(t),
    interpretation: "The chief guest's slot or requirements changed.",
    questions: ["Does the new slot clash with the hackathon results or the cultural night?"],
    build: (p, c) => {
      const brief = c.taskWith("volunteers");
      const design = c.taskWith("marketing");
      const out: ProposedChange[] = [];
      if (brief)
        out.push({
          id: `chg-crit-${brief.id}`,
          type: "append_criteria",
          agent: "scope",
          summary: `Rework the run-of-show around the new keynote slot in ${brief.id}`,
          reason: `${brief.id} "${brief.title}" assumes the old keynote time.`,
          basis: "ai_inference",
          taskId: brief.id,
          criteria: ["Keynote at the new slot", "Buffer before and after the keynote"],
          recommended: true,
        });
      if (design)
        out.push({
          id: `chg-crit-${design.id}`,
          type: "append_criteria",
          agent: "scope",
          summary: `Add the guest's foundation to the ${design.id} stage backdrop (+1 day)`,
          reason: `${design.id} "${design.title}" doesn't include the guest's branding.`,
          basis: "ai_inference",
          taskId: design.id,
          criteria: ["Foundation logo approved by the guest's office"],
          estimateDays: (design.estimateDays ?? 1) + 1,
          recommended: true,
        });
      return out;
    },
  },
  /* ---------------- Software ---------------- */
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
    } else if (ch.type === "update_task" && ch.taskId && ch.patch) {
      tasks = tasks.map((t) => (t.id === ch.taskId ? { ...t, ...ch.patch, version: t.version + 1 } : t));
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

  // 2. Overlap a cross-owner hand-off on the critical path (API contract, design placeholder, early booking).
  const PARALLEL_OK = ["frontend", "integration", "design", "marketing", "vendor", "logistics"];
  for (const d of dependencies) {
    const a = byId.get(d.from);
    const b = byId.get(d.to);
    if (!a || !b || a.status === "done" || b.status === "done" || a.ownerId === b.ownerId) continue;
    if (!current.criticalPath.includes(a.id) || !current.criticalPath.includes(b.id)) continue;
    if (!b.tags.some((t) => PARALLEL_OK.includes(t))) continue;
    const api = a.tags.includes("api");
    const design = b.tags.includes("design") || b.tags.includes("marketing");
    candidates.push({
      id: `chg-parallel-${a.id}-${b.id}`,
      type: "remove_dependency",
      agent: "timeline",
      summary: api
        ? `Agree the ${a.title.toLowerCase()} contract first so ${b.id} can start against a mock`
        : design
          ? `Start ${b.id} "${b.title}" now with placeholders for ${a.id}`
          : `Start ${b.id} "${b.title}" in parallel with ${a.id}`,
      reason: api
        ? `${b.id} waits for ${a.id} to finish. With an agreed API contract the two can overlap.`
        : `${b.id} waits for ${a.id}, which sits on the critical path. ${design ? "Placeholders can be swapped once it lands." : "The two can overlap if the owners agree the inputs up front."}`,
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
      summary: `Postpone ${t.id} "${t.title}" until after the deadline`,
      reason: `${t.id} is ${t.priority} priority. Taking it off the critical path frees its owner.`,
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
  const direct = scored.filter((x) => x.s >= 4 || x.t.tags.some((tag) => domains.includes(tag) && ["api", "auth", "payment", "sponsor", "venue", "guest"].includes(tag))).map((x) => x.t);
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
        summary: `Drop ${deferMatch.id} "${deferMatch.title}" from this plan`,
        reason: "The request asks to take this work out of the plan.",
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
  const inferred = [...doneMatches, ...scopeChanges.flatMap((c) => c.reason.match(/\b[A-Z]\d+\b/g) ?? [])].filter(
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
        ? `The deadline slips to ${formatShort(withRec.finishDate)} even with the recommended plan.`
        : naive.feasible
          ? `The deadline holds on ${formatShort(project.deadline)}.`
          : `The deadline holds on ${formatShort(project.deadline)} if you approve the recommended plan.`,
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
