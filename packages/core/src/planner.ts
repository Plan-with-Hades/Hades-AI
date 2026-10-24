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
  return bump(p, { name, description: input.brief?.trim() || p.description, startDate: today, deadline, tasks, dependencies });
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
  "• Add task Print badges for Kavya (2 days) after T7",
  "• T3 is done · T5 is blocked · give T4 to Rohan",
  "• How are we doing?  (progress tracker)",
  "• Nudge owners of late tasks",
  "• Create a Google workspace  (Drive folder, tracker Sheet, plan Doc)",
  "• Sync the tracker / Pull updates from the tracker sheet",
  "• Read https://docs.google.com/…  ·  Add a note to <Google link>: …",
  "• Or describe a change (\"the venue moved to Friday\") and I'll trace its ripple.",
].join("\n");

const GOOGLE_URL = /https:\/\/docs\.google\.com\/(?:document|spreadsheets)\/d\/[\w-]+[^\s]*/i;

export function runCommand(p: Project, raw: string, now = new Date()): CommandResult {
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

  // New event plan
  const planMatch = text.match(/^(?:plan|organi[sz]e|set up|create|new|start)\s+(?:a|an|the|our|my)?\s*(.+)$/i);
  if (planMatch && /\b(event|fest|festival|conference|summit|hackathon|meetup|workshop|wedding|launch|party|day|night|expo|match|tournament|concert)\b/i.test(planMatch[1])) {
    const date = parseDate(text, now);
    const name = planMatch[1]
      .replace(/\b(on|for|by|in|at)\b.*$/i, "")
      .trim()
      .replace(/^\w/, (c) => c.toUpperCase());
    const project = generatePlan(p, { name, date, brief: text }, now);
    const sched = scheduleProject(project);
    return {
      project,
      intents: [],
      reply: `Planned "${project.name}" for ${formatShort(project.deadline)}: ${project.tasks.length} tasks across ${project.members.length} people, chained by dependencies. ${
        sched.feasible ? `It fits, with ${sched.bufferDays} working day(s) to spare.` : `It's tight: the plan lands ${formatShort(sched.finishDate)}. Add people or trim scope.`
      }${project.members.length < 3 ? " Add your team (\"Add Meera as marketing\") and I'll reassign by role." : ""}`,
    };
  }

  // People
  const addPerson = text.match(/^(?:add|invite|onboard)\s+([A-Za-z][\w .'-]*?)\s+(?:as|to|for)\s+(?:the\s+|our\s+|a\s+|an\s+)?(.+?)(?:\s+team)?\s*(?:[(<]?\s*([\w.+-]+@[\w-]+\.[\w.]+)\s*[)>]?)?\s*\.?$/i);
  if (addPerson && !/^task\b/i.test(addPerson[1])) {
    const out = addMember(p, { name: addPerson[1], role: addPerson[2].replace(/[\w.+-]+@[\w-]+\.[\w.]+/, "").trim(), email: addPerson[3] });
    const reassigned = rebalance(out.project, out.member);
    return {
      project: reassigned.project,
      newMembers: [out.member],
      intents: [],
      reply: `Added ${out.member.name} (${out.member.role}).${reassigned.moved.length ? ` Handed over ${reassigned.moved.join(", ")} to match the role.` : ""} Share their join code from Connect team so their agent can brief them on Telegram or WhatsApp.`,
    };
  }
  const removePerson = text.match(/^(?:remove|drop)\s+([A-Za-z][\w .'-]*?)(?:\s+from\s+(?:the\s+)?team)?\s*\.?$/i);
  if (removePerson) {
    const m = findMember(p, removePerson[1]);
    if (m) return { project: removeMember(p, m.id), intents: [], reply: `Removed ${m.name}. Their tasks went back to ${p.members[0].name}.` };
  }

  // Tasks
  const addT = text.match(/^(?:add|create|new)\s+(?:a\s+)?task\s*:?\s+["“]?(.+?)["”]?(?:\s+for\s+([A-Za-z]\w*))?(?:\s*\(?\s*(\d+(?:\.\d+)?)\s*(?:d|days?)\s*\)?)?(?:\s+after\s+([\w,\s]+))?\s*\.?$/i);
  if (addT) {
    const owner = addT[2] ? findMember(p, addT[2]) : undefined;
    const after = addT[4] ? addT[4].split(/[\s,]+/).filter(Boolean).map((s) => s.toUpperCase()) : [];
    const out = addTask(p, { title: addT[1], ownerId: owner?.id, estimateDays: addT[3] ? Number(addT[3]) : 2, after });
    const sched = scheduleProject(out.project);
    const st = sched.tasks[out.task.id];
    return {
      project: out.project,
      intents: [],
      reply: `Added ${out.task.id} "${out.task.title}" for ${p.members.find((m) => m.id === out.task.ownerId)?.name}, ${formatShort(st.startDate)} → ${formatShort(st.endDate)}. ${sched.feasible ? "The event date still holds." : `Heads up: the plan now lands ${formatShort(sched.finishDate)}.`}`,
    };
  }
  const reassign = text.match(/^(?:give|assign|move|hand)\s+([A-Za-z]?\d+)\s+(?:over\s+)?to\s+([A-Za-z]\w*)/i);
  if (reassign) {
    const m = findMember(p, reassign[2]);
    if (!m) return { reply: `I don't know ${reassign[2]} yet. Add them first.`, intents: [] };
    return { project: updateTask(p, reassign[1], { ownerId: m.id }), intents: [], reply: `${reassign[1].toUpperCase()} is now ${m.name}'s.` };
  }
  const delT = text.match(/^(?:remove|delete|drop|cancel)\s+(?:task\s+)?([A-Za-z]?\d+)\b/i);
  if (delT) return { project: removeTask(p, delT[1]), intents: [], reply: `Removed ${delT[1].toUpperCase()} and reconnected its dependencies.` };
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
