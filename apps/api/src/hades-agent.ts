import { FREE_LIMITS, PRO_PRICE_INR, freeLimitMessage, addTask, formatProgress, hasPro, formatShort, progressReport, runCommand, updateTask, type AgentAction, type AgentTurn, type MemberMessage, type WorkspaceState } from "@hades/core";
import { WORKSPACE_SCOPES } from "./auth";
import { deliver } from "./agents";
import { syncCalendar } from "./google-calendar";
import { appendToGoogleFile, createEventWorkspace, createPlanDoc, extractTasks, pullTracker, readGoogleFile, syncTracker } from "./google-workspace";
import { getWorkspace, newId, roleIn, updateWorkspace, type StoredUser } from "./store";
import { inviteMember } from "./invites";

/**
 * The Hades agent behind the console's prompt box. It understands plain commands (people, tasks, new event plans,
 * progress), and drives Google Workspace with the organiser's own Google account. Every step lands in the audit log.
 */
const MAX_THREAD = 80;

export interface AgentOutcome {
  turn: AgentTurn;
  /** Set when the message is a change to trace: the console opens the ripple review for it. */
  analyze?: string;
  /** Set when the organiser must grant Google access first. */
  connectGoogle?: boolean;
  /** The request needs Hades Pro: the console opens the upgrade window. */
  upgrade?: boolean;
  /** The analysis is a what-if: the console shows it as a simulation. */
  simulate?: boolean;
}

const hasWorkspace = (u: StoredUser | null) => !!u && WORKSPACE_SCOPES.every((s) => u.google?.scope?.includes(s));

export async function runAgent(workspaceId: string, user: StoredUser | null, message: string): Promise<AgentOutcome> {
  const w = getWorkspace(workspaceId);
  const actor = user?.name ?? w.project.members[0].name;
  const userTurn: AgentTurn = { id: newId(8), at: new Date().toISOString(), role: "user", text: message, by: actor };
  const cmd = runCommand(w.project, message, new Date(), { maxTasks: hasPro(w) ? undefined : FREE_LIMITS.tasks });
  const role = w.ownerId ? roleIn(w, user) : "manager";
  if (role !== "manager" && !memberMayApply(w, user, cmd)) {
    const agentTurn: AgentTurn = {
      id: newId(8),
      at: new Date().toISOString(),
      role: "agent",
      text: "Only the event manager can change the plan. You can update your own tasks (\"T3 is done\", \"T4 needs 2 more days\") or ask \"How are we doing?\".",
      engine: "rules",
    };
    updateWorkspace(workspaceId, (x) => (x.agentThread = [...(x.agentThread ?? []), userTurn, agentTurn].slice(-MAX_THREAD)));
    return { turn: agentTurn };
  }
  // Pro-only tools: ripple analysis, Google Workspace and Calendar, nudges to teammates' chats.
  const PRO_WHAT: Record<string, string> = { analyze_change: "Change analysis", nudge_owners: "Nudging teammates", calendar_sync: "Google Calendar sync" };
  const proNeeded = cmd.intents.find((i) => i.tool in PRO_WHAT || i.tool.startsWith("google_"));
  if (proNeeded && !hasPro(w)) {
    const what = PRO_WHAT[proNeeded.tool] ?? "Google Workspace";
    const agentTurn: AgentTurn = {
      id: newId(8),
      at: new Date().toISOString(),
      role: "agent",
      text: `${what} is a Hades Pro feature. Your free trial has ended, so I can still plan, add people and tasks, track progress and mark things done, but this one needs Pro (₹${PRO_PRICE_INR}/month).`,
      engine: "rules",
    };
    updateWorkspace(workspaceId, (x) => (x.agentThread = [...(x.agentThread ?? []), userTurn, agentTurn].slice(-MAX_THREAD)));
    return { turn: agentTurn, upgrade: true };
  }
  const actions: AgentAction[] = [];
  let reply = cmd.reply;
  let analyze: string | undefined;
  let simulate = false;
  let connectGoogle = false;

  const capped = cmd.project && !hasPro(w) ? freeLimitMessage(w.project, cmd.project) : null;
  if (capped) {
    const agentTurn: AgentTurn = {
      id: newId(8),
      at: new Date().toISOString(),
      role: "agent",
      text: `${capped} Remove something ("delete T6"), or upgrade to Hades Pro (₹${PRO_PRICE_INR}/month) for unlimited events, tasks and people.`,
      engine: "rules",
    };
    updateWorkspace(workspaceId, (x) => (x.agentThread = [...(x.agentThread ?? []), userTurn, agentTurn].slice(-MAX_THREAD)));
    return { turn: agentTurn, upgrade: true };
  }
  if (cmd.project) {
    const before = w.project.version;
    updateWorkspace(workspaceId, (x) => {
      x.project = cmd.project!;
      for (const m of cmd.newMembers ?? []) x.joinCodes[m.id] = `${x.id}-${m.id}`;
      x.history.push({ id: newId(8), at: new Date().toISOString(), actor: "hades-agent", action: "plan_edited", summary: `${message} → ${reply.split("\n")[0]}`, projectVersion: x.project.version });
    });
    actions.push({ id: newId(6), tool: "update_task", args: {}, summary: `Plan v${before} → v${cmd.project.version}`, status: "done" });
    for (const m of cmd.newMembers ?? []) {
      if (!m.email) continue;
      try {
        const inv = await inviteMember(workspaceId, user, m.id);
        reply += inv.emailed
          ? ` I emailed ${m.name} an invite from your Gmail${inv.shared ? " and shared the Drive folder" : ""}.`
          : ` Invite link for ${m.name}: ${inv.link}${inv.note ? ` (${inv.note})` : ""}`;
      } catch (e) {
        reply += ` (Invite failed: ${(e as Error).message})`;
      }
    }
  }

  for (const intent of cmd.intents) {
    const action: AgentAction = { id: newId(6), tool: intent.tool, args: intent.args, summary: intent.tool.replace(/_/g, " "), status: "done" };
    try {
      if (intent.tool === "analyze_change") {
        analyze = String(intent.args.request);
        simulate = intent.args.simulate === true;
        continue;
      }
      if (intent.tool === "nudge_owners") {
        reply = await nudgeOwners(workspaceId);
        continue;
      }
      if (intent.tool.startsWith("google_") || intent.tool === "calendar_sync") {
        if (!user) {
          reply = "Sign in with Google first, then connect Google Workspace so I can work in your Drive, Docs, Sheets and Calendar.";
          connectGoogle = true;
          action.status = "failed";
          continue;
        }
        if (!hasWorkspace(user)) {
          reply = "I need access to your Google Docs, Sheets, Drive files and Calendar for that. Tap \"Connect Google Workspace\" and ask me again.";
          connectGoogle = true;
          action.status = "failed";
          continue;
        }
        const out = await runGoogle(workspaceId, user, intent.tool, intent.args);
        reply = out.reply;
        action.url = out.url;
        action.summary = out.summary;
      }
    } catch (e) {
      const err = e as Error & { connect?: boolean };
      action.status = "failed";
      action.result = err.message;
      reply = `That didn't work: ${err.message}`;
      if (err.connect) connectGoogle = true;
    } finally {
      if (intent.tool !== "analyze_change") actions.push(action);
    }
  }

  const agentTurn: AgentTurn = { id: newId(8), at: new Date().toISOString(), role: "agent", text: reply, actions, engine: "rules" };
  updateWorkspace(workspaceId, (x) => {
    x.agentThread = [...(x.agentThread ?? []), userTurn, agentTurn].slice(-MAX_THREAD);
  });
  return { turn: agentTurn, analyze, connectGoogle, simulate };
}

async function runGoogle(workspaceId: string, user: StoredUser, tool: string, args: Record<string, unknown>): Promise<{ reply: string; url?: string; summary: string }> {
  const w = getWorkspace(workspaceId);
  const log = (summary: string) =>
    updateWorkspace(workspaceId, (x) => x.history.push({ id: newId(8), at: new Date().toISOString(), actor: "hades-agent", action: "google", summary, projectVersion: x.project.version }));

  switch (tool) {
    case "google_create_workspace": {
      const links = await createEventWorkspace(user, w);
      updateWorkspace(workspaceId, (x) => (x.google = links));
      log(`Created the Google workspace for "${w.project.name}" (Drive folder, tracker Sheet, plan Doc)`);
      return {
        url: links.folder?.url,
        summary: "Google workspace ready",
        reply: `Your Google workspace is ready:\n• Drive folder: ${links.folder?.url}\n• Tracker sheet: ${links.tracker?.url}\n• Plan doc: ${links.planDoc?.url}\n\nTeammates can update the Status column in the sheet. Say "pull updates from the tracker" and I'll bring them into the plan.`,
      };
    }
    case "google_sync_tracker": {
      const links = await syncTracker(user, w);
      updateWorkspace(workspaceId, (x) => (x.google = links));
      log(`Synced ${w.project.tasks.length} tasks to the tracker sheet`);
      return { url: links.tracker?.url, summary: "Tracker sheet synced", reply: `Synced ${w.project.tasks.length} tasks with live dates to the tracker: ${links.tracker?.url}` };
    }
    case "google_pull_tracker": {
      const changes = await pullTracker(user, w);
      if (!changes.length) return { url: w.google?.tracker?.url, summary: "Tracker checked", reply: `The tracker matches the plan. ${progressReport(w.project).headline}` };
      let project = w.project;
      for (const c of changes) project = updateTask(project, c.taskId, { ...(c.status ? { status: c.status } : {}), ...(c.estimateDays ? { estimateDays: c.estimateDays } : {}) });
      updateWorkspace(workspaceId, (x) => {
        x.project = project;
        x.history.push({ id: newId(8), at: new Date().toISOString(), actor: "progress-agent", action: "member_update", summary: `Pulled ${changes.length} update(s) from the tracker sheet`, projectVersion: project.version });
      });
      const lines = changes.map((c) => `• ${c.taskId}: ${[c.status ? c.status.replace("_", " ") : "", c.estimateDays ? `${c.estimateDays} days` : ""].filter(Boolean).join(", ")}`);
      return { url: w.google?.tracker?.url, summary: `Pulled ${changes.length} update(s)`, reply: `Pulled ${changes.length} update(s) from the tracker:\n${lines.join("\n")}\n\n${formatProgress(project, progressReport(project))}` };
    }
    case "google_create_doc": {
      const file = await createPlanDoc(user, w);
      updateWorkspace(workspaceId, (x) => (x.google = { files: [], ...x.google, planDoc: file }));
      log(`Wrote the plan doc for "${w.project.name}"`);
      return { url: file.url, summary: "Plan doc written", reply: `Wrote the plan doc: ${file.url}` };
    }
    case "google_read": {
      const { file, text } = await readGoogleFile(user, String(args.url));
      const tasks = extractTasks(text);
      updateWorkspace(workspaceId, (x) => {
        const g = { files: [], ...x.google };
        g.files = [...g.files.filter((f) => f.id !== file.id), file];
        x.google = g;
      });
      log(`Read "${file.name}" from Google ${file.kind === "doc" ? "Docs" : "Sheets"}`);
      let added = "";
      if (tasks.length) {
        let project = getWorkspace(workspaceId).project;
        const existing = new Set(project.tasks.map((t) => t.title.toLowerCase()));
        const fresh = tasks.filter((t) => !existing.has(t.toLowerCase()));
        for (const title of fresh) project = addTask(project, { title, estimateDays: 2 }).project;
        if (fresh.length) {
          updateWorkspace(workspaceId, (x) => {
            x.project = project;
            x.history.push({ id: newId(8), at: new Date().toISOString(), actor: "hades-agent", action: "plan_edited", summary: `Added ${fresh.length} task(s) from "${file.name}"`, projectVersion: project.version });
          });
          added = `\n\nI found ${fresh.length} action item(s) and added them to the plan (owned by ${project.members[0].name} for now):\n${fresh.map((t) => `• ${t}`).join("\n")}`;
        }
      }
      const preview = text.replace(/\n{3,}/g, "\n\n").trim().slice(0, 700);
      return { url: file.url, summary: `Read "${file.name}"`, reply: `"${file.name}" (${text.split(/\s+/).filter(Boolean).length} words):\n\n${preview}${text.length > 700 ? "…" : ""}${added}` };
    }
    case "google_append": {
      const file = await appendToGoogleFile(user, String(args.url), String(args.text));
      log(`Added a note to "${file.name}"`);
      return { url: file.url, summary: `Updated "${file.name}"`, reply: `Added to "${file.name}": "${args.text}"` };
    }
    case "calendar_sync": {
      const out = await syncCalendar(user, w);
      updateWorkspace(workspaceId, (x) => (x.calendar = { syncedAt: new Date().toISOString(), events: out.events }));
      log(`Synced the plan to Google Calendar (${out.created} new, ${out.updated} updated)`);
      return { summary: "Calendar synced", reply: `Synced to Google Calendar: ${out.created} new, ${out.updated} updated events.` };
    }
  }
  throw new Error(`Unknown Google action ${tool}`);
}

/** Progress agent: message every owner with late or due-soon work, on their linked chats and in the console. */
export async function nudgeOwners(workspaceId: string): Promise<string> {
  const w = getWorkspace(workspaceId);
  const r = progressReport(w.project);
  const byOwner = new Map<string, string[]>();
  const title = (id: string) => w.project.tasks.find((t) => t.id === id)?.title ?? id;
  for (const o of r.overdue) byOwner.set(o.ownerId, [...(byOwner.get(o.ownerId) ?? []), `${o.taskId} ${title(o.taskId)} was due ${formatShort(o.due)}`]);
  for (const o of r.dueSoon) byOwner.set(o.ownerId, [...(byOwner.get(o.ownerId) ?? []), `${o.taskId} ${title(o.taskId)} is due ${formatShort(o.due)}`]);
  if (!byOwner.size) return `Nobody needs a nudge. ${r.headline}`;
  const messages: MemberMessage[] = [...byOwner].map(([memberId, items]) => ({
    id: newId(8),
    memberId,
    at: new Date().toISOString(),
    from: "agent",
    text: `Hi ${w.project.members.find((m) => m.id === memberId)?.name ?? ""}, quick check-in on ${w.project.name}:\n${items.map((i) => `• ${i}`).join("\n")}\nReply "done", "blocked on …" or "need 2 more days".`,
    taskIds: [],
  }));
  const ws = updateWorkspace(workspaceId, (x) => {
    x.messages.push(...messages);
    x.history.push({ id: newId(8), at: new Date().toISOString(), actor: "progress-agent", action: "progress_check", summary: `Nudged ${messages.length} owner(s): ${r.headline}`, projectVersion: x.project.version });
  });
  await deliver(workspaceId, messages, ws);
  const names = [...byOwner.keys()].map((id) => w.project.members.find((m) => m.id === id)?.name ?? id);
  return `Nudged ${names.join(", ")} about ${r.overdue.length} overdue and ${r.dueSoon.length} due-soon task(s). Linked teammates got it on Telegram/WhatsApp.\n\n${r.headline}`;
}

/** Members may update status or estimates of their own tasks and read progress; everything else is the manager's. */
function memberMayApply(w: WorkspaceState, user: StoredUser | null, cmd: ReturnType<typeof runCommand>): boolean {
  if (cmd.intents.some((i) => i.tool !== "analyze_change")) return cmd.intents.every((i) => i.tool === "google_read");
  if (cmd.intents.length) return false;
  if (!cmd.project) return true;
  const me = w.project.members.find((m) => m.userId === user?.id || (m.email && m.email.toLowerCase() === user?.email.toLowerCase()));
  if (!me) return false;
  const next = cmd.project;
  if (next.members.length !== w.project.members.length || next.dependencies.length !== w.project.dependencies.length || next.tasks.length !== w.project.tasks.length) return false;
  if (next.deadline !== w.project.deadline || next.name !== w.project.name) return false;
  return next.tasks.every((t) => {
    const old = w.project.tasks.find((x) => x.id === t.id);
    if (!old) return false;
    if (old.ownerId !== t.ownerId || old.title !== t.title) return false;
    const changed = old.status !== t.status || old.estimateDays !== t.estimateDays;
    return !changed || old.ownerId === me.id;
  });
}
