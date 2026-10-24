import { formatShort, scheduleDiff, type DateShift, type ImpactReport, type Member, type Project } from "@hades/core";
import { GMAIL_SCOPE } from "./auth";
import { eventLink, sendGmail } from "./invites";
import { getUser, type StoredUser } from "./store";
import type { WorkspaceState } from "@hades/core";

/**
 * Email the people a change or update touches, from the event manager's own Gmail.
 * Only real people (a member with an email) get mail; demo teammates without one are skipped.
 */
export interface EmailOutcome {
  sent: string[];
  skipped?: string;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Gmail sender: the person acting if they connected Gmail, otherwise the event owner. */
function gmailSender(w: WorkspaceState, actor: StoredUser | null): StoredUser | null {
  const can = (u?: StoredUser | null) => (u?.google?.scope?.includes(GMAIL_SCOPE) ? u : null);
  return can(actor) ?? can(w.ownerId ? getUser(w.ownerId) : null);
}

function shiftLines(shifts: DateShift[], memberId: string) {
  return shifts.filter((s) => s.ownerId === memberId).map((s) => `${s.taskId} ${s.title}: ${s.from ? `${formatShort(s.from)} → ${formatShort(s.to)}` : `now ${formatShort(s.to)}`}`);
}

async function mail(w: WorkspaceState, actor: StoredUser | null, recipients: Member[], build: (m: Member) => { subject: string; text: string }): Promise<EmailOutcome> {
  const real = recipients.filter((m, i, a) => m.email && m.email.toLowerCase() !== actor?.email.toLowerCase() && a.findIndex((x) => x.id === m.id) === i);
  if (!real.length) return { sent: [] };
  const from = gmailSender(w, actor);
  if (!from) return { sent: [], skipped: "Connect Google Workspace so Hades can email from your Gmail." };
  const sent: string[] = [];
  const failed: string[] = [];
  for (const m of real) {
    const { subject, text } = build(m);
    const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.55;color:#111">${esc(text).replace(/\n/g, "<br>")}<p><a href="${eventLink(w)}" style="display:inline-block;background:#111;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open the event</a></p><p style="color:#888;font-size:13px">Hades AI · God of Event Management</p></div>`;
    try {
      await sendGmail(from, m.email!, subject, html, `${text}\n\n${eventLink(w)}`);
      sent.push(m.name);
    } catch (e) {
      console.warn(`Email to ${m.email} failed:`, (e as Error).message);
      failed.push(m.name);
    }
  }
  return { sent, skipped: failed.length ? `Could not email ${failed.join(", ")}.` : undefined };
}

/** After an approval: everyone the change touches hears what moved, in their own tasks' terms. */
export async function emailApproval(w: WorkspaceState, actor: StoredUser | null, report: ImpactReport, before: Project, after: Project, applied: string[]): Promise<EmailOutcome & { shifts: DateShift[] }> {
  const shifts = scheduleDiff(before, after);
  const touched = new Set<string>([...report.affectedMemberIds, ...shifts.map((s) => s.ownerId), ...after.tasks.filter((t) => report.directTaskIds.includes(t.id)).map((t) => t.ownerId)]);
  const note = (m: Member) => report.review?.briefings.find((b) => b.memberId === m.id)?.text;
  const out = await mail(w, actor, after.members.filter((m) => touched.has(m.id)), (m) => {
    const mine = shiftLines(shifts, m.id);
    return {
      subject: `${after.name}: change approved`,
      text: [
        `Hi ${m.name},`,
        "",
        `${actor?.name ?? after.members[0].name} approved a change to "${after.name}":`,
        `"${report.request}"`,
        "",
        applied.length ? `What changed:\n${applied.map((a) => `• ${a}`).join("\n")}` : "",
        mine.length ? `\nYour tasks and new dates:\n${mine.map((l) => `• ${l}`).join("\n")}` : "",
        note(m) ? `\nNote for you: ${note(m)}` : "",
        `\nEvent day: ${formatShort(after.deadline)}.`,
      ]
        .filter((l) => l !== "")
        .join("\n"),
    };
  });
  return { ...out, shifts };
}

/** After a "Send update": the task owner, anyone whose dates moved, and the lead get the update and the orders. */
export async function emailUpdate(w: WorkspaceState, actor: StoredUser | null, before: Project, after: Project, taskId: string, note: string, headline: string): Promise<EmailOutcome & { shifts: DateShift[] }> {
  const shifts = scheduleDiff(before, after);
  const task = after.tasks.find((t) => t.id === taskId);
  const who = new Set<string>([after.members[0].id, task?.ownerId ?? "", ...shifts.map((s) => s.ownerId)]);
  const out = await mail(w, actor, after.members.filter((m) => who.has(m.id)), (m) => {
    const mine = shiftLines(shifts, m.id);
    return {
      subject: `${after.name}: update on ${taskId}${task ? ` ${task.title}` : ""}`,
      text: [
        `Hi ${m.name},`,
        "",
        `${actor?.name ?? "The event team"} posted an update on ${taskId}${task ? ` "${task.title}"` : ""}${task?.estimateDays != null ? ` (${task.estimateDays} day${task.estimateDays === 1 ? "" : "s"})` : ""}.`,
        note ? `\n${note}` : "",
        mine.length ? `\nYour tasks and new dates:\n${mine.map((l) => `• ${l}`).join("\n")}` : "",
        `\n${headline}`,
      ]
        .filter((l) => l !== "")
        .join("\n"),
    };
  });
  return { ...out, shifts };
}
