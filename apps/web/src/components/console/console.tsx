"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  analyzeChange,
  applyChanges,
  applyMemberUpdate,
  approveChanges,
  createDemoProject,
  DEMO_REPLIES,
  formatShort,
  GOLDEN_REQUEST,
  SAMPLE_REQUESTS,
  scheduleProject,
  schedule as runSchedule,
  StaleProposalError,
  type AuditEvent,
  type Basis,
  type ImpactReport,
  type MemberMessage,
  type Project,
  type ProposedChange,
  type Reassessment,
} from "@hades/core";
import { Logo } from "@/components/logo";
import { TaskGraph, type Highlight } from "./task-graph";

type Phase = "idle" | "analyzing" | "review";

interface State {
  project: Project;
  history: AuditEvent[];
  messages: MemberMessage[];
  reassessment: Reassessment | null;
}

const STORAGE_KEY = "hades:demo:v2";
const uid = () => Math.random().toString(36).slice(2, 9);
const lead = (p: Project) => p.members[0]?.name ?? "Manager";

function freshState(): State {
  const project = createDemoProject();
  return {
    project,
    history: [
      {
        id: uid(),
        at: new Date().toISOString(),
        actor: lead(project),
        action: "project_created",
        summary: `Created "${project.name}" with ${project.tasks.length} tasks and ${project.members.length} people`,
        projectVersion: 1,
      },
    ],
    messages: [],
    reassessment: null,
  };
}

const BASIS_LABEL: Record<Basis, { text: string; cls: string }> = {
  graph: { text: "Graph fact", cls: "bg-[var(--styx-soft)] text-styx-2" },
  schedule: { text: "Scheduler", cls: "bg-[var(--ok-soft)] text-ok" },
  ai_inference: { text: "AI inference", cls: "bg-[var(--warn-soft)] text-warn" },
  member_report: { text: "Teammate", cls: "bg-[var(--ember-soft)] text-ember" },
};

const AGENT_TONE: Record<string, string> = {
  scope: "text-styx-2",
  conflict: "text-ember",
  timeline: "text-ok",
  orchestrator: "text-text",
};

export function Console() {
  const [state, setState] = useState<State | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [report, setReport] = useState<ImpactReport | null>(null);
  const [decisions, setDecisions] = useState<Record<string, boolean>>({});
  const [step, setStep] = useState(0);
  const [request, setRequest] = useState(GOLDEN_REQUEST);
  const [selected, setSelected] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [inboxMember, setInboxMember] = useState<string | null>(null);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const timers = useRef<number[]>([]);

  // Load from this browser, or start the demo project.
  useEffect(() => {
    let loaded: State | null = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) loaded = JSON.parse(raw) as State;
    } catch {}
    setState(loaded ?? freshState());
  }, []);
  useEffect(() => {
    if (!state) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {}
  }, [state]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const flash = (msg: string) => {
    setToast(msg);
    timers.current.push(window.setTimeout(() => setToast(null), 3200));
  };

  const project = state?.project;
  const baseSchedule = useMemo(() => (project ? scheduleProject(project) : null), [project]);

  /* ---------------- Analysis ---------------- */
  const analyze = useCallback(
    (text: string) => {
      if (!state || !text.trim()) return;
      timers.current.forEach(clearTimeout);
      const r = analyzeChange(state.project, text);
      setReport(r);
      setDecisions(Object.fromEntries(r.changes.map((c) => [c.id, c.recommended])));
      setPhase("analyzing");
      setStep(0);
      // The agents run in milliseconds; reveal them one by one so people can follow the reasoning.
      [1, 2, 3, 4].forEach((s, i) => timers.current.push(window.setTimeout(() => setStep(s), 650 * (i + 1))));
      timers.current.push(window.setTimeout(() => setPhase("review"), 650 * 4 + 150));
      setState((st) =>
        st && {
          ...st,
          history: [
            ...st.history,
            { id: uid(), at: new Date().toISOString(), actor: lead(st.project), action: "change_requested", summary: text, projectVersion: st.project.version },
          ],
        },
      );
    },
    [state],
  );

  const approve = () => {
    if (!state || !report) return;
    try {
      const ids = Object.entries(decisions).filter(([, v]) => v).map(([k]) => k);
      const res = approveChanges(state.project, report, ids, lead(state.project));
      setState({
        ...state,
        project: res.project,
        history: [
          ...state.history,
          { id: uid(), at: new Date().toISOString(), actor: "orchestrator", action: "analysis_completed", summary: report.feasibility.headline, projectVersion: state.project.version },
          ...res.events,
        ],
        messages: [...state.messages, ...res.messages],
        reassessment: null,
      });
      setReport(null);
      setPhase("idle");
      setRequest("");
      flash(`Approved ${res.applied.length} change${res.applied.length === 1 ? "" : "s"}. ${res.messages.length} teammates briefed.`);
      if (res.messages[0]) setInboxMember(res.messages[0].memberId);
    } catch (e) {
      if (e instanceof StaleProposalError) flash(e.message);
      else throw e;
    }
  };

  const reject = () => {
    if (!state || !report) return;
    setState({
      ...state,
      history: [...state.history, { id: uid(), at: new Date().toISOString(), actor: lead(state.project), action: "change_rejected", summary: `Rejected: ${report.request}`, projectVersion: state.project.version }],
    });
    setReport(null);
    setPhase("idle");
    flash("Rejected. The plan is unchanged.");
  };

  const memberReply = (memberId: string, taskId: string, estimate: number | undefined, note: string) => {
    if (!state) return;
    try {
      const res = applyMemberUpdate(state.project, { memberId, taskId, estimateDays: estimate, note });
      setState({
        ...state,
        project: res.project,
        history: [...state.history, ...res.events],
        messages: [
          ...state.messages,
          res.message,
          { id: uid(), memberId, at: new Date().toISOString(), from: "agent", text: `Thanks. I've updated ${taskId} and told ${lead(state.project)}: ${res.reassessment.headline}`, taskIds: [taskId] },
        ],
        reassessment: res.reassessment,
      });
      flash(res.reassessment.headline);
    } catch (e) {
      flash((e as Error).message);
    }
  };

  const resetDemo = () => {
    timers.current.forEach(clearTimeout);
    setState(freshState());
    setReport(null);
    setPhase("idle");
    setRequest(GOLDEN_REQUEST);
    setInboxMember(null);
    flash("Demo project reset.");
  };

  /* ---------------- Derived view ---------------- */
  const view = useMemo(() => {
    if (!project || !baseSchedule) return null;
    const highlight: Record<string, Highlight> = {};
    let tasks = project.tasks;
    let dependencies = project.dependencies;
    let proposedEdges: { from: string; to: string }[] = [];
    let removedEdges: { from: string; to: string }[] = [];
    let sched = baseSchedule;
    if (report && step >= 1) {
      const chosen = report.changes.filter((c) => decisions[c.id]);
      const preview = applyChanges(project, chosen);
      const newIds = new Set(preview.tasks.filter((t) => !project.tasks.some((p) => p.id === t.id)).map((t) => t.id));
      tasks = preview.tasks;
      proposedEdges = preview.dependencies.filter((d) => !project.dependencies.some((p) => p.from === d.from && p.to === d.to));
      removedEdges = chosen.filter((c) => c.type === "remove_dependency").flatMap((c) => c.dependencies ?? []);
      dependencies = project.dependencies;
      sched = runSchedule(project, preview.tasks, preview.dependencies);
      if (step >= 1) report.directTaskIds.forEach((id) => (highlight[id] = "direct"));
      newIds.forEach((id) => (highlight[id] = "new"));
      if (step >= 2) {
        report.downstreamTaskIds.forEach((id) => (highlight[id] = highlight[id] ?? "downstream"));
        report.inferredTaskIds.forEach((id) => (highlight[id] = highlight[id] ?? "inferred"));
      }
    }
    return { tasks, dependencies, proposedEdges, removedEdges, sched, highlight };
  }, [project, baseSchedule, report, step, decisions]);

  if (!state || !project || !baseSchedule || !view) {
    return <div className="grid min-h-screen place-items-center text-muted">Summoning Hades…</div>;
  }

  const done = project.tasks.filter((t) => t.status === "done").length;
  const pct = Math.round((done / project.tasks.length) * 100);
  const chosenCount = report ? report.changes.filter((c) => decisions[c.id]).length : 0;
  const memberById = (id: string) => project.members.find((m) => m.id === id);

  return (
    <div className="flex min-h-screen flex-col lg:h-screen lg:min-h-0">
      {/* ---------------- Top bar ---------------- */}
      <header className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
          <Link href="/" className="flex items-center gap-2">
            <Logo className="h-6 w-6" />
            <span className="display text-sm font-bold">HADES AI</span>
          </Link>
          <div className="flex min-w-0 items-center gap-3">
            <span className="h-4 w-px bg-line-2" />
            <span className="truncate text-sm font-semibold">{project.name}</span>
            <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-muted">v{project.version}</span>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Pill label="Deadline" value={formatShort(project.deadline)} />
            <Pill
              label="Plan lands"
              value={formatShort(baseSchedule.finishDate)}
              tone={baseSchedule.bufferDays < 0 ? "ember" : baseSchedule.bufferDays <= 1 ? "warn" : "ok"}
            />
            <Pill label="Done" value={`${pct}%`} />
            <button onClick={resetDemo} className="rounded-full border border-line px-3 py-1.5 text-xs text-muted transition hover:border-line-2 hover:text-text">
              Reset demo
            </button>
            <button onClick={() => setUpgradeOpen(true)} className="rounded-full bg-text px-3.5 py-1.5 text-xs font-semibold text-bg transition hover:bg-styx-2">
              Upgrade · ₹99
            </button>
          </div>
        </div>
      </header>

      <div className="grid flex-1 gap-px bg-line lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_440px] lg:overflow-hidden">
        {/* ---------------- Left: graph + team ---------------- */}
        <section className="flex min-h-0 min-w-0 flex-col bg-bg lg:overflow-y-auto">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-6">
            <div>
              <h1 className="display text-base font-bold">Dependency graph</h1>
              <p className="text-xs text-muted">Click a task for details. Lit nodes are what the current change touches.</p>
            </div>
            <Legend />
          </div>
          <div className="relative h-[460px] lg:h-auto lg:min-h-[380px] lg:flex-1">
            <TaskGraph
              tasks={view.tasks}
              dependencies={view.dependencies}
              members={project.members}
              schedule={view.sched}
              highlight={view.highlight}
              proposedEdges={view.proposedEdges}
              removedEdges={view.removedEdges}
              selected={selected}
              onSelect={setSelected}
            />
            {selected ? (
              <TaskDrawer
                project={{ ...project, tasks: view.tasks }}
                taskId={selected}
                sched={view.sched}
                onClose={() => setSelected(null)}
              />
            ) : null}
          </div>
          <TeamStrip
            project={project}
            messages={state.messages}
            active={inboxMember}
            onOpen={(id) => setInboxMember(id === inboxMember ? null : id)}
          />
          {inboxMember ? (
            <Inbox
              project={project}
              memberId={inboxMember}
              messages={state.messages.filter((m) => m.memberId === inboxMember)}
              onReply={memberReply}
            />
          ) : null}
        </section>

        {/* ---------------- Right: change + agents + approval ---------------- */}
        <aside className="flex min-h-0 min-w-0 flex-col bg-bg-2">
          <div className="border-b border-line p-4 sm:p-5">
            <label htmlFor="change" className="label">
              What changed?
            </label>
            <textarea
              id="change"
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              rows={3}
              placeholder="e.g. Our title sponsor pulled out, but the fest date can't move."
              className="mt-2 w-full resize-none rounded-xl border border-line-2 bg-surface px-3.5 py-3 text-sm leading-relaxed text-text outline-none transition placeholder:text-dim focus:border-styx"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) analyze(request);
              }}
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {SAMPLE_REQUESTS.map((s) => (
                <button
                  key={s}
                  onClick={() => setRequest(s)}
                  className="rounded-full border border-line px-2.5 py-1 text-[11px] text-muted transition hover:border-line-2 hover:text-text"
                >
                  {s.length > 44 ? `${s.slice(0, 42)}…` : s}
                </button>
              ))}
            </div>
            <button
              onClick={() => analyze(request)}
              disabled={!request.trim() || phase === "analyzing"}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-styx px-4 py-3 text-sm font-semibold text-bg transition hover:bg-styx-2 disabled:opacity-40"
            >
              {phase === "analyzing" ? "Agents are working…" : "Trace the ripple"}
              <span aria-hidden className="font-mono text-xs opacity-70">Ctrl ↵</span>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            {report ? (
              <div className="space-y-4 p-4 sm:p-5">
                <div>
                  <span className="label">Interpreted as</span>
                  <p className="mt-1.5 text-sm leading-relaxed">{report.interpretation}</p>
                </div>

                <ol className="space-y-2">
                  {report.agents.map((a, i) => {
                    const visible = step > i;
                    const running = step === i && phase === "analyzing";
                    return (
                      <li key={a.agent} className={`rounded-xl border border-line bg-surface p-3.5 transition ${visible ? "opacity-100" : "opacity-50"}`}>
                        <div className="flex items-center justify-between gap-2">
                          <span className={`display text-[13px] font-bold ${AGENT_TONE[a.agent]}`}>{a.label}</span>
                          <span className="font-mono text-[10px] text-muted">
                            {visible ? "done" : running ? <span className="animate-pulse text-styx-2">thinking…</span> : "queued"}
                          </span>
                        </div>
                        <p className="mt-1 text-[11px] text-dim">“{a.question}”</p>
                        {visible ? (
                          <>
                            <p className="mt-2 text-[13px] leading-snug text-text">{a.summary}</p>
                            {a.findings.length ? (
                              <ul className="mt-2.5 space-y-1.5">
                                {a.findings.slice(0, 5).map((f) => (
                                  <li key={f.id} className="flex items-start gap-2 text-[12px] leading-snug text-muted">
                                    <BasisTag basis={f.basis} />
                                    <span>
                                      <span className={f.severity === "critical" ? "text-ember" : "text-text"}>{f.title}</span>
                                      <span className="block text-dim">{f.detail}</span>
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                          </>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>

                {phase === "review" ? (
                  <>
                    <Feasibility report={report} chosen={report.changes.filter((c) => decisions[c.id])} project={project} />

                    <div>
                      <div className="flex items-center justify-between">
                        <span className="label">Proposed edits</span>
                        <span className="font-mono text-[10px] text-muted">
                          {chosenCount}/{report.changes.length} selected
                        </span>
                      </div>
                      <ul className="mt-2 space-y-2">
                        {report.changes.map((c) => (
                          <ChangeRow key={c.id} change={c} on={!!decisions[c.id]} toggle={() => setDecisions((d) => ({ ...d, [c.id]: !d[c.id] }))} />
                        ))}
                      </ul>
                    </div>

                    {report.openQuestions.length ? (
                      <div className="rounded-xl border border-warn/30 bg-[var(--warn-soft)] p-3.5">
                        <span className="label !text-warn">Open questions</span>
                        <ul className="mt-2 space-y-1.5 text-[12.5px] leading-snug text-text">
                          {report.openQuestions.map((q) => (
                            <li key={q}>• {q}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    <div className="sticky bottom-0 -mx-4 flex gap-2 border-t border-line bg-bg-2/95 p-4 backdrop-blur sm:-mx-5 sm:px-5">
                      <button onClick={reject} className="flex-1 rounded-xl border border-line-2 px-4 py-3 text-sm font-semibold text-muted transition hover:text-text">
                        Reject
                      </button>
                      <button
                        onClick={approve}
                        disabled={chosenCount === 0}
                        className="flex-[2] rounded-xl bg-text px-4 py-3 text-sm font-semibold text-bg transition hover:bg-styx-2 disabled:opacity-40"
                      >
                        Approve {chosenCount} &amp; brief the team
                      </button>
                    </div>
                  </>
                ) : null}
              </div>
            ) : (
              <IdlePanel state={state} />
            )}
          </div>
        </aside>
      </div>

      {toast ? (
        <div role="status" className="glass fixed bottom-5 left-1/2 z-50 max-w-[92vw] -translate-x-1/2 rounded-full px-5 py-3 text-sm shadow-2xl">
          {toast}
        </div>
      ) : null}
      {upgradeOpen ? <UpgradeModal onClose={() => setUpgradeOpen(false)} /> : null}
    </div>
  );
}

/* ================================================================== */

function Pill({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" | "ember" }) {
  const c = tone === "ember" ? "text-ember" : tone === "warn" ? "text-warn" : tone === "ok" ? "text-ok" : "text-text";
  return (
    <span className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-xs">
      <span className="text-muted">{label}</span>
      <span className={`font-mono font-medium ${c}`}>{value}</span>
    </span>
  );
}

function Legend() {
  const items: [string, string][] = [
    ["border-styx", "Direct"],
    ["border-ember", "Downstream"],
    ["border-warn border-dashed", "Review"],
    ["border-ok border-dashed", "Proposed"],
  ];
  return (
    <div className="flex flex-wrap gap-3">
      {items.map(([c, l]) => (
        <span key={l} className="flex items-center gap-1.5 text-[11px] text-muted">
          <span className={`h-2.5 w-2.5 rounded-sm border-2 ${c}`} />
          {l}
        </span>
      ))}
    </div>
  );
}

function BasisTag({ basis }: { basis: Basis }) {
  const b = BASIS_LABEL[basis];
  return <span className={`mt-px shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${b.cls}`}>{b.text}</span>;
}

function ChangeRow({ change, on, toggle }: { change: ProposedChange; on: boolean; toggle: () => void }) {
  return (
    <li>
      <label className={`flex cursor-pointer gap-3 rounded-xl border p-3 transition ${on ? "border-styx/50 bg-[var(--styx-soft)]" : "border-line bg-surface hover:border-line-2"}`}>
        <input type="checkbox" checked={on} onChange={toggle} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--styx)]" />
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] font-semibold leading-snug">{change.summary}</span>
          </span>
          <span className="mt-1 block text-[12px] leading-snug text-muted">{change.reason}</span>
          <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <BasisTag basis={change.basis} />
            <span className={`font-mono text-[10px] ${AGENT_TONE[change.agent]}`}>{change.agent} agent</span>
            {change.recommended ? <span className="font-mono text-[10px] text-ok">recommended</span> : null}
          </span>
        </span>
      </label>
    </li>
  );
}

function Feasibility({ report, chosen, project }: { report: ImpactReport; chosen: ProposedChange[]; project: Project }) {
  const live = useMemo(() => {
    const p = applyChanges(project, chosen);
    return runSchedule(project, p.tasks, p.dependencies);
  }, [project, chosen]);
  const rows = [
    { label: "Before", s: report.feasibility.before },
    { label: "All scope changes", s: report.feasibility.after },
    { label: "Your selection", s: live },
  ];
  const max = Math.max(...rows.map((r) => r.s.finishDay), report.feasibility.before.deadlineDay) + 1;
  const deadlinePct = (report.feasibility.before.deadlineDay / max) * 100;
  const verdict = live.bufferDays < 0 ? "slips" : live.bufferDays <= 1 ? "tight" : "fits";
  const tone = verdict === "slips" ? "text-ember" : verdict === "tight" ? "text-warn" : "text-ok";
  return (
    <div className="rounded-xl border border-line bg-surface p-3.5">
      <div className="flex items-center justify-between">
        <span className="label">Timeline</span>
        <span className={`font-mono text-[11px] uppercase ${tone}`}>
          {verdict === "slips" ? `slips ${-live.bufferDays}d` : verdict === "tight" ? `tight · ${live.bufferDays}d buffer` : `fits · ${live.bufferDays}d buffer`}
        </span>
      </div>
      <div className="relative mt-3 space-y-2.5">
        <div className="absolute bottom-0 top-0 z-10 w-px bg-ember/70" style={{ left: `calc(96px + (100% - 96px) * ${deadlinePct / 100})` }}>
          <span className="absolute -top-4 -translate-x-1/2 whitespace-nowrap font-mono text-[9px] text-ember">deadline {formatShort(project.deadline)}</span>
        </div>
        {rows.map((r) => (
          <div key={r.label} className="grid grid-cols-[96px_1fr] items-center gap-2 pt-1">
            <span className="text-[11px] text-muted">{r.label}</span>
            <div className="relative h-2 rounded-full bg-line">
              <div
                className={`absolute inset-y-0 left-0 rounded-full ${r.s.bufferDays < 0 ? "bg-ember" : "bg-styx"}`}
                style={{ width: `${(r.s.finishDay / max) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[12.5px] leading-snug text-text">
        {live.bufferDays < 0
          ? `With this selection the plan lands ${formatShort(live.finishDate)}, ${-live.bufferDays} working day${live.bufferDays === -1 ? "" : "s"} late.`
          : `With this selection the plan lands ${formatShort(live.finishDate)}, on time.`}
      </p>
    </div>
  );
}

function TaskDrawer({ project, taskId, sched, onClose }: { project: Project; taskId: string; sched: ReturnType<typeof scheduleProject>; onClose: () => void }) {
  const t = project.tasks.find((x) => x.id === taskId);
  if (!t) return null;
  const owner = project.members.find((m) => m.id === t.ownerId);
  const st = sched.tasks[t.id];
  return (
    <div className="glass absolute bottom-4 left-4 z-20 w-[min(360px,calc(100%-2rem))] rounded-2xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="font-mono text-[10px] text-muted">
            {t.id} · {t.status.replace("_", " ")} · {t.priority}
          </span>
          <h3 className="mt-1 text-sm font-semibold">{t.title}</h3>
        </div>
        <button onClick={onClose} className="text-muted hover:text-text" aria-label="Close task details">
          ✕
        </button>
      </div>
      <p className="mt-2 text-[12.5px] leading-snug text-muted">{t.description}</p>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-[12px]">
        <div>
          <dt className="text-dim">Owner</dt>
          <dd>{owner?.name}</dd>
        </div>
        <div>
          <dt className="text-dim">Estimate</dt>
          <dd>{t.estimateDays == null ? <span className="text-warn">Unknown</span> : `${t.estimateDays} day${t.estimateDays === 1 ? "" : "s"}`}</dd>
        </div>
        {st ? (
          <div className="col-span-2">
            <dt className="text-dim">Scheduled</dt>
            <dd className="font-mono">
              {formatShort(st.startDate)} → {formatShort(st.endDate)} · {st.slackDays}d slack
            </dd>
          </div>
        ) : null}
      </dl>
      {t.acceptanceCriteria.length ? (
        <ul className="mt-3 space-y-1 text-[12px] text-muted">
          {t.acceptanceCriteria.map((c) => (
            <li key={c}>✓ {c}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function TeamStrip({ project, messages, active, onOpen }: { project: Project; messages: MemberMessage[]; active: string | null; onOpen: (id: string) => void }) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto border-t border-line px-4 py-3 sm:px-6">
      <span className="label mr-2 shrink-0">Team inboxes</span>
      {project.members.map((m) => {
        const unread = messages.filter((x) => x.memberId === m.id && x.from === "agent").length;
        return (
          <button
            key={m.id}
            onClick={() => onOpen(m.id)}
            className={`flex shrink-0 items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-xs transition ${active === m.id ? "border-styx bg-[var(--styx-soft)]" : "border-line hover:border-line-2"}`}
          >
            <span className="grid h-6 w-6 place-items-center rounded-full font-mono text-[10px] text-bg" style={{ background: `hsl(${m.hue} 70% 68%)` }}>
              {m.initials}
            </span>
            {m.name}
            {unread ? <span className="rounded-full bg-styx px-1.5 font-mono text-[10px] text-bg">{unread}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

function Inbox({
  project,
  memberId,
  messages,
  onReply,
}: {
  project: Project;
  memberId: string;
  messages: MemberMessage[];
  onReply: (memberId: string, taskId: string, estimate: number | undefined, note: string) => void;
}) {
  const member = project.members.find((m) => m.id === memberId)!;
  const own = project.tasks.filter((t) => t.ownerId === memberId && t.status !== "done");
  const [taskId, setTaskId] = useState(own[0]?.id ?? "");
  const [estimate, setEstimate] = useState<string>("");
  const [note, setNote] = useState("");
  useEffect(() => {
    setTaskId(own[0]?.id ?? "");
    // Pre-fill a realistic reply so anyone can play the teammate in one click.
    const demo = DEMO_REPLIES[memberId];
    if (demo && own.some((t) => t.id === demo.taskId)) {
      setTaskId(demo.taskId);
      setEstimate(demo.estimateDays != null ? String(demo.estimateDays) : "");
      setNote(demo.note);
    } else {
      setEstimate("");
      setNote("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId]);
  return (
    <div className="border-t border-line bg-bg-2 px-4 py-4 sm:px-6">
      <div className="mx-auto grid max-w-4xl gap-4 md:grid-cols-[1fr_300px]">
        <div>
          <span className="label">
            {member.name}&apos;s agent · {member.role}
          </span>
          <div className="mt-3 max-h-56 space-y-2 overflow-y-auto pr-1">
            {messages.length === 0 ? (
              <p className="text-sm text-dim">No messages yet. Approve a change and {member.name}&apos;s agent will brief them here.</p>
            ) : (
              messages.map((m) => (
                <div key={m.id} className={`max-w-[85%] whitespace-pre-line rounded-2xl px-3.5 py-2.5 text-[13px] leading-snug ${m.from === "agent" ? "bg-surface-2 text-text" : "ml-auto bg-styx text-bg"}`}>
                  {m.text}
                </div>
              ))
            )}
          </div>
        </div>
        <form
          className="space-y-2 rounded-xl border border-line bg-surface p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!taskId || !note.trim()) return;
            onReply(memberId, taskId, estimate ? Number(estimate) : undefined, note.trim());
            setNote("");
          }}
        >
          <span className="label">Reply as {member.name}</span>
          <select id="inbox-task" value={taskId} onChange={(e) => setTaskId(e.target.value)} className="w-full rounded-lg border border-line-2 bg-bg-2 px-2.5 py-2 text-sm">
            {own.map((t) => (
              <option key={t.id} value={t.id}>
                {t.id} · {t.title}
              </option>
            ))}
          </select>
          <input
            id="inbox-estimate"
            value={estimate}
            onChange={(e) => setEstimate(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="New estimate (days)"
            className="w-full rounded-lg border border-line-2 bg-bg-2 px-2.5 py-2 text-sm"
          />
          <textarea
            id="inbox-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Blocker or update"
            className="w-full resize-none rounded-lg border border-line-2 bg-bg-2 px-2.5 py-2 text-sm"
          />
          <button disabled={!own.length} className="w-full rounded-lg bg-text px-3 py-2 text-sm font-semibold text-bg disabled:opacity-40">
            Send update
          </button>
        </form>
      </div>
    </div>
  );
}

function IdlePanel({ state }: { state: State }) {
  return (
    <div className="space-y-5 p-4 sm:p-5">
      {state.reassessment ? (
        <div className={`rounded-xl border p-3.5 ${state.reassessment.schedule.feasible ? "border-ok/30 bg-[var(--ok-soft)]" : "border-ember/40 bg-[var(--ember-soft)]"}`}>
          <span className="label">Timeline agent · reassessed</span>
          <p className="mt-1.5 text-sm leading-snug">{state.reassessment.headline}</p>
          {state.reassessment.suggestions.map((s) => (
            <p key={s.id} className="mt-2 text-[12.5px] text-muted">
              → {s.summary}
            </p>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-line-2 p-4 text-sm leading-relaxed text-muted">
          Describe a change above. Hades will trace it through the graph, run the Scope, Conflict and Timeline agents, and
          wait for your approval.
        </div>
      )}
      <div>
        <span className="label">History</span>
        <ol className="mt-3 space-y-3 border-l border-line pl-4">
          {[...state.history].reverse().slice(0, 14).map((e) => (
            <li key={e.id} className="relative">
              <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-line-2" />
              <p className="text-[12.5px] leading-snug text-text">{e.summary}</p>
              <p className="mt-0.5 font-mono text-[10px] text-dim">
                {e.actor} · {e.action.replace(/_/g, " ")} · v{e.projectVersion} · {new Date(e.at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function UpgradeModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-line-2 bg-surface p-6" onClick={(e) => e.stopPropagation()}>
        <span className="label">Hades Pro</span>
        <h2 className="display mt-2 text-2xl font-bold">₹99 / team / month</h2>
        <ul className="mt-4 space-y-1.5 text-sm text-muted">
          <li>Unlimited projects and teammates</li>
          <li>WhatsApp and voice check-ins</li>
          <li>Full change history and exports</li>
        </ul>
        <p className="mt-5 rounded-lg border border-line bg-bg-2 p-3 text-[12.5px] leading-snug text-muted">
          Checkout runs on Pine Labs. Test-mode payments are being wired up now.
        </p>
        <div className="mt-5 flex gap-2">
          <button onClick={onClose} className="flex-1 rounded-xl border border-line-2 px-4 py-3 text-sm text-muted">
            Not now
          </button>
          <button disabled className="flex-[2] rounded-xl bg-text px-4 py-3 text-sm font-semibold text-bg opacity-50">
            Pay with Pine Labs
          </button>
        </div>
      </div>
    </div>
  );
}
