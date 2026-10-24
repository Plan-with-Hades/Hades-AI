import cors from "cors";
import express from "express";
import { z } from "zod";
import {
  analyzeChange,
  applyMemberUpdate,
  approveChanges,
  createDemoProject,
  scheduleProject,
  StaleProposalError,
  type AuditEvent,
  type ImpactReport,
  type MemberMessage,
  type Project,
} from "@hades/core";

/**
 * Hades API. In-memory store for the first ship; swap `store` for Postgres (Render) next.
 * Agents propose, this server enforces: version checks, ownership, and approval gating.
 */
const app = express();
const origins = (process.env.CORS_ORIGINS ?? "http://localhost:3000").split(",").map((s) => s.trim());
app.use(cors({ origin: origins.includes("*") ? true : origins }));
app.use(express.json({ limit: "1mb" }));

interface Workspace {
  project: Project;
  reports: Map<string, ImpactReport>;
  history: AuditEvent[];
  messages: MemberMessage[];
}
const store = new Map<string, Workspace>();
const demo = createDemoProject();
store.set(demo.id, { project: demo, reports: new Map(), history: [], messages: [] });

const ws = (id: string) => {
  const w = store.get(id);
  if (!w) throw Object.assign(new Error(`Project ${id} not found`), { status: 404 });
  return w;
};

app.get("/health", (_req, res) => res.json({ ok: true, service: "hades-api", projects: store.size }));

app.get("/api/projects/:id", (req, res) => {
  const w = ws(req.params.id);
  res.json({ project: w.project, schedule: scheduleProject(w.project), history: w.history, messages: w.messages });
});

app.post("/api/projects/:id/change-requests", (req, res) => {
  const { request } = z.object({ request: z.string().min(3).max(2000) }).parse(req.body);
  const w = ws(req.params.id);
  const report = analyzeChange(w.project, request);
  w.reports.set(report.id, report);
  w.history.push({ id: report.id, at: report.createdAt, actor: "manager", action: "analysis_completed", summary: report.feasibility.headline, projectVersion: w.project.version });
  res.status(201).json(report);
});

app.post("/api/projects/:id/change-requests/:reportId/approve", (req, res) => {
  const { changeIds } = z.object({ changeIds: z.array(z.string()) }).parse(req.body);
  const w = ws(req.params.id);
  const report = w.reports.get(req.params.reportId);
  if (!report) return res.status(404).json({ error: "Analysis not found" });
  const out = approveChanges(w.project, report, changeIds);
  w.project = out.project;
  w.history.push(...out.events);
  w.messages.push(...out.messages);
  res.json(out);
});

app.post("/api/projects/:id/member-updates", (req, res) => {
  const body = z
    .object({ memberId: z.string(), taskId: z.string(), estimateDays: z.number().positive().max(60).optional(), note: z.string().min(1).max(1000) })
    .parse(req.body);
  const w = ws(req.params.id);
  const out = applyMemberUpdate(w.project, body);
  w.project = out.project;
  w.history.push(...out.events);
  w.messages.push(out.message);
  res.json(out);
});

app.post("/api/projects/:id/reset", (req, res) => {
  const fresh = createDemoProject();
  store.set(req.params.id, { project: { ...fresh, id: req.params.id }, reports: new Map(), history: [], messages: [] });
  res.json({ ok: true });
});

// Errors: validation → 400, stale approval → 409, everything else → its status or 500.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid request", issues: err.issues });
  if (err instanceof StaleProposalError) return res.status(409).json({ error: err.message });
  const e = err as { status?: number; message?: string };
  res.status(e.status ?? 500).json({ error: e.message ?? "Something went wrong" });
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => console.log(`Hades API listening on :${port}`));
