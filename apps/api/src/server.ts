import cors from "cors";
import express from "express";
import { z } from "zod";
import { analyzeChange, applyMemberUpdate, approveChanges, createDemoProject, effectivePlan, PRO_PRICE_INR, StaleProposalError, TRIAL_DAYS, type WorkspaceState } from "@hades/core";
import { CALENDAR_SCOPE, completeGoogleLogin, currentUser, googleAuthUrl, googleEnabled, publicUser, requireUser, sessionFor, unseal, type OAuthState } from "./auth";
import { syncCalendar } from "./google-calendar";
import { alertLead, deliver, handleInbound, toStoredReassessment } from "./agents";
import { speak, voiceEnabled } from "./voice/elevenlabs";
import { agenticorgEnabled, pendingReview, reviewWithAgenticOrg } from "./agenticorg";
import { parseUpdate, startTelegram, telegramBotUsername, telegramEnabled, TELEGRAM_SECRET } from "./channels/telegram";
import { twiml, verifyTwilioSignature, WHATSAPP_FROM, whatsappEnabled } from "./channels/whatsapp";
import { createPinelabsOrder, pinelabsConfigured, pinelabsMode, verifyPinelabsSignature } from "./payments/pinelabs";
import { allUsers, allWorkspaces, createWorkspace, initStore, findPayment, getReport, getWorkspace, newId, saveReport, updateWorkspace, workspacesOf } from "./store";

/**
 * Hades API. Agents propose; this server enforces version checks, ownership, approval gating,
 * payment verification and channel signatures.
 */
const app = express();
app.set("trust proxy", true);
const origins = (process.env.CORS_ORIGINS ?? "http://localhost:3000").split(",").map((s) => s.trim());
app.use(cors({ origin: origins.includes("*") ? true : origins }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

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
    });
  }),
);

/* ---------------- Workspaces ---------------- */

/** What the browser sees: the workspace plus its effective plan. */
const view = (w: WorkspaceState) => ({ ...w, effectivePlan: effectivePlan(w) });

/** Planning stops when the free trial ends; reading the plan and paying keep working. */
function requireActivePlan(w: WorkspaceState) {
  if (effectivePlan(w) === "expired") {
    throw Object.assign(new Error(`Your ${TRIAL_DAYS}-day free trial has ended. Upgrade to Hades Pro (₹${PRO_PRICE_INR}/month) to keep planning.`), { status: 402 });
  }
}

app.post("/api/workspaces", (req, res) => {
  const u = currentUser(req);
  res.status(201).json(view(createWorkspace(u ? { id: u.id, name: u.name } : undefined)));
});

app.get("/api/workspaces/:id", (req, res) => {
  const w = getWorkspace(param(req, "id"));
  if (req.query.since && req.query.since === w.updatedAt) return res.json({ changed: false, updatedAt: w.updatedAt });
  res.json(view(w));
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
    const { request } = z.object({ request: z.string().trim().min(3).max(2000) }).parse(req.body);
    const id = param(req, "id");
    const w = getWorkspace(id);
    requireActivePlan(w);
    const report = analyzeChange(w.project, request);
    if (agenticorgEnabled()) report.review = pendingReview();
    saveReport(report);
    updateWorkspace(id, (x) =>
      x.history.push({ id: newId(8), at: report.createdAt, actor: x.project.members[0].name, action: "change_requested", summary: request, projectVersion: x.project.version }),
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
    requireActivePlan(w);
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
    res.json(view(getWorkspace(id)));
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
      .object({ memberId: z.string(), taskId: z.string(), estimateDays: z.number().positive().max(60).optional(), note: z.string().trim().min(1).max(1000) })
      .parse(req.body);
    const id = param(req, "id");
    const w = getWorkspace(id);
    const out = applyMemberUpdate(w.project, body);
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
    if (body.memberId !== ws.project.members[0].id) await alertLead(ws, `${member?.name} on ${body.taskId}: "${body.note}"\n${out.reassessment.headline}`);
    res.json(view(ws));
  }),
);

app.post(
  "/api/workspaces/:id/reset",
  h((req, res) => {
    const id = param(req, "id");
    const fresh = { ...createDemoProject(), id };
    const ws = updateWorkspace(id, (x) => {
      x.project = fresh;
      x.messages = [];
      x.reassessment = null;
      x.history.push({ id: newId(8), at: new Date().toISOString(), actor: fresh.members[0].name, action: "project_created", summary: `Reset "${fresh.name}" to the starting plan`, projectVersion: 1 });
    });
    res.json(view(ws));
  }),
);

/* ---------------- Payments: Pine Labs hosted checkout ---------------- */

app.post(
  "/api/workspaces/:id/checkout",
  h(async (req, res) => {
    const id = param(req, "id");
    const w = getWorkspace(id);
    if (w.plan === "pro") return res.status(409).json({ error: "This team is already on Pro." });
    const reference = `hades-${id}-${Date.now()}`;
    const now = new Date().toISOString();
    if (pinelabsConfigured()) {
      const order = await createPinelabsOrder({
        reference,
        amountPaise: PRO_PRICE_PAISE,
        callbackUrl: `${PUBLIC_API_URL}/api/payments/pinelabs/callback`,
        failureCallbackUrl: `${PUBLIC_API_URL}/api/payments/pinelabs/failure`,
        customer: { firstName: w.project.members[0].name },
      });
      updateWorkspace(id, (x) =>
        x.payments.push({ id: reference, provider: "pinelabs", orderId: order.orderId, amountPaise: PRO_PRICE_PAISE, status: "created", checkoutUrl: order.checkoutUrl, createdAt: now, updatedAt: now }),
      );
      return res.status(201).json({ checkoutUrl: order.checkoutUrl, mode: pinelabsMode() });
    }
    const checkoutUrl = `${PUBLIC_API_URL}/api/payments/simulated/${reference}`;
    updateWorkspace(id, (x) =>
      x.payments.push({ id: reference, provider: "simulated", orderId: reference, amountPaise: PRO_PRICE_PAISE, status: "created", checkoutUrl, createdAt: now, updatedAt: now }),
    );
    res.status(201).json({ checkoutUrl, mode: "simulated" });
  }),
);

function markPaid(orderId: string, status: "authorized" | "captured" | "failed") {
  const hit = findPayment(orderId);
  if (!hit) return null;
  return updateWorkspace(hit.workspace.id, (x) => {
    const p = x.payments.find((q) => q.orderId === orderId)!;
    p.status = status;
    p.updatedAt = new Date().toISOString();
    if (status !== "failed") x.plan = "pro";
    x.history.push({
      id: newId(8),
      at: p.updatedAt,
      actor: "pine-labs",
      action: "payment",
      summary: status === "failed" ? `Payment failed for order ${orderId}` : `Paid ₹${(p.amountPaise / 100).toFixed(0)} for Pro via ${p.provider === "pinelabs" ? "Pine Labs" : "simulated checkout"} (${orderId})`,
      projectVersion: x.project.version,
    });
  });
}

/** Pine Labs redirects the customer here (GET or POST) with order_id, payment_status and signature. */
const pinelabsCallback: Handler = (req, res) => {
  const p = { ...req.query, ...req.body } as Record<string, string>;
  const orderId = p.order_id ?? p.orderId;
  const status = (p.payment_status ?? p.status ?? "").toUpperCase();
  const hit = orderId ? findPayment(orderId) : null;
  if (!hit) return res.redirect(`${WEB_URL}/app?paid=0`);
  if (!verifyPinelabsSignature(orderId, status, p.signature)) {
    console.warn(`Pine Labs signature check failed for ${orderId}`);
    return res.redirect(`${WEB_URL}/app?w=${hit.workspace.id}&paid=unverified`);
  }
  markPaid(orderId, status === "CAPTURED" ? "captured" : "authorized");
  res.redirect(`${WEB_URL}/app?w=${hit.workspace.id}&paid=1`);
};
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

/** Simulated checkout page, used only when Pine Labs credentials are not configured. */
app.get(
  "/api/payments/simulated/:ref",
  h((req, res) => {
    const ref = param(req, "ref");
    const hit = findPayment(ref);
    if (!hit) return res.status(404).send("Unknown order");
    const amount = (hit.payment.amountPaise / 100).toFixed(0);
    res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Simulated checkout · Hades AI</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#06070a;color:#e9ecf3;display:grid;place-items:center;min-height:100vh}
.card{width:min(380px,92vw);background:#0f1218;border:1px solid #232836;border-radius:16px;padding:28px}
.tag{display:inline-block;font:600 11px/1 ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;color:#f2c14e;background:rgba(242,193,78,.12);padding:6px 8px;border-radius:6px}
h1{font-size:22px;margin:16px 0 4px}p{color:#8b93a5;font-size:14px;line-height:1.5}
.amt{font:500 34px ui-monospace,monospace;margin:18px 0}button{width:100%;padding:13px;border-radius:10px;border:0;font-weight:600;font-size:15px;cursor:pointer;margin-top:8px}
.pay{background:#e9ecf3;color:#06070a}.cancel{background:transparent;color:#8b93a5;border:1px solid #232836}</style></head>
<body><form class="card" method="post"><span class="tag">Simulated · not Pine Labs</span><h1>Hades Pro</h1>
<p>Pine Labs test credentials aren't configured yet, so this page stands in for the hosted checkout. No money moves.</p>
<div class="amt">₹${amount}</div><button class="pay" name="result" value="success">Simulate UPI payment</button>
<button class="cancel" name="result" value="failure">Cancel</button></form></body></html>`);
  }),
);
app.post(
  "/api/payments/simulated/:ref",
  h((req, res) => {
    const ref = param(req, "ref");
    const ok = req.body?.result === "success";
    const ws = markPaid(ref, ok ? "authorized" : "failed");
    res.redirect(`${WEB_URL}/app${ws ? `?w=${ws.id}&paid=${ok ? 1 : 0}` : ""}`);
  }),
);

/* ---------------- Channels: member agents on Telegram and WhatsApp ---------------- */

app.post(
  "/api/channels/telegram/webhook",
  h(async (req, res) => {
    if (TELEGRAM_SECRET && req.get("X-Telegram-Bot-Api-Secret-Token") !== TELEGRAM_SECRET) return res.sendStatus(401);
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
  const scope = req.query.scope === "calendar" ? "calendar" : "basic";
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
    // Claim the guest workspace the user started in, if it has no owner yet.
    if (state.workspaceId) {
      try {
        const w = getWorkspace(state.workspaceId);
        if (!w.ownerId)
          updateWorkspace(w.id, (x) => {
            x.ownerId = user.id;
            x.ownerName = user.name;
          });
      } catch {}
    }
    const next = state.workspaceId ? `${state.next}${state.next.includes("?") ? "&" : "?"}w=${state.workspaceId}` : state.next;
    res.redirect(`${WEB_URL}/auth/done#token=${encodeURIComponent(sessionFor(user))}&next=${encodeURIComponent(next)}`);
  }),
);

app.get("/api/me", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "Not signed in" });
  res.json({
    user: publicUser(u),
    workspaces: workspacesOf(u.id).map((w) => ({ id: w.id, name: w.project.name, plan: effectivePlan(w), trialEndsAt: w.trialEndsAt, updatedAt: w.updatedAt })),
  });
});

app.post(
  "/api/workspaces/:id/calendar/sync",
  h(async (req, res) => {
    const u = requireUser(req);
    const w = getWorkspace(param(req, "id"));
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

app.get("/api/admin/stats", (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.sendStatus(404);
  const ws = allWorkspaces();
  const count = (pred: (w: WorkspaceState) => number) => ws.reduce((n, w) => n + pred(w), 0);
  res.json({
    generatedAt: new Date().toISOString(),
    users: allUsers()
      .map((u) => ({ email: u.email, name: u.name, signedUpAt: u.createdAt, lastLoginAt: u.lastLoginAt }))
      .sort((a, b) => a.signedUpAt.localeCompare(b.signedUpAt)),
    workspaces: ws.length,
    analyses: count((w) => w.history.filter((e) => e.action === "change_requested").length),
    approvals: count((w) => w.history.filter((e) => e.action === "change_approved").length),
    agentMessages: count((w) => w.messages.filter((m) => m.from === "agent").length),
    chatLinks: count((w) => w.links.length),
    payments: ws.flatMap((w) => w.payments.map((p) => ({ workspace: w.id, provider: p.provider, status: p.status, amount: p.amountPaise / 100, at: p.updatedAt }))),
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
