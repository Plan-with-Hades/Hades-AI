import type { Member, WorkspaceState } from "@hades/core";
import { GMAIL_SCOPE, googleAccessToken } from "./auth";
import { shareFile } from "./google-workspace";
import { getUser, getWorkspace, newId, updateWorkspace, type StoredUser } from "./store";

/**
 * Inviting teammates by email. The event manager's own Google account does the inviting:
 * Gmail sends the invite, Drive shares the event folder (Google emails them too), and Calendar
 * invites follow on the next calendar sync. Teammates then sign in with Google using that email.
 */
const raw = (process.env.WEB_URL ?? "").trim() || "http://localhost:3000";
const WEB_URL = (/^https?:\/\//.test(raw) ? raw : `https://${raw}`).replace(/\/$/, "");

export const eventLink = (w: Pick<WorkspaceState, "id">) => `${WEB_URL}/app?w=${w.id}`;

const b64url = (s: string) => Buffer.from(s).toString("base64url");
const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`);

export async function sendGmail(manager: StoredUser, to: string, subject: string, html: string, text: string) {
  const token = await googleAccessToken(manager);
  const boundary = `hades-${newId(10)}`;
  const mime = [
    `From: ${encodeHeader(manager.name)} <${manager.email}>`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    text,
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "",
    html,
    `--${boundary}--`,
  ].join("\r\n");
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ raw: b64url(mime) }),
  });
  if (!res.ok) throw new Error(`Gmail ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

function inviteEmail(w: WorkspaceState, m: Member, manager: StoredUser) {
  const link = eventLink(w);
  const mine = w.project.tasks.filter((t) => t.ownerId === m.id && t.status !== "done");
  const tasks = mine.length ? mine.map((t) => `${t.id} ${t.title}`) : [];
  const text = [
    `Hi ${m.name},`,
    "",
    `${manager.name} added you to "${w.project.name}" on Hades AI as ${m.role}.`,
    tasks.length ? `\nYour tasks:\n${tasks.map((t) => `• ${t}`).join("\n")}` : "",
    "",
    `Open the event and sign in with Google using ${m.email}:`,
    link,
    "",
    "You'll also get the shared Drive folder, tracker sheet and calendar invites from Google.",
    "— Hades AI · God of Event Management",
  ].join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.55;color:#111">
<p>Hi ${m.name},</p>
<p><b>${manager.name}</b> added you to <b>${w.project.name}</b> on Hades AI as <b>${m.role}</b>.</p>
${tasks.length ? `<p>Your tasks:</p><ul>${tasks.map((t) => `<li>${t}</li>`).join("")}</ul>` : ""}
<p><a href="${link}" style="display:inline-block;background:#111;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open the event</a></p>
<p style="color:#555">Sign in with Google using <b>${m.email}</b>. You'll also get the shared Drive folder, tracker sheet and calendar invites from Google.</p>
<p style="color:#888;font-size:13px">Hades AI · God of Event Management</p></div>`;
  return { subject: `${manager.name} invited you to ${w.project.name}`, text, html };
}

export interface InviteResult {
  memberId: string;
  email: string;
  emailed: boolean;
  shared: boolean;
  link: string;
  note?: string;
}

/** Invites one teammate with the manager's Google account. Safe to call again (re-sends). */
export async function inviteMember(workspaceId: string, manager: StoredUser | null, memberId: string): Promise<InviteResult> {
  const w = getWorkspace(workspaceId);
  const m = w.project.members.find((x) => x.id === memberId);
  if (!m?.email) throw Object.assign(new Error("Add an email for this teammate first."), { status: 400 });
  const out: InviteResult = { memberId, email: m.email, emailed: false, shared: false, link: eventLink(w) };
  const notes: string[] = [];
  const owner = manager ?? (w.ownerId ? (getUser(w.ownerId) ?? null) : null);
  if (owner?.google?.scope?.includes(GMAIL_SCOPE)) {
    try {
      const mail = inviteEmail(w, m, owner);
      await sendGmail(owner, m.email, mail.subject, mail.html, mail.text);
      out.emailed = true;
    } catch (e) {
      notes.push((e as Error).message);
    }
  } else notes.push("Connect Google Workspace to send invites from your Gmail.");
  if (owner && w.google?.folder) {
    try {
      await shareFile(owner, w.google.folder.id, m.email, `${owner.name} shared the "${w.project.name}" workspace with you on Hades AI.`);
      out.shared = true;
    } catch (e) {
      notes.push((e as Error).message);
    }
  }
  out.note = notes.join(" ") || undefined;
  updateWorkspace(workspaceId, (x) => {
    const mm = x.project.members.find((y) => y.id === memberId);
    if (mm) mm.invitedAt = new Date().toISOString();
    x.history.push({
      id: newId(8),
      at: new Date().toISOString(),
      actor: owner?.name ?? "hades-agent",
      action: "member_invited",
      summary: `Invited ${m.name} <${m.email}>${out.emailed ? " by Gmail" : ""}${out.shared ? ", shared the Drive folder" : ""}`,
      projectVersion: x.project.version,
    });
  });
  return out;
}

