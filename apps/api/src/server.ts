import dns from "node:dns";
import net from "node:net";
import cors from "cors";
import express from "express";
import { z } from "zod";
import { analyzeChange, applyMemberUpdate, approveChanges, createDemoProject, effectivePlan, FREE_FEATURES, FREE_LIMITS, freeLimitMessage, hasPro, PRO_DAYS, PRO_PRICE_INR, StaleProposalError, TRIAL_DAYS, type WorkspaceState } from "@hades/core";
import { CALENDAR_SCOPE, completeGoogleLogin, currentUser, googleAuthUrl, googleEnabled, publicUser, requireUser, sessionFor, unseal, type OAuthState } from "./auth";
import { syncCalendar } from "./google-calendar";
import { alertLead, deliver, handleInbound, toStoredReassessment } from "./agents";
import { speak, voiceEnabled } from "./voice/elevenlabs";
import { runAgent } from "./hades-agent";
import { emailApproval, emailUpdate } from "./notify";
import { inviteMember } from "./invites";
import { addMember, blankProject, progressReport, scheduleProject, updateTask } from "@hades/core";
import { syncTracker } from "./google-workspace";
import { agenticorgEnabled, pendingReview, reviewWithAgenticOrg } from "./agenticorg";
import { parseUpdate, startTelegram, telegramWebhookInfo, telegramBotUsername, telegramEnabled, TELEGRAM_SECRET } from "./channels/telegram";
import { twiml, verifyTwilioSignature, WHATSAPP_FROM, whatsappEnabled } from "./channels/whatsapp";
import { createPinelabsOrder, getPinelabsOrder, isPaidStatus, pinelabsConfigured, pinelabsMode, verifyPinelabsRedirect } from "./payments/pinelabs";
import { allUsers, allWorkspaces, createWorkspace, findVendor, getUser, initStore, recordView, trafficSummary, linkMemberships, roleIn, touchUser, touchWorkspace, findPayment, getReport, getWorkspace, newId, saveReport, updateWorkspace, workspacesOf } from "./store";

/**
 * Hades API. Agents propose; this server enforces version checks, ownership, approval gating,
 * payment verification and channel signatures.
 */
// Prefer IPv4 and give each address time: api.telegram.org timed out on Render's IPv6 path.
dns.setDefaultResultOrder("ipv4first");
net.setDefaultAutoSelectFamilyAttemptTimeout(1000);

const app = express();
app.set("trust proxy", true);
const origins = (process.env.CORS_ORIGINS ?? "http://localhost:3000").split(",").map((s) => s.trim());
app.use(cors({ origin: origins.includes("*") ? true : origins }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
// Activity for the developer console: who is signed in and using Hades right now.
app.use((req, _res, next) => {
  if (req.path.startsWith("/api/")) {
    const u = currentUser(req);
    if (u) touchUser(u);
  }
  next();
});

/** Accepts full URLs or bare hosts (Render's fromService "host" property). */
const asUrl = (v: string | undefined, fallback: string) => {
  const raw = (v ?? "").trim() || fallback;
  return (/^https?:\/\//.test(raw) ? raw : `https://${raw}`).replace(/\/$/, "");
};
const WEB_URL = asUrl(process.env.WEB_URL, "http://localhost:3000");
const PUBLIC_API_URL = asUrl(process.env.PUBLIC_API_URL ?? process.env.RENDER_EXTERNAL_URL, `http://localhost:${process.env.PORT ?? 4000}`);
const PRO_PRICE_PAISE = Number(process.env.PRO_PRICE_PAISE ?? PRO_PRICE_INR * 100);
const GOOGLE_REDIRECT = process.env.GOOGLE_REDIRECT_URI ?? `${PUBLIC_API_URL}/api/auth/google/callback`;
const ADMIN_KEY = process.env.ADMIN_KEY ?? "";
/** Google Pay / any UPI app pays straight to this UPI ID. Payments are confirmed by the admin in /dev. */
const UPI_VPA = (process.env.UPI_VPA ?? "").trim();
const UPI_NAME = (process.env.UPI_PAYEE_NAME ?? "Hades AI").trim();
const DEV_CHANNEL = process.env.ALLOW_DEV_CHANNEL === "1" || process.env.NODE_ENV !== "production";

type Handler = (req: express.Request, res: express.Response) => unknown | Promise<unknown>;
const h = (fn: Handler) => (req: express.Request, res: express.Response, next: express.NextFunction) => Promise.resolve(fn(req, res)).catch(next);
const param = (req: express.Request, key: string) => String(req.params[key]);

/* ---------------- Health & meta ---------------- */

app.get("/health", (_req, res) => res.json({ ok: true, service: "hades-api" }));

app.get(
  "/api/meta",
  h(async (_req, res) => {
    res.json({
      payments: { mode: pinelabsMode(), pricePaise: PRO_PRICE_PAISE, trialDays: TRIAL_DAYS },
      google: { enabled: googleEnabled() },
      telegram: { enabled: telegramEnabled(), bot: await telegramBotUsername() },
      whatsapp: { enabled: whatsappEnabled(), number: WHATSAPP_FROM.replace(/^whatsapp:/, "") || null },
      agenticorg: { enabled: agenticorgEnabled() },
      voice: { enabled: voiceEnabled() },
      upi: UPI_VPA ? { vpa: UPI_VPA, name: UPI_NAME } : null,
    });
  }),
);

/* ---------------- Workspaces ---------------- */

/** What the browser sees: the workspace plus its effective plan. */
const view = (w: WorkspaceState, role?: "manager" | "member" | "guest") => ({ ...w, effectivePlan: effectivePlan(w), ...(role ? { role } : {}) });

/** Planning stops when the free trial ends; reading the plan and paying keep working. */
function requirePro(w: WorkspaceState, what: string) {
  if (!hasPro(w)) {
    throw Object.assign(new Error(`${what} is a Hades Pro feature. Your ${TRIAL_DAYS}-day trial has ended; upgrade for ₹${PRO_PRICE_INR}/month to keep using it.`), { status: 402 });
  }
}

/** Paying needs a signed-in event manager: returns who is paying for which event. */
function payer(req: express.Request, id: string) {
  const u = requireUser(req);
  const w = getWorkspace(id);
  if (w.ownerId !== u.id) throw Object.assign(new Error("Sign in as the event manager to upgrade this event."), { status: 403 });
  return { u, w };
}

app.post("/api/workspaces", (req, res) => {
  const u = currentUser(req);
  const blank = req.body?.blank === true;
  let best: WorkspaceState | undefined;
  if (u) {
    const mine = workspacesOf(u).filter((x) => x.role === "manager").map((x) => x.w);
    best = mine.find((x) => effectivePlan(x) === "pro") ?? mine.find((x) => hasPro(x));
    if (mine.length >= FREE_LIMITS.events && !best) return res.status(402).json({ error: `The free plan includes up to ${FREE_LIMITS.events} events. Upgrade to Hades Pro for unlimited events.` });
    best ??= mine[0]; // an expired account's new events share its (expired) plan, never a fresh trial
  }
  const created = createWorkspace(u ? { id: u.id, name: u.name, email: u.email } : undefined, { blank });
  // New events share the account's plan: Pro or the same trial, never a fresh trial.
  if (best) updateWorkspace(created.id, (x) => Object.assign(x, { plan: best!.plan, trialEndsAt: best!.trialEndsAt, proUntil: best!.proUntil }));
  res.status(201).json(view(getWorkspace(created.id)));
});

/** Add a teammate by email and invite them with the manager's Google account. Managers only (or guest demos). */
app.post(
  "/api/workspaces/:id/members",
  h(async (req, res) => {
    const b = z.object({ name: z.string().trim().min(1).max(80), role: z.string().trim().max(80).optional(), email: z.string().trim().email() }).parse(req.body);
    const id = param(req, "id");
    const w = getWorkspace(id);
    const u = currentUser(req);
    if (w.ownerId && roleIn(w, u) !== "manager") return res.status(403).json({ error: "Only the event manager can add people." });
    if (w.project.members.some((m) => m.email?.toLowerCase() === b.email.toLowerCase())) return res.status(409).json({ error: `${b.email} is already on the team.` });
    const out = addMember(w.project, b);
    const cap = hasPro(w) ? null : freeLimitMessage(w.project, out.project);
    if (cap) return res.status(402).json({ error: `${cap} Upgrade to Hades Pro for unlimited people.` });
    updateWorkspace(id, (x) => {
      x.project = out.project;
      x.joinCodes[out.member.id] = `${x.id}-${out.member.id}`;
      x.history.push({ id: newId(8), at: new Date().toISOString(), actor: u?.name ?? x.project.members[0].name, action: "plan_edited", summary: `Added ${out.member.name} (${out.member.role}) <${b.email}>`, projectVersion: x.project.version });
    });
    const invite = await inviteMember(id, u, out.member.id);
    res.status(201).json({ invite, workspace: view(getWorkspace(id)) });
  }),
);

app.post(
  "/api/workspaces/:id/members/:memberId/invite",
  h(async (req, res) => {
    const id = param(req, "id");
    const w = getWorkspace(id);
    const u = currentUser(req);
    if (w.ownerId && roleIn(w, u) !== "manager") return res.status(403).json({ error: "Only the event manager can send invites." });
    const invite = await inviteMember(id, u, param(req, "memberId"));
    res.json({ invite, workspace: view(getWorkspace(id)) });
  }),
);

/**
 * Mark a task done (or reopen it) from the graph. The plan re-schedules, and the Google tracker sheet and
 * calendar follow automatically with the manager's Google account.
 */
app.post(
  "/api/workspaces/:id/tasks/:taskId/status",
  h(async (req, res) => {
    const { status } = z.object({ status: z.enum(["done", "in_progress", "not_started", "blocked"]) }).parse(req.body);
    const id = param(req, "id");
    const w = getWorkspace(id);
    const u = currentUser(req);
    const task = w.project.tasks.find((t) => t.id === param(req, "taskId"));
    if (!task) return res.status(404).json({ error: "Task not found." });
    const role = roleIn(w, u);
    const me = u ? w.project.members.find((m) => m.userId === u.id || m.email?.toLowerCase() === u.email.toLowerCase()) : undefined;
    if (w.ownerId && role !== "manager" && !(role === "member" && me?.id === task.ownerId)) return res.status(403).json({ error: "Only the event manager or the task's owner can change its status." });
    const project = updateTask(w.project, task.id, { status });
    const report = progressReport(project);
    const ws = updateWorkspace(id, (x) => {
      x.project = project;
      x.history.push({ id: newId(8), at: new Date().toISOString(), actor: u?.name ?? "team", action: "member_update", summary: `${task.id} "${task.title}" marked ${status.replace("_", " ")}. ${report.headline}`, projectVersion: project.version });
    });
    // Keep Google in step: tracker sheet and calendar events, in the background.
    const owner = ws.ownerId ? getUser(ws.ownerId) : null;
    const googleTouched = hasPro(ws) && !!(ws.google?.tracker || ws.calendar);
    if (owner?.google && googleTouched) {
      void (async () => {
        const done: string[] = [];
        try {
          if (ws.google?.tracker) {
            const links = await syncTracker(owner, getWorkspace(id));
            updateWorkspace(id, (x) => (x.google = links));
            done.push("tracker sheet");
          }
          if (ws.calendar) {
            const out = await syncCalendar(owner, getWorkspace(id));
            updateWorkspace(id, (x) => (x.calendar = { syncedAt: new Date().toISOString(), events: out.events }));
            done.push("calendar");
          }
          if (done.length) updateWorkspace(id, (x) => x.history.push({ id: newId(8), at: new Date().toISOString(), actor: "hades-agent", action: "google", summary: `Updated the ${done.join(" and ")} after ${task.id} changed`, projectVersion: x.project.version }));
        } catch (e) {
          console.warn("Google auto-update failed:", (e as Error).message);
        }
      })();
    }
    res.json({ ...view(ws, role), googleUpdating: googleTouched && !!owner?.google });
  }),
);

/** The Hades agent: people, tasks, new event plans, progress, and Google Workspace. */
app.post(
  "/api/workspaces/:id/agent",
  h(async (req, res) => {
    const { message } = z.object({ message: z.string().trim().min(1).max(2000) }).parse(req.body);
    const id = param(req, "id");
    const out = await runAgent(id, currentUser(req), message);
    res.json({ ...out, workspace: view(getWorkspace(id)) });
  }),
);

app.get("/api/workspaces/:id", (req, res) => {
  const w = getWorkspace(param(req, "id"));
  touchWorkspace(w);
  if (req.query.since && req.query.since === w.updatedAt) return res.json({ changed: false, updatedAt: w.updatedAt });
  res.json(view(w, roleIn(w, currentUser(req))));
});

/** A guest workspace becomes yours when you sign in. */
app.post(
  "/api/workspaces/:id/claim",
  h((req, res) => {
    const u = requireUser(req);
    const w = getWorkspace(param(req, "id"));
    if (w.ownerId && w.ownerId !== u.id) return res.status(403).json({ error: "This workspace belongs to someone else." });
    res.json(
      view(
        updateWorkspace(w.id, (x) => {
          x.ownerId = u.id;
          x.ownerName = u.name;
        }),
      ),
    );
  }),
);

app.post(
  "/api/workspaces/:id/analyze",
  h((req, res) => {
    const { request, simulate } = z.object({ request: z.string().trim().min(3).max(2000), simulate: z.boolean().optional() }).parse(req.body);
    const id = param(req, "id");
    const w = getWorkspace(id);
    requirePro(w, simulate ? "What-if simulation" : "Change analysis");
    const report = analyzeChange(w.project, request);
    if (agenticorgEnabled()) report.review = pendingReview();
    saveReport(report);
    updateWorkspace(id, (x) =>
      x.history.push({ id: newId(8), at: report.createdAt, actor: x.project.members[0].name, action: "change_requested", summary: simulate ? `What-if: ${request}` : request, projectVersion: x.project.version }),
    );
    res.status(201).json(report);
    if (report.review) void runAgentReview(id, report.id);
  }),
);

/** Second opinion from the AgenticOrg coordinator. Runs after the response; the console polls the report. */
async function runAgentReview(workspaceId: string, reportId: string) {
  const report = getReport(reportId);
  if (!report) return;
  const review = await reviewWithAgenticOrg(getWorkspace(workspaceId).project, report);
  saveReport({ ...report, review });
  const summary =
    review.status === "done"
      ? `AgenticOrg run ${review.runId ?? "?"}: ${review.recommendedChangeIds.length}/${report.changes.length} edits recommended${review.hitl ? ", needs the lead's approval" : ""}${review.confidence != null ? ` (confidence ${Math.round(review.confidence * 100)}%)` : ""}`
      : `AgenticOrg review failed: ${review.error}`;
  console.log(`[agenticorg] ${workspaceId} ${reportId} ${summary} in ${review.durationMs}ms`);
  updateWorkspace(workspaceId, (x) =>
    x.history.push({
      id: newId(8),
      at: new Date().toISOString(),
      actor: "agenticorg",
      action: "agent_review",
      summary,
      projectVersion: report.projectVersion,
      meta: { reportId, runId: review.runId, status: review.status, confidence: review.confidence, escalate: review.escalate, hitl: review.hitl },
    }),
  );
}

/** The impact summary read aloud by ElevenLabs (MP3). */
app.get(
  "/api/workspaces/:id/reports/:reportId/voice",
  h(async (req, res) => {
    if (!voiceEnabled()) return res.status(404).json({ error: "Voice is not configured." });
    requirePro(getWorkspace(param(req, "id")), "Voice summaries");
    const report = getReport(param(req, "reportId"));
    if (!report || report.projectId !== param(req, "id")) return res.status(404).json({ error: "This analysis has expired. Run it again." });
    const brief = report.review?.status === "done" ? report.review.decisionBrief : "";
    const text = [report.feasibility.headline, brief || report.interpretation].filter(Boolean).join(" ");
    const audio = await speak(text);
    res.set({ "content-type": "audio/mpeg", "cache-control": "private, max-age=3600" }).send(audio);
  }),
);

app.get("/api/workspaces/:id/reports/:reportId", (req, res) => {
  const report = getReport(param(req, "reportId"));
  if (!report || report.projectId !== param(req, "id")) return res.status(404).json({ error: "This analysis has expired. Run it again." });
  res.json(report);
});

app.post(
  "/api/workspaces/:id/approve",
  h(async (req, res) => {
    const { reportId, changeIds } = z.object({ reportId: z.string(), changeIds: z.array(z.string()) }).parse(req.body);
    const id = param(req, "id");
    const report = getReport(reportId);
    if (!report || report.projectId !== id) return res.status(404).json({ error: "This analysis has expired. Run it again." });
    const w = getWorkspace(id);
    requirePro(w, "Approving changes");
    const beforeProject = w.project;
    const out = approveChanges(w.project, report, changeIds, w.project.members[0].name);
    for (const m of out.messages) {
      const note = report.review?.briefings.find((b) => b.memberId === m.memberId);
      if (note) m.text = `${m.text}

From the coordinator: ${note.text}`;
    }
    const ws = updateWorkspace(id, (x) => {
      x.project = out.project;
      x.history.push(
        { id: newId(8), at: new Date().toISOString(), actor: "orchestrator", action: "analysis_completed", summary: report.feasibility.headline, projectVersion: report.projectVersion },
        ...out.events,
      );
      x.messages.push(...out.messages);
      x.reassessment = null;
    });
    await deliver(id, out.messages, ws);
    const chosen = report.changes.filter((c) => changeIds.includes(c.id)).map((c) => c.summary);
    const emailed = await emailApproval(getWorkspace(id), currentUser(req), report, beforeProject, out.project, chosen).catch((e) => ({ sent: [] as string[], skipped: (e as Error).message, shifts: [] }));
    res.json({ ...view(getWorkspace(id)), emailed: { sent: emailed.sent, skipped: emailed.skipped }, shifts: emailed.shifts });
  }),
);

app.post(
  "/api/workspaces/:id/reject",
  h((req, res) => {
    const { reportId } = z.object({ reportId: z.string() }).parse(req.body);
    const id = param(req, "id");
    const report = getReport(reportId);
    const ws = updateWorkspace(id, (x) =>
      x.history.push({ id: newId(8), at: new Date().toISOString(), actor: x.project.members[0].name, action: "change_rejected", summary: `Rejected: ${report?.request ?? "change"}`, projectVersion: x.project.version }),
    );
    res.json(view(ws));
  }),
);

/** Member update from the console ("reply as …"). Chat replies go through handleInbound instead. */
app.post(
  "/api/workspaces/:id/member-updates",
  h(async (req, res) => {
    const body = z
      .object({ memberId: z.string(), taskId: z.string(), estimateDays: z.number().positive().max(60).optional(), note: z.string().trim().max(1000).default("") })
      .parse(req.body);
    const id = param(req, "id");
    const w = getWorkspace(id);
    const beforeProject = w.project;
    const out = applyMemberUpdate(w.project, { ...body, note: body.note || "(no note)" });
    const lead = w.project.members[0].name;
    const ws = updateWorkspace(id, (x) => {
      x.project = out.project;
      x.history.push(...out.events);
      x.messages.push(
        { ...out.message, channel: "web" },
        { id: newId(8), memberId: body.memberId, at: new Date().toISOString(), from: "agent", text: `Thanks. I've updated ${body.taskId} and told ${lead}: ${out.reassessment.headline}`, taskIds: [body.taskId], channel: "web" },
      );
      x.reassessment = toStoredReassessment(out.reassessment);
    });
    const member = ws.project.members.find((m) => m.id === body.memberId);
    if (hasPro(ws) && body.memberId !== ws.project.members[0].id) await alertLead(ws, `${member?.name} on ${body.taskId}: "${body.note}"\n${out.reassessment.headline}`);
    const emailed = !hasPro(ws)
      ? { sent: [] as string[], skipped: "Emailing updates is a Pro feature.", shifts: [] }
      : await emailUpdate(getWorkspace(id), currentUser(req), beforeProject, ws.project, body.taskId, body.note, out.reassessment.headline).catch((e) => ({ sent: [] as string[], skipped: (e as Error).message, shifts: [] }));
    res.json({ ...view(ws), emailed: { sent: emailed.sent, skipped: emailed.skipped }, shifts: emailed.shifts });
  }),
);

app.post(
  "/api/workspaces/:id/reset",
  h((req, res) => {
    const id = param(req, "id");
    const cur = getWorkspace(id);
    const u = currentUser(req);
    if (cur.ownerId && roleIn(cur, u) !== "manager") return res.status(403).json({ error: "Only the event manager can clear the event." });
    // The manager is the lead of a cleared event (old demo events still carried the demo's "Ananya").
    const lead = cur.project.members[0];
    const fresh = blankProject(id, u && cur.ownerId === u.id ? { name: u.name, email: u.email } : { name: lead?.name ?? "Event lead", email: lead?.email });
    const ws = updateWorkspace(id, (x) => {
      x.project = fresh;
      x.messages = [];
      x.reassessment = null;
      x.links = [];
      x.agentThread = [];
      x.google = undefined;
      x.calendar = undefined;
      x.joinCodes = Object.fromEntries(fresh.members.map((m) => [m.id, `${id}-${m.id}`]));
      x.history = [{ id: newId(8), at: new Date().toISOString(), actor: fresh.members[0].name, action: "project_created", summary: "Cleared the event. Starting from an empty plan", projectVersion: 1 }];
    });
    res.json(view(ws));
  }),
);

/* ---------------- Vendors: confirm or delay from a link, no sign-up ---------------- */

app.post(
  "/api/workspaces/:id/tasks/:taskId/vendor",
  h((req, res) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
    const id = param(req, "id");
    const w = getWorkspace(id);
    const u = currentUser(req);
    if (w.ownerId && roleIn(w, u) !== "manager") return res.status(403).json({ error: "Only the event manager can add vendors." });
    const task = w.project.tasks.find((t) => t.id === param(req, "taskId"));
    if (!task) return res.status(404).json({ error: "Task not found." });
    const token = `${newId(6)}${newId(6)}`;
    const ws = updateWorkspace(id, (x) => {
      const t = x.project.tasks.find((y) => y.id === task.id)!;
      t.vendor = { name, token, status: "pending", createdAt: new Date().toISOString() };
      x.history.push({ id: newId(8), at: new Date().toISOString(), actor: u?.name ?? x.project.members[0].name, action: "plan_edited", summary: `Added vendor ${name} to ${task.id} "${task.title}"`, projectVersion: x.project.version });
    });
    res.status(201).json({ link: `${WEB_URL}/v/${token}`, workspace: view(ws, roleIn(ws, u)) });
  }),
);

function vendorView(token: string) {
  const hit = findVendor(token);
  if (!hit) return null;
  const { workspace: w, task } = hit;
  const st = scheduleProject(w.project).tasks[task.id];
  return {
    event: w.project.name,
    eventDate: w.project.deadline,
    task: { id: task.id, title: task.title, start: st?.startDate ?? null, finish: st?.endDate ?? null },
    vendor: task.vendor!,
    manager: w.project.members[0]?.name ?? "the organiser",
  };
}

app.get("/api/vendor/:token", (req, res) => {
  const v = vendorView(param(req, "token"));
  if (!v) return res.status(404).json({ error: "This vendor link is no longer valid." });
  res.json(v);
});

app.post(
  "/api/vendor/:token",
  h(async (req, res) => {
    const b = z.object({ status: z.enum(["confirmed", "delayed"]), delayDays: z.number().int().min(1).max(60).optional(), note: z.string().trim().max(500).optional() }).parse(req.body);
    const token = param(req, "token");
    const hit = findVendor(token);
    if (!hit) return res.status(404).json({ error: "This vendor link is no longer valid." });
    const { workspace: w, task } = hit;
    const before = w.project;
    const now = new Date().toISOString();
    const days = b.status === "delayed" ? (b.delayDays ?? 1) : 0;
    const vendorName = task.vendor!.name;
    const project = days ? updateTask(w.project, task.id, { estimateDays: (task.estimateDays ?? 2) + days }) : w.project;
    const sched = scheduleProject(project);
    const headline = days
      ? sched.feasible
        ? `${vendorName} is ${days} day(s) late on ${task.id}. The event date still holds.`
        : `${vendorName} is ${days} day(s) late on ${task.id}. The plan now lands ${sched.finishDate}, after the event date.`
      : `${vendorName} confirmed ${task.id} "${task.title}".`;
    const lead = w.project.members[0];
    const ws = updateWorkspace(w.id, (x) => {
      x.project = project;
      const t = x.project.tasks.find((y) => y.id === task.id)!;
      t.vendor = { ...task.vendor!, status: b.status, delayDays: days || undefined, note: b.note, respondedAt: now };
      x.history.push({ id: newId(8), at: now, actor: vendorName, action: "member_update", summary: `${headline}${b.note ? ` Note: "${b.note}"` : ""}`, projectVersion: x.project.version });
      if (lead) x.messages.push({ id: newId(8), memberId: lead.id, at: now, from: "agent", text: `Vendor update: ${headline}${b.note ? `\n"${b.note}"` : ""}`, taskIds: [task.id] });
    });
    if (hasPro(ws)) {
      if (days) await emailUpdate(ws, null, before, ws.project, task.id, `${vendorName} reported a delay of ${days} day(s).${b.note ? ` "${b.note}"` : ""}`, headline).catch(() => undefined);
      await alertLead(ws, `Vendor update: ${headline}${b.note ? `\n"${b.note}"` : ""}`).catch(() => undefined);
    }
    res.json({ ok: true, headline, view: vendorView(token) });
  }),
);

/* ---------------- Analytics: page views and unique visitors ---------------- */

app.post("/api/track", (req, res) => {
  const b = z.object({ visitorId: z.string().min(6).max(64), path: z.string().max(300), referrer: z.string().max(500).optional() }).safeParse(req.body);
  if (b.success && !/bot|crawl|spider|preview/i.test(req.get("user-agent") ?? "")) recordView(b.data);
  res.sendStatus(204);
});

/* ---------------- Payments: Google Pay (UPI) ---------------- */

/**
 * Logged when someone opens the Google Pay window, so /dev shows every attempt even if the payer never enters a
 * UTR. Match it against your bank/Google Pay statement by time and amount, then Verify.
 */
app.post(
  "/api/workspaces/:id/upi-intent",
  h((req, res) => {
    if (!UPI_VPA) return res.status(503).json({ error: "Google Pay isn't set up yet." });
    const id = param(req, "id");
    const { w } = payer(req, id);
    if (effectivePlan(w) === "pro") return res.json({ ok: true });
    const now = new Date().toISOString();
    if (!w.payments.some((p) => p.provider === "upi" && (p.status === "initiated" || p.status === "pending"))) {
      const ref = `upi-${id}-${Date.now()}`;
      updateWorkspace(id, (x) => {
        x.payments.push({ id: ref, provider: "upi", orderId: ref, amountPaise: PRO_PRICE_PAISE, status: "initiated", checkoutUrl: "", createdAt: now, updatedAt: now });
        x.history.push({ id: newId(8), at: now, actor: currentUser(req)?.name ?? "team", action: "payment", summary: "Opened the Google Pay window to upgrade", projectVersion: x.project.version });
      });
    }
    res.json({ ok: true });
  }),
);

/** The payer paid ₹199 to our UPI ID in Google Pay and gives us the UPI reference. Pro turns on once verified in /dev. */
app.post(
  "/api/workspaces/:id/upi",
  h((req, res) => {
    if (!UPI_VPA) return res.status(503).json({ error: "Google Pay isn't set up yet." });
    const { utr } = z.object({ utr: z.string().trim().regex(/^[A-Za-z0-9]{10,24}$/, "Enter the 12-digit UPI reference (UTR) from Google Pay") }).parse(req.body);
    const id = param(req, "id");
    const { w } = payer(req, id);
    if (w.payments.some((p) => p.utr === utr)) return res.status(409).json({ error: "We already have this payment. It will be confirmed shortly." });
    const now = new Date().toISOString();
    const ref = `upi-${id}-${Date.now()}`;
    const ws = updateWorkspace(id, (x) => {
      // Turn the "payment started" record into a submitted payment, or create one.
      const started = x.payments.find((p) => p.provider === "upi" && p.status === "initiated");
      if (started) Object.assign(started, { status: "pending", utr, updatedAt: now });
      else x.payments.push({ id: ref, provider: "upi", orderId: ref, amountPaise: PRO_PRICE_PAISE, status: "pending", checkoutUrl: "", utr, createdAt: now, updatedAt: now });
      x.history.push({ id: newId(8), at: now, actor: currentUser(req)?.name ?? "team", action: "payment", summary: `Google Pay payment submitted (UTR ${utr}), awaiting confirmation`, projectVersion: x.project.version });
    });
    res.status(201).json(view(ws));
  }),
);

/** Admin grants a month of Pro to everyone's events owned by this Google email (for payments you've already seen arrive). */
app.post(
  "/api/admin/grant",
  h((req, res) => {
    if (!ADMIN_KEY || req.get("x-admin-key") !== ADMIN_KEY) return res.sendStatus(404);
    const { email } = z.object({ email: z.string().trim().email() }).parse(req.body);
    const user = allUsers().find((u) => u.email.toLowerCase() === email.toLowerCase());
    if (!user) return res.status(404).json({ error: `${email} hasn't signed in to Hades yet.` });
    const events = allWorkspaces().filter((w) => w.ownerId === user.id);
    if (!events.length) return res.status(404).json({ error: `${email} has no events.` });
    const now = new Date().toISOString();
    for (const w of events) {
      const ref = `upi-${w.id}-${Date.now()}`;
      updateWorkspace(w.id, (x) => x.payments.push({ id: ref, provider: "upi", orderId: ref, amountPaise: PRO_PRICE_PAISE, status: "pending", checkoutUrl: "", utr: "manual", createdAt: now, updatedAt: now }));
      markPaid(ref, "captured");
    }
    res.json({ ok: true, events: events.length });
  }),
);

/** Admin confirms (or rejects) a Google Pay payment after checking it arrived. */
app.post(
  "/api/admin/payments/:ref/:decision",
  h((req, res) => {
    if (!ADMIN_KEY || req.get("x-admin-key") !== ADMIN_KEY) return res.sendStatus(404);
    const ref = param(req, "ref");
    const ok = param(req, "decision") === "verify";
    const ws = markPaid(ref, ok ? "captured" : "failed");
    if (!ws) return res.status(404).json({ error: "Unknown payment" });
    res.json({ ok: true });
  }),
);

/* ---------------- Payments: Pine Labs hosted checkout ---------------- */

app.post(
  "/api/workspaces/:id/checkout",
  h(async (req, res) => {
    const id = param(req, "id");
    const { u: buyer, w } = payer(req, id);
    if (effectivePlan(w) === "pro") return res.status(409).json({ error: "This team is already on Pro." });
    const reference = `hades-${id}-${Date.now()}`;
    const now = new Date().toISOString();
    if (pinelabsConfigured()) {
      const order = await createPinelabsOrder({
        reference,
        amountPaise: PRO_PRICE_PAISE,
        callbackUrl: `${PUBLIC_API_URL}/api/payments/pinelabs/callback`,
        failureCallbackUrl: `${PUBLIC_API_URL}/api/payments/pinelabs/failure`,
        customer: { firstName: buyer?.name ?? w.project.members[0].name, email: buyer?.email },
      });
      updateWorkspace(id, (x) =>
        x.payments.push({ id: reference, provider: "pinelabs", orderId: order.orderId, amountPaise: PRO_PRICE_PAISE, status: "created", checkoutUrl: order.checkoutUrl, createdAt: now, updatedAt: now }),
      );
      return res.status(201).json({ checkoutUrl: order.checkoutUrl, mode: pinelabsMode() });
    }
    res.status(503).json({ error: "Card and netbanking checkout isn't live yet. Pay with Google Pay (UPI) instead." });
  }),
);

function markPaid(orderId: string, status: "authorized" | "captured" | "failed") {
  const hit = findPayment(orderId);
  if (!hit) return null;
  const result = updateWorkspace(hit.workspace.id, (x) => {
    const p = x.payments.find((q) => q.orderId === orderId)!;
    if (p.status === "captured" || p.status === "authorized") return; // already granted
    p.status = status;
    p.updatedAt = new Date().toISOString();
    if (status !== "failed") {
      x.plan = "pro";
      const from = x.proUntil && new Date(x.proUntil) > new Date() ? new Date(x.proUntil) : new Date();
      x.proUntil = new Date(from.getTime() + PRO_DAYS * 864e5).toISOString();
    }
    x.history.push({
      id: newId(8),
      at: p.updatedAt,
      actor: "pine-labs",
      action: "payment",
      summary: status === "failed" ? `Payment failed for order ${orderId}` : `Paid ₹${(p.amountPaise / 100).toFixed(0)} for Pro via ${p.provider === "pinelabs" ? "Pine Labs" : "Google Pay (UPI)"} (${orderId})`,
      projectVersion: x.project.version,
    });
  });
  if (status !== "failed" && result.ownerId) {
    for (const other of allWorkspaces()) {
      if (other.id !== result.id && other.ownerId === result.ownerId) updateWorkspace(other.id, (x) => Object.assign(x, { plan: "pro", proUntil: result.proUntil }));
    }
  }
  return result;
}

/**
 * Pine Labs redirects the customer here (GET or POST) with order_id, status and signature.
 * Pro is granted only after Pine Labs' own order record says the payment went through.
 */
async function confirmPinelabs(orderId: string): Promise<"paid" | "failed" | "pending"> {
  const order = await getPinelabsOrder(orderId);
  if (isPaidStatus(order.status)) {
    markPaid(orderId, order.status === "AUTHORIZED" ? "authorized" : "captured");
    return "paid";
  }
  if (["FAILED", "CANCELLED"].includes(order.status)) {
    markPaid(orderId, "failed");
    return "failed";
  }
  return "pending";
}

const pinelabsCallback: Handler = async (req, res) => {
  const p = { ...req.query, ...req.body } as Record<string, string>;
  const orderId = p.order_id ?? p.orderId;
  const hit = orderId ? findPayment(orderId) : null;
  if (!hit) return res.redirect(`${WEB_URL}/app?paid=0`);
  if (p.signature && !verifyPinelabsRedirect(p)) console.warn(`Pine Labs redirect signature did not match for ${orderId}; confirming with the order API`);
  let result: "paid" | "failed" | "pending" = "pending";
  try {
    result = await confirmPinelabs(orderId);
  } catch (e) {
    console.error("Pine Labs confirmation failed:", (e as Error).message);
  }
  res.redirect(`${WEB_URL}/app?w=${hit.workspace.id}&paid=${result === "paid" ? 1 : result === "failed" ? 0 : "pending"}`);
};
/** Pine Labs webhooks (ORDER_PROCESSED and friends): re-check the order with the API, never trust the body alone. */
app.post(
  "/api/payments/pinelabs/webhook",
  h(async (req, res) => {
    const b = req.body as Record<string, any>;
    const orderId = b?.data?.order_id ?? b?.order_id;
    res.sendStatus(200);
    if (orderId && findPayment(orderId)) await confirmPinelabs(orderId).catch((e) => console.error("Pine Labs webhook check failed:", (e as Error).message));
  }),
);
app.all("/api/payments/pinelabs/callback", h(pinelabsCallback));
app.all(
  "/api/payments/pinelabs/failure",
  h((req, res) => {
    const p = { ...req.query, ...req.body } as Record<string, string>;
    const orderId = p.order_id ?? p.orderId;
    const ws = orderId ? markPaid(orderId, "failed") : null;
    res.redirect(`${WEB_URL}/app${ws ? `?w=${ws.id}&paid=0` : "?paid=0"}`);
  }),
);

/* ---------------- Channels: member agents on Telegram and WhatsApp ---------------- */

app.post(
  "/api/channels/telegram/webhook",
  h(async (req, res) => {
    if (TELEGRAM_SECRET && req.get("X-Telegram-Bot-Api-Secret-Token") !== TELEGRAM_SECRET) {
      console.warn("Telegram webhook: rejected a request with a wrong secret");
      return res.sendStatus(401);
    }
    console.log("Telegram webhook: update received");
    const msg = parseUpdate(req.body);
    res.sendStatus(200); // ack fast; Telegram retries slow webhooks
    if (!msg) return;
    const { sendTelegram } = await import("./channels/telegram");
    const reply = await handleInbound("telegram", msg.chatId, msg.text, msg.displayName).catch((e) => `Something went wrong: ${(e as Error).message}`);
    if (reply) await sendTelegram(msg.chatId, reply);
  }),
);

app.post(
  "/api/channels/whatsapp/twilio",
  h(async (req, res) => {
    const params = req.body as Record<string, string>;
    const url = `${PUBLIC_API_URL}/api/channels/whatsapp/twilio`;
    if (!verifyTwilioSignature(url, params, req.get("X-Twilio-Signature"))) return res.sendStatus(403);
    const from = (params.From ?? "").replace(/^whatsapp:/, "");
    const reply = await handleInbound("whatsapp", from, params.Body ?? "", params.ProfileName);
    res.type("text/xml").send(twiml(reply));
  }),
);

/** Local testing without Telegram/Twilio accounts. Disabled in production unless ALLOW_DEV_CHANNEL=1. */
app.post(
  "/api/channels/dev/inbound",
  h(async (req, res) => {
    if (!DEV_CHANNEL) return res.sendStatus(404);
    const b = z.object({ channel: z.enum(["telegram", "whatsapp"]), address: z.string().min(1), text: z.string().min(1), name: z.string().optional() }).parse(req.body);
    res.json({ reply: await handleInbound(b.channel, b.address, b.text, b.name) });
  }),
);


/* ---------------- Google sign-in (OAuth 2.0) and Google Calendar ---------------- */

app.get("/api/auth/google/start", (req, res) => {
  if (!googleEnabled()) return res.status(503).send("Google sign-in isn't configured yet (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).");
  const next = typeof req.query.next === "string" && req.query.next.startsWith("/") ? req.query.next : "/app";
  const scope = req.query.scope === "workspace" ? "workspace" : req.query.scope === "calendar" ? "calendar" : "basic";
  const workspaceId = typeof req.query.w === "string" ? req.query.w : undefined;
  res.redirect(googleAuthUrl(GOOGLE_REDIRECT, { next, scope, workspaceId }));
});

app.get(
  "/api/auth/google/callback",
  h(async (req, res) => {
    const state = unseal<OAuthState>(String(req.query.state ?? ""));
    if (req.query.error || !state || typeof req.query.code !== "string") {
      return res.redirect(`${WEB_URL}/auth/done#error=${encodeURIComponent(String(req.query.error ?? "Sign-in was cancelled or expired"))}`);
    }
    const user = await completeGoogleLogin(req.query.code, GOOGLE_REDIRECT);
    linkMemberships(user);
    // A signed-in user opens their own events (or an empty console on first login), never a guest's workspace.
    const next = state.next;
    res.redirect(`${WEB_URL}/auth/done#token=${encodeURIComponent(sessionFor(user))}&next=${encodeURIComponent(next)}`);
  }),
);

app.get("/api/me", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "Not signed in" });
  res.json({
    user: publicUser(u),
    workspaces: workspacesOf(u).map(({ w, role }) => ({ id: w.id, name: w.project.name, role, plan: effectivePlan(w), trialEndsAt: w.trialEndsAt, updatedAt: w.updatedAt })),
  });
});

app.post(
  "/api/workspaces/:id/calendar/sync",
  h(async (req, res) => {
    const u = requireUser(req);
    const w = getWorkspace(param(req, "id"));
    requirePro(w, "Google Calendar sync");
    if (w.ownerId !== u.id) return res.status(403).json({ error: "Only the workspace owner can sync it to their calendar." });
    if (!u.google?.scope?.includes(CALENDAR_SCOPE)) return res.status(409).json({ error: "Connect Google Calendar first.", connect: true });
    const out = await syncCalendar(u, w);
    const ws = updateWorkspace(w.id, (x) => {
      x.calendar = { syncedAt: new Date().toISOString(), events: out.events };
      x.history.push({
        id: newId(8),
        at: new Date().toISOString(),
        actor: u.name,
        action: "reassessed",
        summary: `Synced the plan to Google Calendar (${out.created} new, ${out.updated} updated)`,
        projectVersion: x.project.version,
      });
    });
    res.json({ created: out.created, updated: out.updated, workspace: view(ws) });
  }),
);

/* ---------------- Traction proof: timestamped signups, payments, agent activity ---------------- */

/** Admin: what Telegram says about our webhook (last delivery error, pending updates). */
app.get(
  "/api/admin/telegram",
  h(async (req, res) => {
    if (!ADMIN_KEY || (req.query.key !== ADMIN_KEY && req.get("x-admin-key") !== ADMIN_KEY)) return res.sendStatus(404);
    res.json(await telegramWebhookInfo());
  }),
);

app.get("/api/admin/stats", (req, res) => {
  if (!ADMIN_KEY || (req.query.key !== ADMIN_KEY && req.get("x-admin-key") !== ADMIN_KEY)) return res.sendStatus(404);
  const ws = allWorkspaces();
  const users = allUsers();
  const now = Date.now();
  const within = (iso: string | undefined, ms: number) => !!iso && now - new Date(iso).getTime() < ms;
  const H = 36e5;
  const count = (pred: (w: WorkspaceState) => number) => ws.reduce((n, w) => n + pred(w), 0);
  res.json({
    generatedAt: new Date().toISOString(),
    active: {
      usersNow: users.filter((u) => within(u.lastSeenAt, 15 * 60e3)).length,
      users24h: users.filter((u) => within(u.lastSeenAt ?? u.lastLoginAt, 24 * H)).length,
      users7d: users.filter((u) => within(u.lastSeenAt ?? u.lastLoginAt, 7 * 24 * H)).length,
      events24h: ws.filter((w) => within(w.lastActiveAt ?? w.updatedAt, 24 * H)).length,
    },
    totals: {
      users: users.length,
      events: ws.length,
      pro: ws.filter((w) => effectivePlan(w) === "pro").length,
      paymentsPaid: ws.reduce((n, w) => n + w.payments.filter((p) => p.status === "captured" || p.status === "authorized").length, 0),
      paymentsPending: ws.reduce((n, w) => n + w.payments.filter((p) => p.status === "pending").length, 0),
      paymentsInitiated: ws.reduce((n, w) => n + w.payments.filter((p) => p.status === "initiated").length, 0),
      revenueInr: ws.reduce((n, w) => n + w.payments.filter((p) => p.status === "captured" || p.status === "authorized").reduce((m, p) => m + p.amountPaise / 100, 0), 0),
      agentCommands: count((w) => (w.agentThread ?? []).filter((t) => t.role === "user").length),
      analyses: count((w) => w.history.filter((e) => e.action === "change_requested").length),
      approvals: count((w) => w.history.filter((e) => e.action === "change_approved").length),
      googleActions: count((w) => w.history.filter((e) => e.action === "google").length),
      chatLinks: count((w) => w.links.length),
    },
    users: users
      .map((u) => ({ email: u.email, name: u.name, signedUpAt: u.createdAt, lastSeenAt: u.lastSeenAt ?? u.lastLoginAt, google: !!u.google?.refreshToken }))
      .sort((x, y) => y.lastSeenAt.localeCompare(x.lastSeenAt)),
    traffic: trafficSummary(),
    payments: ws
      .flatMap((w) => w.payments.map((p) => ({ ref: p.orderId, event: w.project.name, owner: w.ownerName ?? null, ownerEmail: (w.ownerId ? allUsers().find((u) => u.id === w.ownerId)?.email : null) ?? null, provider: p.provider, status: p.status, utr: p.utr ?? null, amount: p.amountPaise / 100, at: p.updatedAt })))
      .sort((a, b) => b.at.localeCompare(a.at)),
  });
});

/* ---------------- Errors ---------------- */

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid request", issues: err.issues });
  if (err instanceof StaleProposalError) return res.status(409).json({ error: err.message });
  const e = err as { status?: number; message?: string };
  if (!e.status || e.status >= 500) console.error(err);
  res.status(e.status ?? 500).json({ error: e.message ?? "Something went wrong" });
});

const port = Number(process.env.PORT ?? 4000);
await initStore();
app.listen(port, () => {
  console.log(`Hades API on :${port} · payments: ${pinelabsMode()} · whatsapp: ${whatsappEnabled() ? "on" : "off"}`);
  startTelegram((m) => handleInbound("telegram", m.chatId, m.text, m.displayName)).catch((e) => console.error("Telegram start failed:", e));
});
