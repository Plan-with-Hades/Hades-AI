"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  analyzeChange,
  applyChanges,
  applyMemberUpdate,
  approveChanges,
  blankProject,
  DEMO_REPLIES,
  formatShort,
  FREE_FEATURES,
  PRO_FEATURES,
  PRO_PRICE_INR,
  SAMPLE_REQUESTS,
  runCommand,
  scheduleProject,
  schedule as runSchedule,
  StaleProposalError,
  TRIAL_DAYS,
  type AgentReview,
  type AgentTurn,
  type AuditEvent,
  type Basis,
  type ImpactReport,
  type MemberMessage,
  type Project,
  type ProposedChange,
  type PublicUser,
  type Reassessment,
  type WorkspaceState,
} from "@hades/core";
import { Logo } from "@/components/logo";
import { api, API_URL, ApiError, getRememberedWorkspace, getToken, rememberWorkspace, signOut, type InviteResult, type Meta, type ServerWorkspace } from "@/lib/api";
import { TaskGraph, type Highlight } from "./task-graph";
import { AgentPanel } from "./agent-panel";

type Phase = "idle" | "analyzing" | "review";
type StoredReassessment = NonNullable<WorkspaceState["reassessment"]>;

interface State {
  project: Project;
  history: AuditEvent[];
  messages: MemberMessage[];
  reassessment: StoredReassessment | null;
}

const STORAGE_KEY = "hades:demo:v4";
const uid = () => Math.random().toString(36).slice(2, 9);
const lead = (p: Project) => p.members[0]?.name ?? "Manager";
const toStored = (r: Reassessment): StoredReassessment => ({
  headline: r.headline,
  feasible: r.schedule.feasible,
  finishDate: r.schedule.finishDate,
  suggestions: r.suggestions.map((s) => ({ id: s.id, summary: s.summary })),
});

function freshState(): State {
  const project = blankProject("local", { name: "Event lead" });
  return {
    project,
    history: [
      {
        id: uid(),
        at: new Date().toISOString(),
        actor: lead(project),
        action: "project_created",
        summary: "Started an empty event",
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
  const [request, setRequest] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [inboxMember, setInboxMember] = useState<string | null>(null);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [upgradeReason, setUpgradeReason] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Online mode: the API owns the workspace so chats, payments and teammates share one plan.
  const [ws, setWs] = useState<ServerWorkspace | null>(null);
  const [me, setMe] = useState<PublicUser | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [myEvents, setMyEvents] = useState<{ id: string; name: string; role?: string }[]>([]);
  const [tab, setTab] = useState<"agent" | "ripple">("agent");
  const [localThread, setLocalThread] = useState<AgentTurn[]>([]);
  const [agentBusy, setAgentBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [needsGoogle, setNeedsGoogle] = useState(false);
  const timers = useRef<number[]>([]);
  const online = ws !== null;

  const flash = useCallback((msg: string) => {
    setToast(msg);
    timers.current.push(window.setTimeout(() => setToast(null), 4200));
  }, []);

  const applyServer = useCallback((w: ServerWorkspace) => {
    setWs(w);
    setState({ project: w.project, history: w.history, messages: w.messages, reassessment: w.reassessment });
  }, []);

  // Start: connect to the API if one is configured, otherwise run the demo in this browser.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (API_URL) {
        try {
          const params = new URLSearchParams(window.location.search);
          const [m, mine] = await Promise.all([api.meta(), getToken() ? api.me().catch(() => null) : Promise.resolve(null)]);
          const wanted = params.get("w") ?? getRememberedWorkspace();
          let w: ServerWorkspace | null = null;
          // Signed in: only your own events (or ones you were invited to). First login gets an empty console.
          const pick = mine ? (mine.workspaces.find((x) => x.id === wanted) ?? mine.workspaces[0])?.id : wanted;
          if (pick) {
            const got = await api.workspace(pick).catch(() => null);
            if (got && "project" in got) w = got;
          }
          w ??= await api.createWorkspace(true);
          if (cancelled) return;
          setMeta(m);
          setMe(mine?.user ?? null);
          setMyEvents(mine?.workspaces.map((x) => ({ id: x.id, name: x.name, role: x.role })) ?? []);
          applyServer(w);
          rememberWorkspace(w.id);
          const paid = params.get("paid");
          if (paid === "1") flash("Payment received. Your team is on Hades Pro.");
          else if (paid === "pending") flash("Your payment is being confirmed. Pro turns on as soon as it is.");
          else if (paid === "0") flash("The payment didn't go through. You can try again.");
          else if (paid === "unverified") flash("We couldn't verify that payment yet. It will update when Pine Labs confirms.");
          params.delete("paid");
          params.set("w", w.id);
          window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
          return;
        } catch (e) {
          console.warn("Hades API unavailable, running the demo locally.", e);
        }
      }
      let loaded: State | null = null;
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) loaded = JSON.parse(raw) as State;
      } catch {}
      if (!cancelled) setState(loaded ?? freshState());
    })();
    return () => {
      cancelled = true;
    };
  }, [applyServer, flash]);

  // Offline mode keeps the demo in this browser.
  useEffect(() => {
    if (!state || online) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {}
  }, [state, online]);

  // Online mode: pick up teammates' chat replies, payments and approvals made elsewhere.
  const wsId = ws?.id;
  const wsUpdated = ws?.updatedAt;
  useEffect(() => {
    if (!wsId) return;
    const t = window.setInterval(async () => {
      try {
        const got = await api.workspace(wsId, wsUpdated);
        if ("project" in got) applyServer(got);
      } catch {}
    }, 3000);
    return () => window.clearInterval(t);
  }, [wsId, wsUpdated, applyServer]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.status === 402) {
      setUpgradeReason(e.message);
      setUpgradeOpen(true);
      return;
    }
    flash(e instanceof Error ? e.message : "Something went wrong");
  };

  const project = state?.project;
  const baseSchedule = useMemo(() => (project ? scheduleProject(project) : null), [project]);

  // The AgenticOrg coordinator answers a few seconds after the engine; pick its review up when it lands.
  const reviewPending = report?.review?.status === "pending" ? report.id : null;
  useEffect(() => {
    if (!ws || !reviewPending) return;
    let tries = 0;
    const t = window.setInterval(async () => {
      tries += 1;
      const r = await api.report(ws.id, reviewPending).catch(() => null);
      if (r?.review && r.review.status !== "pending") {
        setReport((cur) => (cur && cur.id === r.id ? { ...cur, review: r.review } : cur));
        window.clearInterval(t);
      } else if (tries > 30) window.clearInterval(t);
    }, 2500);
    return () => window.clearInterval(t);
  }, [ws, reviewPending]);

  /* ---------------- Analysis ---------------- */
  const analyze = useCallback(
    async (text: string) => {
      if (!state || !text.trim()) return;
      timers.current.forEach(clearTimeout);
      let r: ImpactReport;
      try {
        r = ws ? await api.analyze(ws.id, text) : analyzeChange(state.project, text);
      } catch (e) {
        fail(e);
        return;
      }
      setReport(r);
      setTab("ripple");
      setDecisions(Object.fromEntries(r.changes.map((c) => [c.id, c.recommended])));
      setPhase("analyzing");
      setStep(0);
      // The agents run in milliseconds; reveal them one by one so people can follow the reasoning.
      [1, 2, 3, 4].forEach((s, i) => timers.current.push(window.setTimeout(() => setStep(s), 650 * (i + 1))));
      timers.current.push(window.setTimeout(() => setPhase("review"), 650 * 4 + 150));
      if (!ws) {
        setState((st) =>
          st && {
            ...st,
            history: [
              ...st.history,
              { id: uid(), at: new Date().toISOString(), actor: lead(st.project), action: "change_requested", summary: text, projectVersion: st.project.version },
            ],
          },
        );
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, ws],
  );

  const approve = async () => {
    if (!state || !report) return;
    const ids = Object.entries(decisions).filter(([, v]) => v).map(([k]) => k);
    if (ws) {
      setBusy(true);
      try {
        const before = state.messages.length;
        const w = await api.approve(ws.id, report.id, ids);
        applyServer(w);
        const briefed = w.messages.slice(before).filter((m) => m.from === "agent");
        setReport(null);
        setPhase("idle");
        setRequest("");
        setSelected(null);
        flash(
          `Approved ${ids.length} change${ids.length === 1 ? "" : "s"}. ${w.shifts?.length ? `${w.shifts.length} task date${w.shifts.length === 1 ? "" : "s"} moved on the graph. ` : ""}${emailSummary(w)}`,
        );
        if (briefed[0]) setInboxMember(briefed[0].memberId);
      } catch (e) {
        fail(e);
      } finally {
        setBusy(false);
      }
      return;
    }
    try {
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

  const reject = async () => {
    if (!state || !report) return;
    if (ws) {
      try {
        applyServer(await api.reject(ws.id, report.id));
      } catch (e) {
        fail(e);
      }
    } else {
      setState({
        ...state,
        history: [...state.history, { id: uid(), at: new Date().toISOString(), actor: lead(state.project), action: "change_rejected", summary: `Rejected: ${report.request}`, projectVersion: state.project.version }],
      });
    }
    setReport(null);
    setPhase("idle");
    flash("Rejected. The plan is unchanged.");
  };

  const emailSummary = (w: ServerWorkspace) =>
    w.emailed?.sent.length ? `Emailed ${w.emailed.sent.join(", ")}.` : w.emailed?.skipped ? w.emailed.skipped : "";

  const memberReply = async (memberId: string, taskId: string, estimate: number | undefined, note: string) => {
    if (!state) return;
    if (ws) {
      try {
        const w = await api.memberUpdate(ws.id, { memberId, taskId, estimateDays: estimate, note });
        applyServer(w);
        flash(`${w.reassessment?.headline ?? "Update sent."} ${emailSummary(w)}${w.shifts?.length ? ` ${w.shifts.length} date${w.shifts.length === 1 ? "" : "s"} moved.` : ""}`);
      } catch (e) {
        fail(e);
      }
      return;
    }
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
        reassessment: toStored(res.reassessment),
      });
      flash(res.reassessment.headline);
    } catch (e) {
      flash((e as Error).message);
    }
  };

  const setTaskStatus = async (taskId: string, status: "done" | "not_started") => {
    if (!state) return;
    setBusy(true);
    try {
      if (ws) {
        const w = await api.setTaskStatus(ws.id, taskId, status);
        applyServer(w);
        flash(`${taskId} marked ${status === "done" ? "done" : "open"}. The plan re-scheduled${w.googleUpdating ? " and your Google tracker and calendar are updating" : ""}.`);
      } else {
        setState((st) => st && { ...st, project: { ...st.project, version: st.project.version + 1, tasks: st.project.tasks.map((t) => (t.id === taskId ? { ...t, status } : t)) } });
        flash(`${taskId} marked ${status === "done" ? "done" : "open"}. The plan re-scheduled.`);
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const resetDemo = async () => {
    timers.current.forEach(clearTimeout);
    if (ws) {
      try {
        applyServer(await api.reset(ws.id));
      } catch (e) {
        fail(e);
        return;
      }
    } else {
      setState(freshState());
    }
    setReport(null);
    setPhase("idle");
    setRequest("");
    setInboxMember(null);
    setSelected(null);
    setLocalThread([]);
    setNeedsGoogle(false);
    setTab("agent");
    flash("Cleared. You have an empty console.");
  };

  const startCheckout = async () => {
    if (!ws) {
      flash("Checkout needs the Hades API. Start it with npm run dev:api.");
      return;
    }
    setBusy(true);
    try {
      const { checkoutUrl } = await api.checkout(ws.id);
      window.location.href = checkoutUrl;
    } catch (e) {
      setBusy(false);
      fail(e);
    }
  };

  const needPro = (what: string) => {
    setUpgradeReason(`${what} is a Hades Pro feature. Your free trial has ended.`);
    setUpgradeOpen(true);
  };

  const syncCalendar = async () => {
    if (!ws) {
      flash("Google Calendar sync needs the Hades API.");
      return;
    }
    if (!meta?.google.enabled) {
      flash("Google sign-in isn't configured on the server yet.");
      return;
    }
    if (ws.effectivePlan === "expired") return needPro("Google Calendar sync");
    if (!me || !me.calendarConnected) {
      window.location.href = api.signInUrl({ workspaceId: ws.id, calendar: true });
      return;
    }
    setBusy(true);
    try {
      const out = await api.syncCalendar(ws.id);
      applyServer(out.workspace);
      flash(`Synced to Google Calendar: ${out.created} new, ${out.updated} updated.`);
    } catch (e) {
      if (e instanceof ApiError && e.body?.connect) window.location.href = api.signInUrl({ workspaceId: ws.id, calendar: true });
      else fail(e);
    } finally {
      setBusy(false);
    }
  };

  /* ---------------- Hades agent ---------------- */
  const sendToAgent = async (text: string) => {
    if (!state) return;
    setNeedsGoogle(false);
    if (ws) {
      setAgentBusy(true);
      const pending: AgentTurn = { id: `p-${Date.now()}`, at: new Date().toISOString(), role: "user", text, by: me?.name };
      setWs((cur) => (cur ? { ...cur, agentThread: [...(cur.agentThread ?? []), pending] } : cur));
      try {
        const out = await api.agent(ws.id, text);
        applyServer(out.workspace);
        if (out.connectGoogle) setNeedsGoogle(true);
        if (out.upgrade) {
          setUpgradeReason(out.turn.text);
          setUpgradeOpen(true);
        }
        if (out.analyze) {
          setRequest(out.analyze);
          await analyze(out.analyze);
        }
      } catch (e) {
        fail(e);
        setWs((cur) => (cur ? { ...cur, agentThread: (cur.agentThread ?? []).filter((t) => t.id !== pending.id) } : cur));
      } finally {
        setAgentBusy(false);
      }
      return;
    }
    // Offline demo: plan edits run in the browser; Google needs the API.
    const at = new Date().toISOString();
    const out = runCommand(state.project, text);
    let reply = out.reply;
    if (out.intents.some((i) => i.tool.startsWith("google_") || i.tool === "calendar_sync" || i.tool === "nudge_owners")) reply = "That needs the Hades server and a Google sign-in. Open the hosted console to use Google Workspace.";
    if (out.project) setState((st) => st && { ...st, project: out.project! });
    setLocalThread((t) => [...t, { id: uid(), at, role: "user", text }, { id: uid(), at, role: "agent", text: reply, engine: "rules" }]);
    const change = out.intents.find((i) => i.tool === "analyze_change");
    if (change) {
      setRequest(text);
      await analyze(text);
    }
  };

  const newEvent = async () => {
    if (!ws) {
      flash("Creating events needs the Hades API.");
      return;
    }
    try {
      const w = await api.createWorkspace(true);
      applyServer(w);
      rememberWorkspace(w.id);
      setMyEvents((list) => [{ id: w.id, name: w.project.name }, ...list]);
      setReport(null);
      setTab("agent");
      window.history.replaceState(null, "", `/app?w=${w.id}`);
      flash("New event created. Tell the agent what you're planning.");
    } catch (e) {
      fail(e);
    }
  };

  const switchEvent = async (id: string) => {
    try {
      const got = await api.workspace(id);
      if ("project" in got) {
        applyServer(got);
        rememberWorkspace(got.id);
        setReport(null);
        window.history.replaceState(null, "", `/app?w=${got.id}`);
      }
    } catch (e) {
      fail(e);
    }
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
  const pct = project.tasks.length ? Math.round((done / project.tasks.length) * 100) : 0;
  const connectUrl = ws && meta?.google.enabled ? api.signInUrl({ workspaceId: ws.id, workspace: true }) : null;
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
            {myEvents.length > 1 ? (
              <select
                value={ws?.id}
                onChange={(e) => switchEvent(e.target.value)}
                className="max-w-[220px] truncate rounded-lg border border-line bg-surface px-2 py-1 text-sm font-semibold text-text outline-none"
              >
                {myEvents.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.id === ws?.id ? project.name : e.name}
                    {e.role === "member" ? " (member)" : ""}
                  </option>
                ))}
              </select>
            ) : (
              <span className="truncate text-sm font-semibold">{project.name}</span>
            )}
            <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-muted">v{project.version}</span>
            {ws?.role === "member" ? <span className="rounded bg-styx/15 px-1.5 py-0.5 font-mono text-[10px] text-styx-2">member</span> : null}
            {ws?.role === "manager" ? <span className="rounded bg-ok/15 px-1.5 py-0.5 font-mono text-[10px] text-ok">manager</span> : null}
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Pill label="Deadline" value={formatShort(project.deadline)} />
            <Pill
              label="Plan lands"
              value={formatShort(baseSchedule.finishDate)}
              tone={baseSchedule.bufferDays < 0 ? "ember" : baseSchedule.bufferDays <= 1 ? "warn" : "ok"}
            />
            <Pill label="Done" value={`${pct}%`} />
            <PlanBadge ws={ws} onUpgrade={() => setUpgradeOpen(true)} />
            <HeaderButton onClick={() => setConnectOpen(true)}>Team &amp; invites</HeaderButton>
            {online ? <HeaderButton onClick={newEvent}>+ New event</HeaderButton> : null}
            {me?.workspaceConnected ? (
              ws?.google?.folder ? (
                <a href={ws.google.folder.url} target="_blank" rel="noreferrer" className="rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-muted transition hover:border-line-2 hover:text-text">
                  Google Drive ↗
                </a>
              ) : (
                <HeaderButton onClick={() => (ws?.effectivePlan === "expired" ? needPro("Google Workspace") : sendToAgent("Create a Google workspace"))} disabled={agentBusy}>
                  Create Google workspace
                </HeaderButton>
              )
            ) : (
              <HeaderButton
                onClick={() => {
                  if (ws?.effectivePlan === "expired") return needPro("Google Workspace");
                  if (!me && ws && meta?.google.enabled) window.location.href = api.signInUrl({ workspaceId: ws.id });
                  else if (connectUrl) window.location.href = connectUrl;
                  else flash("Google sign-in isn't configured on the server yet.");
                }}
              >
                Connect Google Workspace
              </HeaderButton>
            )}
            <HeaderButton onClick={syncCalendar} disabled={busy}>
              {me?.calendarConnected ? "Sync calendar" : "Calendar"}
            </HeaderButton>
            <HeaderButton onClick={resetDemo}>Reset</HeaderButton>
            {online && meta?.google.enabled ? (
              me ? (
                <div className="relative">
                  <button
                    onClick={() => setMenuOpen((o) => !o)}
                    className="flex items-center gap-2 rounded-full border border-line py-1 pl-1 pr-3 text-xs transition hover:border-line-2"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                  >
                    {me.picture ? <img src={me.picture} alt="" className="h-6 w-6 rounded-full" referrerPolicy="no-referrer" /> : <span className="grid h-6 w-6 place-items-center rounded-full bg-styx/30 text-[10px]">{me.name[0]}</span>}
                    {me.name.split(" ")[0]}
                    <span aria-hidden className="text-[9px] text-muted">▾</span>
                  </button>
                  {menuOpen ? (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                      <div role="menu" className="absolute right-0 z-50 mt-2 w-64 rounded-xl border border-line-2 bg-surface p-3 shadow-xl">
                        <p className="truncate text-sm font-semibold">{me.name}</p>
                        <p className="truncate text-[12px] text-muted">{me.email}</p>
                        <p className="mt-2 text-[11px] text-dim">{me.workspaceConnected ? "Google Workspace connected" : "Google Workspace not connected"}</p>
                        <button
                          role="menuitem"
                          onClick={() => {
                            signOut();
                            window.location.href = "/app";
                          }}
                          className="mt-3 w-full rounded-lg border border-line-2 px-3 py-2 text-sm font-semibold text-text transition hover:border-ember hover:text-ember"
                        >
                          Sign out
                        </button>
                      </div>
                    </>
                  ) : null}
                </div>
              ) : (
                <a href={api.signInUrl({ workspaceId: ws?.id })} className="rounded-full border border-line-2 px-3.5 py-1.5 text-xs font-semibold transition hover:border-styx hover:text-styx-2">
                  Sign in with Google
                </a>
              )
            ) : null}
            {ws?.effectivePlan !== "pro" ? (
              <button onClick={() => setUpgradeOpen(true)} className="rounded-full bg-text px-3.5 py-1.5 text-xs font-semibold text-bg transition hover:bg-styx-2">
                Upgrade · ₹{PRO_PRICE_INR}
              </button>
            ) : null}
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
                canToggle={project.tasks.some((t) => t.id === selected) && !report}
                busy={busy}
                onStatus={(s) => setTaskStatus(selected, s)}
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
          <div className="flex border-b border-line">
            {(["agent", "ripple"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 px-4 py-3 text-[13px] font-semibold transition ${tab === t ? "border-b-2 border-styx text-text" : "text-muted hover:text-text"}`}
              >
                {t === "agent" ? "Agent" : "Change ripple"}
              </button>
            ))}
          </div>
          {tab === "agent" ? (
            <AgentPanel
              thread={ws ? (ws.agentThread ?? []) : localThread}
              busy={agentBusy}
              google={ws?.google}
              connectUrl={needsGoogle ? connectUrl : null}
              onSend={sendToAgent}
            />
          ) : (
          <>
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

                    {report.review || (ws && meta?.voice?.enabled) ? (
                      <CoordinatorCard
                        review={report.review}
                        project={project}
                        voiceUrl={ws && meta?.voice?.enabled ? api.voiceUrl(ws.id, report.id) : null}
                        onUsePicks={(ids) => setDecisions(Object.fromEntries(report.changes.map((c) => [c.id, ids.includes(c.id)])))}
                      />
                    ) : null}

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
          </>
          )}
        </aside>
      </div>

      {toast ? (
        <div role="status" className="glass fixed bottom-5 left-1/2 z-50 max-w-[92vw] -translate-x-1/2 rounded-full px-5 py-3 text-sm shadow-2xl">
          {toast}
        </div>
      ) : null}
      {upgradeOpen ? (
        <UpgradeModal
          reason={upgradeReason}
          mode={meta?.payments.mode ?? null}
          busy={busy}
          onPay={startCheckout}
          upi={meta?.upi ?? null}
          signInUrl={ws && meta?.google.enabled ? api.signInUrl({ workspaceId: ws.id }) : null}
          signedIn={!!me}
          canPay={!!me && !!ws && ws.ownerId === me.id}
          onOpen={() => {
            if (ws && me && ws.ownerId === me.id && meta?.upi) api.upiIntent(ws.id).catch(() => {});
          }}
          pendingUpi={!!ws?.payments.some((p) => p.provider === "upi" && p.status === "pending")}
          onUpi={async (utr) => {
            if (!ws) return "Payments need the Hades API.";
            try {
              applyServer(await api.payUpi(ws.id, utr));
              return null;
            } catch (e) {
              return e instanceof Error ? e.message : "Could not submit the payment";
            }
          }}
          onClose={() => {
            setUpgradeOpen(false);
            setUpgradeReason(null);
          }}
        />
      ) : null}
      {connectOpen ? <ConnectModal ws={ws} meta={meta} project={project} onClose={() => setConnectOpen(false)} onWorkspace={applyServer} canInvite={!!ws && ws.role !== "member"} /> : null}
    </div>
  );
}

/* ================================================================== */

/** The AgenticOrg coordinator's second opinion, plus the ElevenLabs read-out of the summary. */
function CoordinatorCard({
  review,
  project,
  voiceUrl,
  onUsePicks,
}: {
  review?: AgentReview;
  project: Project;
  voiceUrl: string | null;
  onUsePicks: (ids: string[]) => void;
}) {
  const name = (id: string) => project.members.find((m) => m.id === id)?.name ?? id;
  return (
    <div className="rounded-xl border border-styx/30 bg-surface p-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="display text-[13px] font-bold text-styx-2">Coordinator · AgenticOrg</span>
        <div className="flex items-center gap-2">
          {voiceUrl ? <VoiceButton url={voiceUrl} /> : null}
          {review?.status === "done" && review.confidence != null ? (
            <span className="font-mono text-[10px] text-muted">{Math.round(review.confidence * 100)}% sure</span>
          ) : null}
        </div>
      </div>
      {!review ? (
        <p className="mt-2 text-[12px] text-dim">Listen to the impact summary.</p>
      ) : review.status === "pending" ? (
        <p className="mt-2 animate-pulse text-[12.5px] text-dim">Reviewing the plan on AgenticOrg…</p>
      ) : review.status === "failed" ? (
        <p className="mt-2 text-[12px] text-dim">The coordinator could not review this one ({review.error}). The engine’s plan above still stands.</p>
      ) : (
        <>
          <p className="mt-2 text-[13px] leading-snug text-text">{review.decisionBrief}</p>
          {review.hitl ? (
            <p className="mt-2.5 rounded-lg border border-warn/30 bg-[var(--warn-soft)] px-2.5 py-2 text-[12px] leading-snug text-warn">
              Needs your sign-off{review.escalationReason ? `: ${review.escalationReason}` : "."}
            </p>
          ) : null}
          {review.questionsForLead.length ? (
            <ul className="mt-2 space-y-1 text-[12px] text-muted">
              {review.questionsForLead.map((q) => (
                <li key={q}>• {q}</li>
              ))}
            </ul>
          ) : null}
          {review.briefings.length ? (
            <p className="mt-2 text-[11px] text-dim">Personal notes ready for {review.briefings.map((b) => name(b.memberId)).join(", ")}. They go out with your approval.</p>
          ) : null}
          <div className="mt-2.5 flex items-center justify-between gap-2">
            {review.recommendedChangeIds.length ? (
              <button onClick={() => onUsePicks(review.recommendedChangeIds)} className="rounded-lg border border-line-2 px-2.5 py-1.5 text-[11.5px] font-semibold text-text transition hover:border-styx">
                Use its {review.recommendedChangeIds.length} picks
              </button>
            ) : (
              <span />
            )}
            {review.runId ? <span className="font-mono text-[10px] text-dim">run {review.runId.slice(0, 8)}</span> : null}
          </div>
        </>
      )}
    </div>
  );
}

function VoiceButton({ url }: { url: string }) {
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => audio.current?.pause(), []);
  const toggle = () => {
    if (state === "playing") {
      audio.current?.pause();
      setState("idle");
      return;
    }
    if (!audio.current || audio.current.src !== url) {
      audio.current?.pause();
      audio.current = new Audio(url);
      audio.current.onended = () => setState("idle");
      audio.current.onerror = () => setState("idle");
      audio.current.onplaying = () => setState("playing");
    }
    setState("loading");
    audio.current.play().catch(() => setState("idle"));
  };
  return (
    <button onClick={toggle} className="rounded-md border border-line-2 px-2 py-0.5 font-mono text-[10px] text-muted transition hover:text-text">
      {state === "playing" ? "■ stop" : state === "loading" ? "loading…" : "▶ listen"}
    </button>
  );
}

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

function TaskDrawer({
  project,
  taskId,
  sched,
  onClose,
  canToggle,
  busy,
  onStatus,
}: {
  project: Project;
  taskId: string;
  sched: ReturnType<typeof scheduleProject>;
  onClose: () => void;
  canToggle: boolean;
  busy: boolean;
  onStatus: (s: "done" | "not_started") => void;
}) {
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
      {canToggle ? (
        <button
          onClick={() => onStatus(t.status === "done" ? "not_started" : "done")}
          disabled={busy}
          className={`mt-3 w-full rounded-lg px-3 py-2 text-sm font-semibold transition disabled:opacity-50 ${
            t.status === "done" ? "border border-line-2 text-muted hover:text-text" : "bg-ok text-bg hover:opacity-90"
          }`}
        >
          {t.status === "done" ? "Reopen task" : "✓ Mark as done"}
        </button>
      ) : null}
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
            if (!taskId) return;
            onReply(memberId, taskId, estimate ? Number(estimate) : undefined, note.trim());
            setNote("");
          }}
        >
          <span className="label">Update for {member.name}</span>
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
            placeholder="Days needed / remaining"
            className="w-full rounded-lg border border-line-2 bg-bg-2 px-2.5 py-2 text-sm"
          />
          <textarea
            id="inbox-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Optional: describe the change or give orders. Real teammates get it by email."
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
        <div className={`rounded-xl border p-3.5 ${state.reassessment.feasible ? "border-ok/30 bg-[var(--ok-soft)]" : "border-ember/40 bg-[var(--ember-soft)]"}`}>
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

function HeaderButton({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-full border border-line px-3 py-1.5 text-xs text-muted transition hover:border-line-2 hover:text-text disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function PlanBadge({ ws, onUpgrade }: { ws: ServerWorkspace | null; onUpgrade: () => void }) {
  if (!ws) return <Pill label="Plan" value="Demo" />;
  if (ws.effectivePlan === "pro") return <Pill label="Plan" value="Pro" tone="ok" />;
  if (ws.effectivePlan === "expired")
    return (
      <button onClick={onUpgrade} className="rounded-full border border-ember/50 bg-[var(--ember-soft)] px-3 py-1.5 text-xs text-ember">
        Trial ended
      </button>
    );
  const ms = new Date(ws.trialEndsAt).getTime() - Date.now();
  const days = Math.floor(ms / 864e5);
  const hours = Math.max(0, Math.floor((ms % 864e5) / 36e5));
  return <Pill label="Free trial" value={days > 0 ? `${days}d ${hours}h left` : `${hours}h left`} tone={days < 1 ? "warn" : undefined} />;
}

function UpgradeModal({
  reason,
  mode,
  busy,
  onPay,
  onClose,
  upi,
  pendingUpi,
  onUpi,
  onOpen,
  signInUrl,
  signedIn,
  canPay,
}: {
  reason: string | null;
  mode: Meta["payments"]["mode"] | null;
  busy: boolean;
  onPay: () => void;
  onClose: () => void;
  upi: { vpa: string; name: string } | null;
  pendingUpi: boolean;
  onUpi: (utr: string) => Promise<string | null>;
  onOpen: () => void;
  signInUrl: string | null;
  signedIn: boolean;
  canPay: boolean;
}) {
  useEffect(() => {
    onOpen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [utr, setUtr] = useState("");
  const [upiMsg, setUpiMsg] = useState<string | null>(null);
  const upiLink = upi
    ? `upi://pay?${new URLSearchParams({ pa: upi.vpa, pn: upi.name, am: String(PRO_PRICE_INR), cu: "INR", tn: "Hades AI Pro - 1 month" })}`
    : null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-line-2 bg-surface p-6" onClick={(e) => e.stopPropagation()}>
        <span className="label">Hades Pro</span>
        <h2 className="display mt-2 text-2xl font-bold">₹{PRO_PRICE_INR} / team / month</h2>
        {reason ? <p className="mt-3 rounded-lg border border-ember/40 bg-[var(--ember-soft)] p-3 text-[13px] leading-snug text-text">{reason}</p> : null}
        <p className="label mt-4">Pro includes</p>
        <ul className="mt-2 space-y-1.5 text-sm text-text">
          {PRO_FEATURES.map((f) => (
            <li key={f}>✓ {f}</li>
          ))}
        </ul>
        <p className="label mt-4">Always free</p>
        <ul className="mt-2 space-y-1 text-[12.5px] text-muted">
          {FREE_FEATURES.map((f) => (
            <li key={f}>• {f}</li>
          ))}
        </ul>
        {!signedIn ? (
          <div className="mt-5 rounded-xl border border-styx/40 bg-bg-2 p-4 text-[13px] text-muted">
            Sign in with Google first. Pro is attached to your account, so you can only pay once you&apos;re signed in.
            {signInUrl ? (
              <a href={signInUrl} className="mt-3 block rounded-lg bg-text px-3 py-2.5 text-center text-sm font-semibold text-bg">
                Sign in with Google to upgrade
              </a>
            ) : (
              <span className="mt-2 block text-ember">Sign-in isn&apos;t configured on this server yet.</span>
            )}
          </div>
        ) : !canPay ? (
          <p className="mt-5 rounded-xl border border-line bg-bg-2 p-4 text-[13px] text-muted">Only the event manager can upgrade this event. Ask them to open Upgrade.</p>
        ) : null}
        {canPay && upi && upiLink ? (
          <div className="mt-5 rounded-xl border border-styx/40 bg-bg-2 p-4">
            <span className="label">Pay with Google Pay (UPI)</span>
            <div className="mt-3 flex items-center gap-4">
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=160x160&margin=6&data=${encodeURIComponent(upiLink)}`}
                alt="UPI QR code"
                className="h-28 w-28 rounded-lg bg-white"
              />
              <div className="text-[12.5px] leading-snug text-muted">
                Scan with Google Pay or any UPI app, or tap below on your phone. Pays ₹{PRO_PRICE_INR} to <span className="font-mono text-text">{upi.vpa}</span>.
                <a href={upiLink} className="mt-2 block rounded-lg bg-text px-3 py-2 text-center text-[13px] font-semibold text-bg">
                  Open Google Pay
                </a>
              </div>
            </div>
            <details className="mt-3 text-[12px] text-muted">
              <summary className="cursor-pointer text-styx-2">Payment failed or &quot;limit reached&quot;?</summary>
              <ul className="mt-2 list-disc space-y-1 pl-4 leading-snug">
                <li>
                  That limit comes from your bank or UPI app (daily amount, daily number of payments, or a new account). Try another UPI app or bank account, or wait until tomorrow.
                </li>
                <li>
                  Pay manually: in Google Pay choose <b>Pay UPI ID</b>, enter <span className="font-mono text-text">{upi.vpa}</span> and ₹{PRO_PRICE_INR}.
                </li>
                <li>Paid but it failed to confirm? Enter the UPI reference (UTR) below anyway; we check it against our account.</li>
              </ul>
            </details>
            {pendingUpi ? (
              <p className="mt-3 text-[12.5px] text-ok">Payment received. We&apos;re confirming it; Pro turns on within minutes.</p>
            ) : (
              <form
                className="mt-3 flex gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setUpiMsg(await onUpi(utr.trim()));
                }}
              >
                <input
                  value={utr}
                  onChange={(e) => setUtr(e.target.value)}
                  placeholder="UPI reference (UTR) after paying"
                  className="flex-1 rounded-lg border border-line-2 bg-surface px-3 py-2 text-sm outline-none focus:border-styx"
                />
                <button className="rounded-lg border border-line-2 px-3 text-sm font-semibold text-text hover:border-styx">I&apos;ve paid</button>
              </form>
            )}
            {upiMsg ? <p className="mt-2 text-[12px] text-ember">{upiMsg}</p> : null}
          </div>
        ) : null}
        <div className="mt-5 flex gap-2">
          <button onClick={onClose} className="flex-1 rounded-xl border border-line-2 px-4 py-3 text-sm text-muted">
            Not now
          </button>
          {mode === "live" || mode === "test" ? (
            <button onClick={onPay} disabled={busy} className="flex-[2] rounded-xl bg-text px-4 py-3 text-sm font-semibold text-bg transition hover:bg-styx-2 disabled:opacity-50">
              {busy ? "Opening Pine Labs…" : mode === "test" ? "Card / netbanking (Pine Labs test)" : "Card / netbanking (Pine Labs)"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ConnectModal({
  ws,
  meta,
  project,
  onClose,
  onWorkspace,
  canInvite,
}: {
  ws: ServerWorkspace | null;
  meta: Meta | null;
  project: Project;
  onClose: () => void;
  onWorkspace: (w: ServerWorkspace) => void;
  canInvite: boolean;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", role: "", email: "" });
  const [sending, setSending] = useState(false);
  const [last, setLast] = useState<InviteResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const add = async () => {
    if (!ws) return;
    setSending(true);
    setErr(null);
    try {
      const out = await api.addMember(ws.id, { name: form.name, role: form.role || undefined, email: form.email });
      onWorkspace(out.workspace);
      setLast(out.invite);
      setForm({ name: "", role: "", email: "" });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not add them");
    } finally {
      setSending(false);
    }
  };
  const resend = async (memberId: string) => {
    if (!ws) return;
    try {
      const out = await api.invite(ws.id, memberId);
      onWorkspace(out.workspace);
      setLast(out.invite);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not send the invite");
    }
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {}
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-line-2 bg-surface p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <span className="label">Team</span>
            <h2 className="display mt-2 text-xl font-bold">People &amp; invites</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              Add teammates by email. Hades invites them from your Gmail and shares the event&apos;s Drive folder; they sign in with Google using that
              email to see the plan and update their tasks. Calendar invites go out on the next calendar sync.
            </p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text" aria-label="Close">
            ✕
          </button>
        </div>
        {!ws ? (
          <p className="mt-5 rounded-lg border border-warn/30 bg-[var(--warn-soft)] p-3 text-sm">Start the Hades API to connect chats. The web inboxes below the graph work without it.</p>
        ) : (
          <>
            {canInvite ? (
              <form
                className="mt-5 grid gap-2 rounded-xl border border-line bg-bg-2 p-3 sm:grid-cols-[1fr_1fr_1.4fr_auto]"
                onSubmit={(e) => {
                  e.preventDefault();
                  add();
                }}
              >
                <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Name" className="rounded-lg border border-line-2 bg-surface px-3 py-2 text-sm outline-none focus:border-styx" />
                <input value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} placeholder="Role (e.g. Marketing)" className="rounded-lg border border-line-2 bg-surface px-3 py-2 text-sm outline-none focus:border-styx" />
                <input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="Google email" className="rounded-lg border border-line-2 bg-surface px-3 py-2 text-sm outline-none focus:border-styx" />
                <button disabled={sending} className="rounded-lg bg-text px-4 py-2 text-sm font-semibold text-bg transition hover:bg-styx-2 disabled:opacity-50">
                  {sending ? "Inviting…" : "Add & invite"}
                </button>
              </form>
            ) : null}
            {err ? <p className="mt-2 text-sm text-ember">{err}</p> : null}
            {last ? (
              <p className="mt-2 rounded-lg border border-line bg-bg-2 p-3 text-[12.5px] text-muted">
                {last.emailed ? `Invite emailed to ${last.email} from your Gmail.` : `Share this link with ${last.email}: `}
                {!last.emailed ? (
                  <button onClick={() => copy(last.link)} className="font-mono text-styx-2 underline">
                    {copied === last.link ? "Copied" : last.link}
                  </button>
                ) : null}
                {last.shared ? " Drive folder shared." : ""}
                {last.note ? <span className="block text-dim">{last.note}</span> : null}
              </p>
            ) : null}
            <div className="mt-5 grid gap-2 text-[12.5px] sm:grid-cols-2">
              <div className="rounded-lg border border-line bg-bg-2 p-3">
                <span className="label">Telegram</span>
                <p className="mt-1 text-muted">
                  {meta?.telegram.bot ? (
                    <>Tap the link for each teammate. It opens @{meta.telegram.bot} and links them.</>
                  ) : (
                    "Not configured on the server yet (TELEGRAM_BOT_TOKEN)."
                  )}
                </p>
              </div>
              <div className="rounded-lg border border-line bg-bg-2 p-3">
                <span className="label">WhatsApp</span>
                <p className="mt-1 text-muted">
                  {meta?.whatsapp.number ? (
                    <>
                      Join the sandbox once, then send <span className="font-mono text-text">hades &lt;code&gt;</span> to {meta.whatsapp.number}.
                    </>
                  ) : (
                    "Not configured on the server yet (Twilio)."
                  )}
                </p>
              </div>
            </div>
            <ul className="mt-4 divide-y divide-line rounded-xl border border-line">
              {project.members.map((m) => {
                const code = ws.joinCodes[m.id];
                const links = ws.links.filter((l) => l.memberId === m.id);
                return (
                  <li key={m.id} className="flex flex-wrap items-center gap-3 p-3">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full font-mono text-[11px] text-bg" style={{ background: `hsl(${m.hue} 70% 68%)` }}>
                      {m.initials}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold">{m.name}</span>
                      <span className="block text-[11px] text-muted">
                        {m.role}
                        {m.email ? ` · ${m.email}` : ""}
                        {links.length ? ` · Linked: ${links.map((l) => (l.channel === "telegram" ? "Telegram" : "WhatsApp")).join(", ")}` : ""}
                      </span>
                      {m.email ? (
                        <span className={`block font-mono text-[10px] ${m.joinedAt ? "text-ok" : "text-dim"}`}>
                          {m.joinedAt ? "Signed in with Google" : m.invitedAt ? `Invited ${new Date(m.invitedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}` : "Not invited yet"}
                        </span>
                      ) : null}
                    </span>
                    {canInvite && m.email && !m.joinedAt && m.id !== project.members[0].id ? (
                      <button onClick={() => resend(m.id)} className="rounded-lg border border-line-2 px-2.5 py-1.5 text-[11px] text-text hover:border-styx">
                        {m.invitedAt ? "Resend invite" : "Send invite"}
                      </button>
                    ) : null}
                    <button onClick={() => copy(code)} className="rounded-lg border border-line-2 px-2.5 py-1.5 font-mono text-[11px] text-text hover:border-styx">
                      {copied === code ? "Copied" : code}
                    </button>
                    {meta?.telegram.bot ? (
                      <a
                        href={`https://t.me/${meta.telegram.bot}?start=${code}`}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-lg bg-styx px-2.5 py-1.5 text-[11px] font-semibold text-bg hover:bg-styx-2"
                      >
                        Telegram link
                      </a>
                    ) : null}
                    {links.length ? <span className="h-2 w-2 rounded-full bg-ok" title="Linked" /> : null}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
