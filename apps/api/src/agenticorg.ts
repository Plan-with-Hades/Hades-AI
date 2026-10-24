import type { AgentReview, ImpactReport, Project } from "@hades/core";

/**
 * The Hades coordinator agent on AgenticOrg (Pine Labs). It reads the deterministic report and returns a
 * decision brief, the edits it would approve and per-teammate briefings. It never edits the plan: the lead
 * still approves in Hades, and AgenticOrg's HITL rule (low confidence or escalation) is shown to the lead.
 */
const BASE = (process.env.AGENTICORG_BASE_URL ?? "https://agenticorg.hackathon.pinelabs.com").replace(/\/$/, "");
const API_KEY = process.env.AGENTICORG_API_KEY ?? "";
const AGENT_ID = process.env.AGENTICORG_AGENT_ID ?? "ab2dfa5b-9973-4f3c-8691-d07c899dd2e2";
const TIMEOUT_MS = Number(process.env.AGENTICORG_TIMEOUT_MS ?? 45_000);
const HITL_CONFIDENCE = 0.9;

export const agenticorgEnabled = () => Boolean(API_KEY && AGENT_ID);

export function pendingReview(): AgentReview {
  return {
    provider: "agenticorg",
    status: "pending",
    runId: null,
    decisionBrief: "",
    recommendedChangeIds: [],
    briefings: [],
    questionsForLead: [],
    escalate: false,
    escalationReason: null,
    confidence: null,
    hitl: false,
  };
}

/** The compact input the agent's prompt expects: request, project, analysis, proposed_changes. */
function agentInputs(project: Project, report: ImpactReport) {
  const title = (id: string) => {
    const t = project.tasks.find((x) => x.id === id);
    return t ? `${t.id} ${t.title}` : id;
  };
  return {
    request: report.request,
    project: {
      name: project.name,
      deadline: project.deadline,
      lead: project.members[0]?.id,
      members: project.members.map((m) => ({ id: m.id, name: m.name, role: m.role })),
    },
    analysis: {
      interpretation: report.interpretation,
      verdict: report.feasibility.verdict,
      headline: report.feasibility.headline,
      baseline_finish: report.feasibility.before.finishDate,
      new_finish: report.feasibility.after.finishDate,
      finish_with_recommended: report.feasibility.withRecommended.finishDate,
      direct: report.directTaskIds.map(title),
      downstream: report.downstreamTaskIds.map(title),
      needs_review: report.inferredTaskIds.map(title),
      affected_members: report.affectedMemberIds,
      open_questions: report.openQuestions,
    },
    proposed_changes: report.changes.map((c) => ({ id: c.id, type: c.type, summary: c.summary, reason: c.reason, task_id: c.taskId ?? null, recommended: c.recommended })),
  };
}

/** The agent answers in JSON, sometimes inside a code fence or as a string field. */
function parseOutput(output: unknown): Record<string, unknown> {
  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>;
    if (typeof o.decision_brief === "string" || Array.isArray(o.briefings)) return o;
    for (const key of ["result", "response", "text", "content", "output"]) if (o[key] != null) return parseOutput(o[key]);
    return o;
  }
  if (typeof output === "string") {
    const match = output.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as Record<string, unknown>;
      } catch {}
    }
    return { decision_brief: output };
  }
  return {};
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export async function reviewWithAgenticOrg(project: Project, report: ImpactReport): Promise<AgentReview> {
  const started = Date.now();
  const base = pendingReview();
  try {
    const res = await fetch(`${BASE}/api/v1/agents/${AGENT_ID}/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "process", inputs: agentInputs(project, report), context: { source: "hades", project_id: project.id, report_id: report.id } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(body.detail ?? body.error ?? `AgenticOrg returned ${res.status}`));
    if (body.status === "failed" || body.error) throw new Error(String(body.error ?? "agent run failed"));

    const out = parseOutput(body.output);
    const confidence = typeof out.confidence === "number" ? out.confidence : typeof body.confidence === "number" ? body.confidence : null;
    const escalate = out.escalate === true;
    const validIds = new Set(report.changes.map((c) => c.id));
    const memberIds = new Set(project.members.map((m) => m.id));
    return {
      ...base,
      status: "done",
      runId: String(body.run_id ?? body.task_id ?? body.id ?? "") || null,
      decisionBrief: String(out.decision_brief ?? "").trim(),
      recommendedChangeIds: strings(out.recommended_change_ids).filter((id) => validIds.has(id)),
      briefings: (Array.isArray(out.briefings) ? out.briefings : [])
        .map((b) => b as Record<string, unknown>)
        .filter((b) => typeof b.member_id === "string" && memberIds.has(b.member_id) && typeof b.text === "string")
        .map((b) => ({ memberId: b.member_id as string, text: b.text as string })),
      questionsForLead: strings(out.questions_for_lead),
      escalate,
      escalationReason: typeof out.escalation_reason === "string" && out.escalation_reason ? out.escalation_reason : null,
      confidence,
      hitl: Boolean(body.hitl_trigger) || escalate || (confidence != null && confidence < HITL_CONFIDENCE),
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return { ...base, status: "failed", error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - started };
  }
}
