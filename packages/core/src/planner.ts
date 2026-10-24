import { addWorkingDays, formatShort, fromISO, nextWorkingDay, toISO, workingDaysBetween } from "./dates";
import { hasCycle } from "./graph";
import { scheduleProject } from "./schedule";
import type { AgentToolName, Dependency, Member, Project, Task, TaskStatus } from "./types";

/**
 * The Hades agent's planning tools and its built-in command understanding.
 * Every edit returns a new project with a bumped version; the scheduler stays the only source of dates.
 */

const HUES = [268, 18, 330, 196, 152, 42, 8, 220, 290, 110];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 16) || "member";
const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
const bump = (p: Project, patch: Partial<Project>): Project => ({ ...p, ...patch, version: p.version + 1 });

/* ---------------- People ---------------- */

export function addMember(p: Project, input: { name: string; role?: string; email?: string }): { project: Project; member: Member } {
  let id = slug(input.name.split(" ")[0]);
  while (p.members.some((m) => m.id === id)) id = `${id}${p.members.length}`;
  const member: Member = {
    id,
    name: input.name.trim(),
    role: input.role?.trim() || "Team member",
    initials: initials(input.name) || "?",
    hue: HUES[p.members.length % HUES.length],
    email: input.email,
  };
  return { project: bump(p, { members: [...p.members, member] }), member };
}

export function removeMember(p: Project, memberId: string): Project {
  if (p.members[0]?.id === memberId) throw new Error("The event lead can't be removed.");
  const lead = p.members[0].id;
  return bump(p, {
    members: p.members.filter((m) => m.id !== memberId),
    tasks: p.tasks.map((t) => (t.ownerId === memberId ? { ...t, ownerId: lead, version: t.version + 1 } : t)),
  });
}

export function findMember(p: Project, text: string): Member | undefined {
  const q = text.trim().toLowerCase();
  return p.members.find((m) => m.id === q || m.name.toLowerCase() === q || m.name.toLowerCase().split(" ")[0] === q);
}

/* ---------------- Tasks ---------------- */

export function nextTaskId(p: Project): string {
  const n = Math.max(0, ...p.tasks.map((t) => Number(t.id.replace(/\D/g, "")) || 0)) + 1;
  return `T${n}`;
}

export function addTask(
  p: Project,
  input: { title: string; ownerId?: string; estimateDays?: number | null; after?: string[]; description?: string; priority?: Task["priority"] },
): { project: Project; task: Task } {
  const task: Task = {
    id: nextTaskId(p),
    title: input.title.trim(),
    description: input.description ?? "",
    ownerId: input.ownerId && p.members.some((m) => m.id === input.ownerId) ? input.ownerId : p.members[0].id,
    status: "not_started",
    priority: input.priority ?? "medium",
    estimateDays: input.estimateDays ?? 2,
    acceptanceCriteria: [],
    tags: [],
    version: 1,
  };
  const deps: Dependency[] = (input.after ?? []).filter((id) => p.tasks.some((t) => t.id === id)).map((from) => ({ from, to: task.id }));
  return { project: bump(p, { tasks: [...p.tasks, task], dependencies: [...p.dependencies, ...deps] }), task };
}

export function updateTask(p: Project, taskId: string, patch: Partial<Pick<Task, "status" | "estimateDays" | "ownerId" | "title" | "priority">>): Project {
  const t = p.tasks.find((x) => x.id.toLowerCase() === taskId.toLowerCase());
  if (!t) throw new Error(`There is no task ${taskId}.`);
  return bump(p, { tasks: p.tasks.map((x) => (x.id === t.id ? { ...x, ...patch, version: x.version + 1 } : x)) });
}

export function removeTask(p: Project, taskId: string): Project {
  const t = p.tasks.find((x) => x.id.toLowerCase() === taskId.toLowerCase());
  if (!t) throw new Error(`There is no task ${taskId}.`);
  // Keep the chain intact: predecessors of the removed task now lead straight to its successors.
  const preds = p.dependencies.filter((d) => d.to === t.id).map((d) => d.from);
  const succs = p.dependencies.filter((d) => d.from === t.id).map((d) => d.to);
  const bridged = preds.flatMap((from) => succs.map((to) => ({ from, to })));
  return bump(p, {
    tasks: p.tasks.filter((x) => x.id !== t.id),
    dependencies: [...p.dependencies.filter((d) => d.from !== t.id && d.to !== t.id), ...bridged],
  });
}

export function addDependency(p: Project, from: string, to: string): Project {
  const deps = [...p.dependencies, { from, to }];
  if (hasCycle(p.tasks, deps)) throw new Error(`${from} → ${to} would create a loop.`);
  return bump(p, { dependencies: deps });
}

/* ---------------- New events: generated plans ---------------- */

type Domain = "lead" | "sponsor" | "venue" | "marketing" | "registration" | "content" | "ops";
interface Step {
  key: string;
  title: string;
  days: number;
  domain: Domain;
  after: string[];
  priority?: Task["priority"];
}

const BASE: Step[] = [
  { key: "approve", title: "Lock budget, approvals and the event brief", days: 2, domain: "lead", after: [], priority: "high" },
  { key: "venue", title: "Book the venue", days: 3, domain: "venue", after: ["approve"], priority: "high" },
  { key: "sponsor", title: "Pitch and close sponsors", days: 5, domain: "sponsor", after: ["approve"], priority: "high" },
  { key: "content", title: "Confirm speakers and the run of show", days: 4, domain: "content", after: ["approve"] },
  { key: "vendors", title: "Book AV, stage and catering", days: 3, domain: "venue", after: ["venue"] },
  { key: "brand", title: "Design posters and social creatives", days: 3, domain: "marketing", after: ["content", "sponsor"] },
  { key: "reg", title: "Open registrations and ticketing", days: 2, domain: "registration", after: ["venue", "brand"], priority: "high" },
  { key: "promo", title: "Run the promotion campaign", days: 4, domain: "marketing", after: ["reg"] },
  { key: "volunteers", title: "Recruit and brief volunteers", days: 3, domain: "registration", after: ["reg"] },
  { key: "rehearsal", title: "Rehearsal and final walkthrough", days: 1, domain: "lead", after: ["vendors", "volunteers", "promo"], priority: "critical" },
];

const EXTRA: Record<string, Step[]> = {
  hackathon: [
    { key: "problems", title: "Finalise problem statements and judging criteria", days: 3, domain: "content", after: ["approve"] },
    { key: "infra", title: "Arrange Wi-Fi, power and cloud credits", days: 2, domain: "venue", after: ["venue"] },
    { key: "prizes", title: "Confirm prizes and judges", days: 3, domain: "sponsor", after: ["sponsor"] },
  ],
  conference: [
    { key: "cfp", title: "Run the call for speakers and pick talks", days: 5, domain: "content", after: ["approve"] },
    { key: "agenda", title: "Publish the agenda", days: 1, domain: "marketing", after: ["cfp"] },
  ],
  wedding: [
    { key: "decor", title: "Finalise decor and photographer", days: 3, domain: "venue", after: ["venue"] },
    { key: "invites", title: "Send invitations and track RSVPs", days: 4, domain: "registration", after: ["approve"] },
  ],
  party: [
    { key: "guests", title: "Build the guest list and send invites", days: 2, domain: "registration", after: ["approve"] },
    { key: "food", title: "Order cake, food and drinks", days: 3, domain: "venue", after: ["venue"] },
    { key: "decor", title: "Arrange decor, music and games", days: 3, domain: "content", after: ["venue"] },
    { key: "surprise", title: "Plan the surprise moment and the photographer", days: 2, domain: "marketing", after: ["guests"] },
  ],
  fest: [
    { key: "competitions", title: "Plan competitions and the cultural night", days: 4, domain: "content", after: ["approve"] },
    { key: "merch", title: "Order fest merch and goodies", days: 3, domain: "marketing", after: ["sponsor", "brand"] },
  ],
  launch: [
    { key: "demo", title: "Prepare the product demo and press kit", days: 4, domain: "content", after: ["approve"] },
    { key: "press", title: "Invite press and partners", days: 3, domain: "marketing", after: ["demo"] },
  ],
};

const EVENT_WORDS: [RegExp, string][] = [
  [/hackathon|hack day|buildathon/i, "hackathon"],
  [/conference|summit|symposium|meetup|workshop/i, "conference"],
  [/wedding|reception|marriage|sangeet/i, "wedding"],
  [/birthday|party|anniversary|farewell|reunion|celebration|baby shower/i, "party"],
  [/fest|festival|cultural|college/i, "fest"],
  [/launch|product|demo day/i, "launch"],
];

const DOMAIN_WORDS: Record<Domain, RegExp> = {
  lead: /lead|head|organi[sz]er|manager|coordinator/i,
  sponsor: /sponsor|finance|partnership|budget|fund/i,
  venue: /venue|logistic|vendor|ops|operation|hospitality/i,
  marketing: /market|design|social|brand|pr\b|media|content creator/i,
  registration: /registration|volunteer|community|ticket|attendee|rsvp/i,
  content: /speaker|program|content|curat|tech|judge|agenda/i,
  ops: /ops|operation/i,
};

function ownerFor(members: Member[], domain: Domain, i: number): string {
  const hit = members.find((m) => DOMAIN_WORDS[domain].test(m.role));
  if (hit) return hit.id;
  if (domain === "lead" || members.length === 1) return members[0].id;
  const rest = members.slice(1);
  return rest[i % rest.length].id;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Reads dates like "20 Nov", "Nov 20", "2026-11-20", "in 3 weeks" or "next Friday". */
export function parseDate(text: string, now = new Date()): string | null {
  const iso = text.match(/\b(20\d\d)-(\d\d)-(\d\d)\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dm = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i);
  const md = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/i);
  const pick = dm ? { d: Number(dm[1]), m: MONTHS.indexOf(dm[2].toLowerCase().slice(0, 3)) } : md ? { d: Number(md[2]), m: MONTHS.indexOf(md[1].toLowerCase().slice(0, 3)) } : null;
  if (pick) {
    const d = new Date(now.getFullYear(), pick.m, pick.d);
    if (d < now) d.setFullYear(d.getFullYear() + 1);
    return toISO(d);
  }
  const rel = text.match(/\bin\s+(\d+)\s+(day|week|month)s?\b/i);
  if (rel) {
    const d = new Date(now);
    const n = Number(rel[1]);
    if (/day/i.test(rel[2])) d.setDate(d.getDate() + n);
    else if (/week/i.test(rel[2])) d.setDate(d.getDate() + 7 * n);
    else d.setMonth(d.getMonth() + n);
    return toISO(d);
  }
  return null;
}

/** Builds a full dependency-aware plan for a new event, assigned by role. Keeps the current team. */
export function generatePlan(p: Project, input: { name?: string; date?: string | null; brief?: string }, now = new Date()): Project {
  const text = `${input.name ?? ""} ${input.brief ?? ""}`;
  const kind = EVENT_WORDS.find(([re]) => re.test(text))?.[1];
  const steps = [...BASE, ...(kind ? EXTRA[kind] : [])];
  // Extras feed the rehearsal so they sit on the path to the event.
  const rehearsal = steps.find((s) => s.key === "rehearsal")!;
  for (const e of kind ? EXTRA[kind] : []) if (!rehearsal.after.includes(e.key)) rehearsal.after = [...rehearsal.after, e.key];
  const today = toISO(nextWorkingDay(now));
  const deadline = input.date && input.date > today ? input.date : addWorkingDays(today, 20);
  const ids = new Map(steps.map((s, i) => [s.key, `T${i + 1}`]));
  const tasks: Task[] = steps.map((s, i) => ({
    id: ids.get(s.key)!,
    title: s.title,
    description: "",
    ownerId: ownerFor(p.members, s.domain, i),
    status: "not_started",
    priority: s.priority ?? "medium",
    estimateDays: s.days,
    acceptanceCriteria: [],
    tags: [s.domain],
    version: 1,
  }));
  const dependencies = steps.flatMap((s) => s.after.filter((a) => ids.has(a)).map((a) => ({ from: ids.get(a)!, to: ids.get(s.key)! })));
  const name = input.name?.trim() || p.name;
  let planned = bump(p, { name, description: input.brief?.trim() || p.description, startDate: today, deadline, tasks, dependencies });
  // No date given: set the event day two working days after the plan realistically finishes, so it fits.
  if (!(input.date && input.date > today)) planned = { ...planned, deadline: addWorkingDays(scheduleProject(planned).finishDate, 2) };
  return planned;
}

/** Plans a whole new event and adds it to the current graph as its own cluster of linked tasks. */
export function mergePlan(p: Project, input: { name: string; date?: string | null; brief?: string }, now = new Date()): Project {
  const sub = generatePlan({ ...p, tasks: [], dependencies: [] }, input, now);
  const start = Math.max(0, ...p.tasks.map((t) => Number(t.id.replace(/\D/g, "")) || 0));
  const ids = new Map(sub.tasks.map((t, i) => [t.id, `T${start + i + 1}`]));
  const tasks = sub.tasks.map((t) => ({ ...t, id: ids.get(t.id)!, title: `${input.name}: ${t.title}` }));
  const dependencies = sub.dependencies.map((d) => ({ from: ids.get(d.from)!, to: ids.get(d.to)! }));
  const deadline = sub.deadline > p.deadline ? sub.deadline : p.deadline;
  return bump(p, { tasks: [...p.tasks, ...tasks], dependencies: [...p.dependencies, ...dependencies], deadline });
}

/* ---------------- Progress tracker ---------------- */

export interface ProgressReport {
  percentDone: number;
  expectedPercent: number;
  done: number;
  total: number;
  inProgress: string[];
  blocked: string[];
  overdue: { taskId: string; ownerId: string; due: string }[];
  dueSoon: { taskId: string; ownerId: string; due: string }[];
  finishDate: string;
  onTrack: boolean;
  headline: string;
}

export function progressReport(p: Project, now = new Date()): ProgressReport {
  const sched = scheduleProject(p);
  const today = toISO(nextWorkingDay(now));
  const open = p.tasks.filter((t) => t.status !== "done");
  const done = p.tasks.length - open.length;
  const weight = (t: Task) => t.estimateDays ?? 1;
  const totalW = p.tasks.reduce((n, t) => n + weight(t), 0) || 1;
  const doneW = p.tasks.filter((t) => t.status === "done").reduce((n, t) => n + weight(t), 0);
  const expectedW = p.tasks.filter((t) => sched.tasks[t.id] && sched.tasks[t.id].endDate <= today).reduce((n, t) => n + weight(t), 0);
  const due = (t: Task) => addWorkingDays(sched.tasks[t.id].endDate, -1);
  const overdue = open.filter((t) => sched.tasks[t.id] && due(t) < today).map((t) => ({ taskId: t.id, ownerId: t.ownerId, due: due(t) }));
  const soonLimit = addWorkingDays(today, 3);
  const dueSoon = open
    .filter((t) => sched.tasks[t.id] && due(t) >= today && due(t) <= soonLimit)
    .map((t) => ({ taskId: t.id, ownerId: t.ownerId, due: due(t) }));
  const percentDone = Math.round((doneW / totalW) * 100);
  const expectedPercent = Math.round((expectedW / totalW) * 100);
  const onTrack = sched.feasible && overdue.length === 0;
  const slip = sched.feasible ? "" : ` The plan lands ${formatShort(sched.finishDate)}, ${-sched.bufferDays} working day(s) after the event.`;
  const headline = `${percentDone}% done (plan expects ${expectedPercent}% by today). ${
    overdue.length ? `${overdue.length} task(s) overdue.` : "Nothing overdue."
  }${slip}`;
  return {
    percentDone,
    expectedPercent,
    done,
    total: p.tasks.length,
    inProgress: open.filter((t) => t.status === "in_progress").map((t) => t.id),
    blocked: open.filter((t) => t.status === "blocked").map((t) => t.id),
    overdue,
    dueSoon,
    finishDate: sched.finishDate,
    onTrack,
    headline,
  };
}

export function formatProgress(p: Project, r: ProgressReport): string {
  const name = (id: string) => p.members.find((m) => m.id === id)?.name ?? id;
  const title = (id: string) => p.tasks.find((t) => t.id === id)?.title ?? id;
  const lines = [r.headline];
  if (r.overdue.length) lines.push("", "Overdue:", ...r.overdue.map((o) => `• ${o.taskId} ${title(o.taskId)} (${name(o.ownerId)}, was due ${formatShort(o.due)})`));
  if (r.blocked.length) lines.push("", "Blocked:", ...r.blocked.map((id) => `• ${id} ${title(id)}`));
  if (r.dueSoon.length) lines.push("", "Due in the next 3 days:", ...r.dueSoon.map((o) => `• ${o.taskId} ${title(o.taskId)} (${name(o.ownerId)}, ${formatShort(o.due)})`));
  lines.push("", `Event day ${formatShort(p.deadline)} · plan finishes ${formatShort(r.finishDate)} · ${workingDaysBetween(toISO(new Date()), p.deadline)} working days left.`);
  return lines.join("\n");
}

/* ---------------- Built-in command understanding ---------------- */

export interface CommandResult {
  reply: string;
  project?: Project;
  /** Work that needs the server (Google, chats) or another screen (ripple analysis). */
  intents: { tool: AgentToolName; args: Record<string, unknown> }[];
  /** Members created by this command (the server issues their join codes). */
  newMembers?: Member[];
}

const STATUS_WORDS: [RegExp, TaskStatus][] = [
  [/\b(done|complete[d]?|finished|closed)\b/i, "done"],
  [/\b(in progress|started|working on|underway)\b/i, "in_progress"],
  [/\b(blocked|stuck|waiting on)\b/i, "blocked"],
  [/\b(not started|reset|reopen)\b/i, "not_started"],
];

export const AGENT_HELP = [
  "Here's what I can do:",
  "• Plan a hackathon for 200 people on 20 Dec",
  "• Add Meera as design lead (meera@college.edu)",
  "• Add an event Award ceremony for Thiru (1 day) · Add task Print badges for Kavya after T7",
  "• T3 is done · T5 is blocked · give T4 to Rohan",
  "• How are we doing?  (progress tracker)",
  "• Nudge owners of late tasks",
  "• Create a Google workspace  (Drive folder, tracker Sheet, plan Doc)",
  "• Sync the tracker / Pull updates from the tracker sheet",
  "• Read https://docs.google.com/…  ·  Add a note to <Google link>: …",
  "• Or describe a change (\"the venue moved to Friday\") and I'll trace its ripple.",
].join("\n");

const GOOGLE_URL = /https:\/\/docs\.google\.com\/(?:document|spreadsheets)\/d\/[\w-]+[^\s]*/i;

export function runCommand(p: Project, raw: string, now = new Date(), opts: { maxTasks?: number } = {}): CommandResult {
  const text = raw.trim();
  const lower = text.toLowerCase();
  const url = text.match(GOOGLE_URL)?.[0];

  if (/^(help|\?|what can you do)/i.test(text)) return { reply: AGENT_HELP, intents: [] };

  // Google Workspace
  if (url && /\b(add|append|write|note|log)\b/i.test(lower)) {
    const note = text.replace(url, "").replace(/^.*?(?:add|append|write|log)\s+(?:a\s+)?(?:note\s+)?(?:to\s*)?:?/i, "").replace(/^[:\s-]+/, "").trim();
    return { reply: "Adding that to the file…", intents: [{ tool: "google_append", args: { url, text: note || text } }] };
  }
  if (url) return { reply: "Reading the file…", intents: [{ tool: "google_read", args: { url } }] };
  if (/\b(google|drive)\b.*\b(workspace|folder|set ?up)\b|\bcreate\b.*\b(workspace|drive folder)\b/i.test(lower))
    return { reply: "Setting up the Google workspace…", intents: [{ tool: "google_create_workspace", args: {} }] };
  if (/\b(pull|import|read|fetch)\b.*\b(tracker|sheet)\b|\bupdates? from (the )?(tracker|sheet)\b/i.test(lower))
    return { reply: "Reading the tracker sheet…", intents: [{ tool: "google_pull_tracker", args: {} }] };
  if (/\b(sync|push|update|export)\b.*\b(tracker|sheet)\b|\b(create|make)\b.*\b(sheet|tracker)\b/i.test(lower))
    return { reply: "Syncing the tracker sheet…", intents: [{ tool: "google_sync_tracker", args: {} }] };
  if (/\b(create|write|make|draft)\b.*\b(doc|document|brief)\b/i.test(lower))
    return { reply: "Writing the plan doc…", intents: [{ tool: "google_create_doc", args: {} }] };
  if (/\bcalendar\b/i.test(lower)) return { reply: "Syncing Google Calendar…", intents: [{ tool: "calendar_sync", args: {} }] };

  // Progress tracker
  if (/\b(nudge|remind|chase|ping)\b/i.test(lower)) return { reply: "Nudging owners…", intents: [{ tool: "nudge_owners", args: {} }] };
  if (/\b(progress|status report|how are we|on track|behind|overdue|late tasks|what'?s late|report)\b/i.test(lower)) {
    return { reply: formatProgress(p, progressReport(p, now)), intents: [] };
  }

  // New event plan: a whole plan from one sentence. "add …" never plans; "called X" on an existing plan adds one item.
  const EVENT_NOUN = /\b(event|fest|festival|conference|summit|hackathon|meetup|workshop|wedding|launch|party|birthday|anniversary|farewell|reunion|celebration|ceremony|expo|match|tournament|concert|night|day)\b/i;
  const planMatch = text.match(/^(?:please\s+)?(?:plan|organi[sz]e|arrange|throw|host|set up|create|make|start|new|build|generate)\s+(?:(?:a|an|the|our|my|me)\s+)?(.+)$/i);
  const isItem = /\b(task|activity|session|step|todo|milestone|reminder)\b/i.test(text) || (/\b(called|named)\b/i.test(text) && p.tasks.length > 0);
  if (planMatch && !isItem && EVENT_NOUN.test(planMatch[1])) {
    const date = parseDate(text, now);
    let name = planMatch[1].replace(/^(?:full\s+)?(?:plan\s+)?(?:for\s+)?/i, "").trim();
    const forEvent = name.match(/^(?:event|party|function|celebration)\s+(?:for|of)\s+(.+)$/i);
    if (forEvent) name = forEvent[1];
    name = name
      .replace(/^(?:to\s+)?(?:organi[sz]e|plan|host|run|throw|arrange|do|manage)\s+(?:(?:a|an|the|our|my)\s+)?/i, "")
      .replace(/\s+for\s+\d+.*$/i, "")
      .replace(/\s+(?:on|by|in|at)\s+.*$/i, "")
      .trim()
      .replace(/^\w/, (c) => c.toUpperCase());
    if (!name) name = "New event";
    if (p.tasks.length) {
      const project = mergePlan(p, { name, date, brief: text }, now);
      const added = project.tasks.length - p.tasks.length;
      const sched = scheduleProject(project);
      return {
        project,
        intents: [],
        reply: `Planned "${name}" and added its ${added} tasks to the graph, owners assigned by role. ${
          sched.feasible ? `The event date still holds${sched.bufferDays > 0 ? ` with ${sched.bufferDays} day(s) to spare` : ""}.` : `The plan now lands ${formatShort(sched.finishDate)}, after the event date.`
        } To start fresh instead, press Reset and ask again.`,
      };
    }
    let project = generatePlan(p, { name, date, brief: text }, now);
    const full = project.tasks.length;
    if (opts.maxTasks && full > opts.maxTasks) project = trimPlan(project, opts.maxTasks);
    const trimmed = project.tasks.length < full;
    const sched = scheduleProject(project);
    return {
      project,
      intents: [],
      reply: `Planned "${project.name}" for ${formatShort(project.deadline)}: ${project.tasks.length} tasks across ${project.members.length} people, chained by dependencies.${trimmed ? ` The free plan holds ${opts.maxTasks} tasks, so I kept the essential ones (${full - project.tasks.length} optional steps left out; Pro lifts the cap).` : ""} ${
        sched.feasible ? `It fits, with ${sched.bufferDays} working day(s) to spare.` : `It's tight: the plan lands ${formatShort(sched.finishDate)}. Add people or trim scope.`
      }${project.members.length < 3 ? " Add your team (\"Add Meera as marketing\") and I'll reassign by role." : ""}`,
    };
  }

  // People: only when it clearly names a person ("Add Meera as marketing", "Invite dev@x.com", "Add Ravi to the team").
  const person = parsePerson(text);
  if (person) {
    const out = addMember(p, person);
    const reassigned = rebalance(out.project, out.member);
    return {
      project: reassigned.project,
      newMembers: [out.member],
      intents: [],
      reply: `Added ${out.member.name} (${out.member.role}) to the team.${reassigned.moved.length ? ` Handed over ${reassigned.moved.join(", ")} to match the role.` : ""}`,
    };
  }
  const removePerson = text.match(/^(?:remove|drop)\s+([A-Za-z][\w .'-]*?)(?:\s+from\s+(?:the\s+)?team)?\s*\.?$/i);
  if (removePerson) {
    const m = findMember(p, removePerson[1]);
    if (m) return { project: removeMember(p, m.id), intents: [], reply: `Removed ${m.name}. Their tasks went back to ${p.members[0].name}.` };
  }

  // Tasks, events and activities: anything you "add", "create" or "schedule" that isn't a person goes on the graph.
  const item = parseItem(p, text);
  if (item) {
    let out = addTask(p, { title: item.title, ownerId: item.ownerId, estimateDays: item.days, after: item.after });
    let project = out.project;
    if (!item.after.length) project = connect(project, out.task.id);
    const sched = scheduleProject(project);
    const st = sched.tasks[out.task.id];
    const owner = p.members.find((m) => m.id === out.task.ownerId)?.name;
    return {
      project,
      intents: [],
      reply: `Added ${out.task.id} "${out.task.title}" to the plan for ${owner}, ${formatShort(st.startDate)} → ${formatShort(st.endDate)}. It's on the graph now. ${
        sched.feasible ? "The event date still holds." : `Heads up: the plan now lands ${formatShort(sched.finishDate)}.`
      }`,
    };
  }
  const reassign = text.match(/^(?:give|assign|move|hand)\s+([A-Za-z]?\d+)\s+(?:over\s+)?to\s+([A-Za-z]\w*)/i);
  if (reassign) {
    const m = findMember(p, reassign[2]);
    if (!m) return { reply: `I don't know ${reassign[2]} yet. Add them first.`, intents: [] };
    return { project: updateTask(p, reassign[1], { ownerId: m.id }), intents: [], reply: `${reassign[1].toUpperCase()} is now ${m.name}'s.` };
  }
  const delT = text.match(/^(?:remove|delete|drop|cancel|scrap)\s+(?:task\s+)?([A-Za-z]?\d+)\b/i);
  if (delT) return { project: removeTask(p, delT[1]), intents: [], reply: `Removed ${delT[1].toUpperCase()} and reconnected its dependencies.` };
  // Delete by name: "delete the promotion campaign, it's not needed". Never treated as a change to trace.
  const delName = text.match(/^(?:remove|delete|drop|cancel|scrap|get rid of|take out)\s+(.+)$/i);
  if (delName && p.tasks.length) {
    const hit = findTaskByName(p, delName[1]);
    if (hit.task) {
      const project = removeTask(p, hit.task.id);
      const sched = scheduleProject(project);
      return {
        project,
        intents: [],
        reply: `Removed ${hit.task.id} "${hit.task.title}" and reconnected its dependencies. ${sched.feasible ? `The event date holds${sched.bufferDays > 0 ? ` with ${sched.bufferDays} day(s) to spare` : ""}.` : `The plan lands ${formatShort(sched.finishDate)}.`}`,
      };
    }
    return {
      intents: [],
      reply: hit.candidates.length
        ? `Which one do you mean? ${hit.candidates.map((t) => `${t.id} "${t.title}"`).join(", ")}. Say "delete T${hit.candidates[0].id.replace(/\D/g, "")}".`
        : `I couldn't find a task matching "${delName[1].replace(/[,.].*$/, "").trim()}". Say its ID, e.g. "delete T6".`,
    };
  }
  const taskRef = text.match(/\b([A-Za-z]\d{1,3})\b/);
  const status = STATUS_WORDS.find(([re]) => re.test(lower))?.[1];
  if (taskRef && status && p.tasks.some((t) => t.id.toLowerCase() === taskRef[1].toLowerCase())) {
    const project = updateTask(p, taskRef[1], { status });
    const r = progressReport(project, now);
    return { project, intents: [], reply: `Marked ${taskRef[1].toUpperCase()} ${status.replace("_", " ")}. ${r.headline}` };
  }
  const est = text.match(/\b([A-Za-z]\d{1,3})\b.*?\b(\d+(?:\.\d+)?)\s*(?:more\s+)?(?:d|days?)\b/i);
  if (est && p.tasks.some((t) => t.id.toLowerCase() === est[1].toLowerCase()) && /\b(takes?|needs?|estimate|will be|more)\b/i.test(lower)) {
    const t = p.tasks.find((x) => x.id.toLowerCase() === est[1].toLowerCase())!;
    const days = /\bmore\b/i.test(lower) ? (t.estimateDays ?? 0) + Number(est[2]) : Number(est[2]);
    const project = updateTask(p, t.id, { estimateDays: days });
    const sched = scheduleProject(project);
    return { project, intents: [], reply: `${t.id} is now ${days} day(s). ${sched.feasible ? "The event date holds." : `The plan now lands ${formatShort(sched.finishDate)}, after the event.`}` };
  }
  const rename = text.match(/^(?:rename|call)\s+(?:the\s+)?event\s+(?:to\s+)?["“]?(.+?)["”]?$/i);
  if (rename) return { project: bump(p, { name: rename[1] }), intents: [], reply: `Renamed the event to "${rename[1]}".` };
  const move = text.match(/^(?:move|set|change)\s+(?:the\s+)?(?:event|date|deadline)\b.*/i);
  const moved = move ? parseDate(text, now) : null;
  if (moved) {
    const project = bump(p, { deadline: moved });
    const sched = scheduleProject(project);
    return { project, intents: [], reply: `Event day is now ${formatShort(moved)}. ${sched.feasible ? `The plan fits with ${sched.bufferDays} day(s) to spare.` : `The plan lands ${formatShort(sched.finishDate)}: it doesn't fit yet.`}` };
  }

  // Anything else is treated as a change to trace through the plan.
  return { reply: "That sounds like a change. Tracing its ripple through the plan…", intents: [{ tool: "analyze_change", args: { request: text } }] };
}

/* ---------------- Reading people vs. plan items ---------------- */

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;
/** Words that start a plan item, never a person's name. */
const NOT_A_NAME = /^(a|an|the|some|for|to|on|at|in|by|with|new|another|task|event|activity|session|item|step|todo|meeting|call|workshop|talk|reminder|milestone|deadline|booking|book|catering|food|reel|video|stage|venue)\b/i;
const ITEM_WORDS = /\b(task|event|activity|session|item|step|todo|to-do|meeting|call|workshop|talk|reminder|milestone|booking|catering|shoot|reel|rehearsal|ceremony|keynote|panel)\b/i;

export function parsePerson(text: string): { name: string; role?: string; email?: string } | null {
  const email = text.match(EMAIL)?.[0];
  const m = text.match(/^(?:add|invite|onboard)\s+(.+?)\s*$/i);
  if (!m) return null;
  let rest = m[1].replace(/[(<]?\s*[\w.+-]+@[\w-]+\.[\w.]+\s*[)>]?/, " ").replace(/\s+/g, " ").trim().replace(/\.$/, "");
  const explicitTeam = /\b(to|into|on)\s+(the|our|my)\s+team\b|\b(as\s+a\s+)?(teammate|team member|member|volunteer)\b/i.test(rest);
  const asRole = rest.match(/^(.+?)\s+as\s+(?:the\s+|our\s+|a\s+|an\s+)?(.+)$/i);
  let name = "";
  let role: string | undefined;
  if (asRole) {
    name = asRole[1];
    role = asRole[2].replace(/\s+(to|into|on)\s+(the|our|my)\s+team$/i, "");
  } else if (explicitTeam || email) {
    name = rest.replace(/\s+(to|into|on)\s+(the|our|my)\s+team\b.*$/i, "").replace(/\s+for\s+.+$/i, "");
    const forRole = rest.match(/\s+for\s+(.+)$/i);
    role = forRole?.[1];
  } else return null;
  name = name.trim();
  // A person's name: 1-3 words, no plan-item words, doesn't start like a sentence.
  if (!name || NOT_A_NAME.test(name) || ITEM_WORDS.test(name) || name.split(/\s+/).length > 3) return email && !name ? { name: email.split("@")[0], role, email } : null;
  if (!email && !asRole && !explicitTeam) return null;
  const pretty = name.replace(/\b\w/g, (c) => c.toUpperCase());
  return { name: pretty, role: role?.trim() || undefined, email };
}

export function parseItem(p: Project, text: string): { title: string; ownerId?: string; days: number; after: string[] } | null {
  const m = text.match(/^(?:add|create|schedule|plan in|put in|new|include)\s+(.+)$/i);
  if (!m) return null;
  let rest = m[1].trim().replace(/\.$/, "");
  // Strip the item word itself: "an event for…", "a task:", "task".
  rest = rest.replace(/^(?:a|an|the|another|new)?\s*(?:task|event|activity|session|item|step|todo|to-do|sub-?event|milestone)\b\s*:?\s*/i, "");
  const days = Number(rest.match(/\(?\s*(\d+(?:\.\d+)?)\s*(?:days?|d)\b\s*\)?/i)?.[1] ?? 0) || 2;
  rest = rest.replace(/\(?\s*\d+(?:\.\d+)?\s*(?:days?|d)\b\s*\)?/i, " ");
  const afterMatch = rest.match(/\s+after\s+((?:[A-Za-z]\d{1,3}[\s,]*(?:and\s+)?)+)/i);
  const after = afterMatch ? afterMatch[1].split(/[\s,]+|and/).filter(Boolean).map((x) => x.toUpperCase()).filter((id) => p.tasks.some((t) => t.id === id)) : [];
  if (afterMatch) rest = rest.replace(afterMatch[0], " ");
  // Owner: any teammate mentioned by name ("for director Thiru", "by Meera", "Rohan to …").
  let ownerId: string | undefined;
  for (const mem of p.members) {
    const first = mem.name.split(" ")[0];
    if (first.length < 2) continue;
    const re = new RegExp(`(?:\\b(?:for|by|with|assigned to|owner|owned by)\\s+)?(?:\\b[a-z]+\\s+)?\\b${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b(?:\\s+to\\b)?`, "i");
    if (new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(rest)) {
      ownerId = mem.id;
      // Remove "for director Thiru to" style phrases from the title, keep the action.
      const phrase = rest.match(new RegExp(`(?:\\b(?:for|by|with|assigned to|owned by)\\s+)(?:[a-z]+\\s+)?${first}\\b(?:\\s+to\\b)?`, "i")) ?? rest.match(re);
      if (phrase) rest = rest.replace(phrase[0], " ");
      break;
    }
  }
  const title = rest
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:for|to|called|named|on|about|:)\s+/i, "")
    .replace(/^(?:a|an|the)\s+/i, "")
    .replace(/^\w/, (c) => c.toUpperCase());
  if (title.length < 3) return null;
  return { title, ownerId, days, after };
}

/** Hooks a new item into the plan so it sits on the path to the event: after the kickoff, before the final step. */
function connect(p: Project, id: string): Project {
  const others = p.tasks.filter((t) => t.id !== id);
  if (!others.length) return p;
  const hasPred = new Set(p.dependencies.map((d) => d.to));
  const hasSucc = new Set(p.dependencies.map((d) => d.from));
  const root = others.find((t) => !hasPred.has(t.id));
  const sinks = others.filter((t) => !hasSucc.has(t.id));
  const last = sinks[sinks.length - 1];
  let out = p;
  for (const [from, to] of [
    [root?.id, id],
    [id, last?.id],
  ] as const) {
    if (!from || !to || from === to) continue;
    try {
      out = addDependency(out, from, to);
    } catch {}
  }
  return out;
}

/** Repairs teammates that an older parser created from plan items ("an event", "for booking catering"). */
export function repairMisreadMembers(p: Project): { project: Project; fixed: string[] } {
  const bogus = p.members.slice(1).filter((m) => !m.email && (NOT_A_NAME.test(m.name) || ITEM_WORDS.test(m.name)));
  if (!bogus.length) return { project: p, fixed: [] };
  let project = p;
  const fixed: string[] = [];
  for (const m of bogus) {
    project = removeMember(project, m.id);
    const words = `${m.name} ${m.role && m.role !== "Team member" ? `for ${m.role}` : ""}`.trim();
    const item = parseItem(project, `add ${words}`);
    if (item && !/^an? event$/i.test(item.title)) {
      const out = addTask(project, { title: item.title, ownerId: item.ownerId, estimateDays: item.days, after: item.after });
      project = connect(out.project, out.task.id);
      fixed.push(`${out.task.id} ${out.task.title}`);
    } else fixed.push(`removed "${m.name}"`);
  }
  return { project, fixed };
}

const STOP = new Set(["the", "a", "an", "of", "for", "to", "and", "our", "my", "this", "that", "its", "it", "is", "not", "no", "needed", "need", "anymore", "any", "more", "event", "task", "activity", "step", "item", "from", "plan", "pipeline", "please", "since", "because", "as", "we", "dont", "don't", "do", "want", "wont", "won't", "required", "unnecessary"]);
const stem = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/(ing|ion|ions|ers|er|es|ed|s)$/, "");

/** Finds one task a person describes in words ("the promotion campaign"). Several close matches return as candidates. */
export function findTaskByName(p: Project, phrase: string): { task?: Task; candidates: Task[] } {
  const cleaned = phrase.replace(/\b(?:it'?s|its|because|since|as|we)\b.*$/i, "").replace(/[,.].*$/, "");
  const words = cleaned.split(/\s+/).map(stem).filter((w) => w.length > 1 && !STOP.has(w));
  if (!words.length) return { candidates: [] };
  const scored = p.tasks
    .map((t) => {
      const title = t.title.split(/\s+/).map(stem);
      const hits = words.filter((w) => title.some((x) => x === w || (w.length > 3 && (x.startsWith(w) || w.startsWith(x)) && x.length > 3))).length;
      return { t, hits, score: hits / words.length };
    })
    .filter((x) => x.hits > 0 && x.score >= 0.5)
    .sort((a, b) => b.score - a.score || b.hits - a.hits);
  if (!scored.length) return { candidates: [] };
  const top = scored.filter((x) => x.score === scored[0].score && x.hits === scored[0].hits);
  return top.length === 1 ? { task: top[0].t, candidates: [] } : { candidates: top.slice(0, 4).map((x) => x.t) };
}

/** Shrinks a generated plan to fit a cap by dropping the least essential steps and reconnecting their neighbours. */
export function trimPlan(p: Project, max: number): Project {
  let out = p;
  const rank = (t: Task) => ({ low: 0, medium: 1, high: 2, critical: 3 })[t.priority];
  while (out.tasks.length > max) {
    const victim = [...out.tasks]
      .filter((t) => t.priority !== "critical" && !t.tags.includes("lead"))
      .sort((a, b) => rank(a) - rank(b) || Number(b.id.replace(/\D/g, "")) - Number(a.id.replace(/\D/g, "")))[0];
    if (!victim) break;
    out = removeTask(out, victim.id);
  }
  return out;
}

/** After adding someone, hand them unstarted tasks that match their role better than the current owner. */
function rebalance(p: Project, m: Member): { project: Project; moved: string[] } {
  const domain = (Object.keys(DOMAIN_WORDS) as Domain[]).find((d) => d !== "lead" && DOMAIN_WORDS[d].test(m.role));
  if (!domain) return { project: p, moved: [] };
  const moved: string[] = [];
  const tasks = p.tasks.map((t) => {
    const owner = p.members.find((x) => x.id === t.ownerId);
    if (t.status === "not_started" && t.tags.includes(domain) && owner && !DOMAIN_WORDS[domain].test(owner.role)) {
      moved.push(t.id);
      return { ...t, ownerId: m.id, version: t.version + 1 };
    }
    return t;
  });
  return { project: moved.length ? { ...p, tasks } : p, moved };
}

export const blankProject = (id: string, lead: { name: string; email?: string }, now = new Date()): Project => {
  const today = toISO(nextWorkingDay(now));
  return {
    id,
    name: "New event",
    description: "",
    startDate: today,
    deadline: addWorkingDays(today, 20),
    version: 1,
    members: [{ id: slug(lead.name.split(" ")[0]), name: lead.name, role: "Event lead", initials: initials(lead.name), hue: HUES[0], email: lead.email }],
    tasks: [],
    dependencies: [],
  };
};

export const daysUntil = (iso: string, now = new Date()) => Math.round((fromISO(iso).getTime() - fromISO(toISO(now)).getTime()) / 864e5);
