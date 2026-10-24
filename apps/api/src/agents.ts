import {
  analyzeChange,
  applyMemberUpdate,
  approveChanges,
  hasPro,
  MEMBER_HELP,
  memberTaskSummary,
  parseMemberMessage,
  type Channel,
  type MemberMessage,
  type Reassessment,
  type WorkspaceState,
} from "@hades/core";
import { sendTelegram, sendTelegramVoice } from "./channels/telegram";
import { sendWhatsApp } from "./channels/whatsapp";
import { speak, voiceEnabled } from "./voice/elevenlabs";
import { emailApproval } from "./notify";
import { findLink, getReport, getWorkspace, newId, resolveJoinCode, saveReport, updateWorkspace } from "./store";

/** The change the lead last traced from chat, waiting for "approve" or "reject". */
const pendingByWorkspace = new Map<string, { reportId: string; simulate: boolean }>();

const APPROVE = /^(?:approve|apply|yes|ok|okay|go ahead|make it real|do it)\b/i;
const REJECT = /^(?:reject|no|cancel|discard|drop it)\b/i;
const WHAT_IF = /^(?:what\s+if|what\s+happens\s+if|simulate|suppose|imagine)\s+(.+?)\??$/i;
const CHANGE = /^(?:change|update)\s*[:\-]\s*(.+)$/i;

/** The lead runs the plan from chat: forward a change, see the ripple, reply "approve". */
async function leadCommand(ws: WorkspaceState, text: string, channel: ChatChannel, force: boolean): Promise<string | null> {
  const t = text.trim();
  const pending = pendingByWorkspace.get(ws.id);
  const lead = ws.project.members[0];

  if (pending && APPROVE.test(t)) {
    pendingByWorkspace.delete(ws.id);
    const report = getReport(pending.reportId);
    if (!report) return "That change has expired. Send it again.";
    const ids = report.changes.filter((c) => c.recommended).map((c) => c.id);
    if (!ids.length) return "There was nothing to apply for that change.";
    const before = ws.project;
    let out: ReturnType<typeof approveChanges>;
    try {
      out = approveChanges(ws.project, report, ids, lead.name);
    } catch {
      return "The plan changed since I traced that. Send the change again and I'll re-check it.";
    }
    const next = updateWorkspace(ws.id, (x) => {
      x.project = out.project;
      x.history.push(
        { id: newId(8), at: new Date().toISOString(), actor: "orchestrator", action: "analysis_completed", summary: report.feasibility.headline, projectVersion: report.projectVersion },
        ...out.events,
      );
      x.messages.push(...out.messages.filter((m) => m.memberId !== lead.id));
      x.reassessment = null;
    });
    await deliver(ws.id, out.messages.filter((m) => m.memberId !== lead.id), next);
    const chosen = report.changes.filter((c) => ids.includes(c.id)).map((c) => c.summary);
    const mailed = await emailApproval(getWorkspace(ws.id), null, report, before, out.project, chosen).catch(() => ({ sent: [] as string[] }));
    const told = new Set(out.messages.filter((m) => m.memberId !== lead.id).map((m) => m.memberId)).size;
    return `Done. Applied ${ids.length} change${ids.length === 1 ? "" : "s"}.\n${chosen.map((c) => `✓ ${c}`).join("\n")}\n\nBriefed ${told} teammate${told === 1 ? "" : "s"}${mailed.sent.length ? ` and emailed ${mailed.sent.length}` : ""}.`;
  }
  if (pending && REJECT.test(t)) {
    pendingByWorkspace.delete(ws.id);
    return pending.simulate ? "Discarded. Nothing changed." : "Rejected. The plan stays as it was.";
  }

  const wi = t.match(WHAT_IF);
  const ch = t.match(CHANGE);
  const request = wi?.[1] ?? ch?.[1] ?? (force ? t : null);
  if (!request || request.length < 3) return null;

  const report = analyzeChange(ws.project, request);
  saveReport(report);
  const simulate = !!wi;
  updateWorkspace(ws.id, (x) =>
    x.history.push({ id: newId(8), at: report.createdAt, actor: lead.name, action: "change_requested", summary: `${simulate ? "What-if" : "From " + (channel === "telegram" ? "Telegram" : "WhatsApp")}: ${request}`, projectVersion: x.project.version }),
  );
  const recs = report.changes.filter((c) => c.recommended);
  if (!report.changes.length) return `I read that as: ${report.interpretation}\nIt doesn't change any dates. Nothing to apply.`;
  pendingByWorkspace.set(ws.id, { reportId: report.id, simulate });
  return [
    simulate ? "What-if (nothing has changed yet):" : "Here's the ripple:",
    report.feasibility.headline,
    "",
    ...(recs.length ? recs : report.changes).slice(0, 5).map((c) => `→ ${c.summary}`),
    "",
    simulate ? 'Reply "make it real" to apply it, or "discard".' : 'Reply "approve" to apply and brief the team, or "reject".',
  ].join("\n");
}

type ChatChannel = Exclude<Channel, "web">;

export function toStoredReassessment(r: Reassessment): WorkspaceState["reassessment"] {
  return {
    headline: r.headline,
    feasible: r.schedule.feasible,
    finishDate: r.schedule.finishDate,
    suggestions: r.suggestions.map((s) => ({ id: s.id, summary: s.summary })),
  };
}

async function send(channel: ChatChannel, address: string, text: string) {
  if (channel === "telegram") await sendTelegram(address, text);
  else await sendWhatsApp(address, text);
}

/** Member agents: push messages to every chat a teammate has linked. Web-only teammates read them in the console. */
export async function deliver(workspaceId: string, messages: MemberMessage[], ws: WorkspaceState) {
  if (!hasPro(ws)) return; // chat agents are a Pro feature
  for (const m of messages) {
    const links = ws.links.filter((l) => l.memberId === m.memberId);
    for (const l of links) {
      try {
        await send(l.channel, l.address, m.text);
        if (l.channel === "telegram" && voiceEnabled()) {
          await speak(m.text)
            .then((audio) => sendTelegramVoice(l.address, audio))
            .catch((e) => console.error("Voice note failed:", (e as Error).message));
        }
        updateWorkspace(workspaceId, (w) => {
          const stored = w.messages.find((x) => x.id === m.id);
          if (stored) stored.channel = l.channel;
        });
      } catch (e) {
        console.error(`Delivery to ${l.channel} failed:`, (e as Error).message);
      }
    }
  }
}

/** Tells the event lead (the first member) about something that needs their attention, on their linked chats. */
export async function alertLead(ws: WorkspaceState, text: string) {
  const leadId = ws.project.members[0]?.id;
  for (const l of ws.links.filter((x) => x.memberId === leadId)) {
    await send(l.channel, l.address, text).catch((e) => console.error("Lead alert failed:", (e as Error).message));
  }
}

const JOIN = /^(?:\/start|hades|join|link)\s+([a-z0-9]{4,12}-[a-z0-9_]{2,24})\s*$/i;

/**
 * Handles one inbound chat message and returns the reply text (or null for no reply).
 * Linking:   "/start <code>" (Telegram deep link) or "hades <code>" (WhatsApp)
 * Updates:   free text, parsed deterministically by @hades/core
 */
export async function handleInbound(channel: ChatChannel, address: string, text: string, displayName?: string): Promise<string | null> {
  const join = text.trim().match(JOIN);
  if (join) {
    const hit = resolveJoinCode(join[1]);
    if (!hit) return "That join code didn't match any Hades project. Copy it again from the console.";
    const member = hit.workspace.project.members.find((m) => m.id === hit.memberId)!;
    const ws = updateWorkspace(hit.workspace.id, (w) => {
      w.links = w.links.filter((l) => !(l.channel === channel && (l.address === address || l.memberId === hit.memberId)));
      w.links.push({ memberId: hit.memberId, channel, address, displayName, linkedAt: new Date().toISOString() });
      w.history.push({
        id: newId(8),
        at: new Date().toISOString(),
        actor: member.name,
        action: "member_linked",
        summary: `${member.name} connected ${channel === "telegram" ? "Telegram" : "WhatsApp"}`,
        projectVersion: w.project.version,
      });
    });
    return `Hi ${member.name}! You're connected to "${ws.project.name}" as ${member.role}.\n\nYour tasks:\n${memberTaskSummary(ws.project, member.id)}\n\n${MEMBER_HELP}`;
  }

  const found = findLink(channel, address);
  if (!found) {
    return "Hi! I'm the Hades agent. To connect, send your join code from the Hades console, like: hades abc123-rohan";
  }
  const { workspace, link } = found;
  if (!hasPro(workspace)) return "This event is on the free plan, where chat agents are switched off. The event manager can upgrade to Hades Pro to turn them back on.";
  const member = workspace.project.members.find((m) => m.id === link.memberId);
  if (!member) return "You're no longer on this project.";

  const isLead = member.id === workspace.project.members[0].id;
  if (isLead) {
    const lead = await leadCommand(workspace, text, channel, false);
    if (lead) return lead;
  }

  const parsed = parseMemberMessage(workspace.project, member.id, text);
  // The lead talks about the whole plan; only an explicit task id ("T3 needs 2 more days") is a personal update.
  const leadChange = isLead && (parsed.kind === "unclear" || (parsed.kind === "update" && parsed.estimateDays != null && !/\bT\d+\b/i.test(text)));
  if (leadChange) {
    const lead = await leadCommand(workspace, text, channel, true);
    if (lead) return lead;
  }
  if (parsed.kind === "help") return isLead ? `${MEMBER_HELP}\n\nAs the event lead you can also forward any change ("the venue moved to Friday", "what if the caterer is 3 days late?") and reply "approve" to re-plan.` : MEMBER_HELP;
  if (parsed.kind === "tasks") return memberTaskSummary(workspace.project, member.id);

  const at = new Date().toISOString();
  const inbound: MemberMessage = { id: newId(8), memberId: member.id, at, from: "member", text, taskIds: [], channel };
  if (parsed.kind === "unclear") {
    updateWorkspace(workspace.id, (w) => {
      w.messages.push(inbound, { id: newId(8), memberId: member.id, at, from: "agent", text: parsed.reason, taskIds: [], channel });
    });
    return parsed.reason;
  }

  const res = applyMemberUpdate(workspace.project, { memberId: member.id, taskId: parsed.taskId, estimateDays: parsed.estimateDays, status: parsed.status, note: parsed.note });
  const what = [
    parsed.status ? `marked ${parsed.taskId} ${parsed.status.replace("_", " ")}` : null,
    parsed.estimateDays != null ? `set ${parsed.taskId} to ${parsed.estimateDays} day${parsed.estimateDays === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" and ");
  const reply = `Got it, I ${what} and told ${workspace.project.members[0].name}.\n${res.reassessment.headline}`;
  const ws = updateWorkspace(workspace.id, (w) => {
    w.project = res.project;
    w.history.push(...res.events);
    w.messages.push({ ...inbound, taskIds: [parsed.taskId] }, { id: newId(8), memberId: member.id, at, from: "agent", text: reply, taskIds: [parsed.taskId], channel });
    w.reassessment = toStoredReassessment(res.reassessment);
  });
  if (member.id !== ws.project.members[0].id) {
    const fixes = res.reassessment.suggestions.map((s) => `→ ${s.summary}`).join("\n");
    await alertLead(ws, `${member.name} on ${parsed.taskId}: "${text}"\n${res.reassessment.headline}${fixes ? `\n${fixes}` : ""}`);
  }
  return reply;
}
