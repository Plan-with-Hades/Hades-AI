import {
  applyMemberUpdate,
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
import { findLink, newId, resolveJoinCode, updateWorkspace } from "./store";

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

  const parsed = parseMemberMessage(workspace.project, member.id, text);
  if (parsed.kind === "help") return MEMBER_HELP;
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
