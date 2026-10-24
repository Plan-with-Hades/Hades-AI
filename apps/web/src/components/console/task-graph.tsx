"use client";

import { Background, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo } from "react";
import { buildGraph, formatShort, topoSort, type Dependency, type Member, type Schedule, type Task } from "@hades/core";

export type Highlight = "direct" | "downstream" | "inferred" | "new" | "none";

interface Props {
  tasks: Task[];
  dependencies: Dependency[];
  members: Member[];
  schedule: Schedule;
  highlight: Record<string, Highlight>;
  /** Edges proposed by the analysis but not yet approved. */
  proposedEdges?: Dependency[];
  removedEdges?: Dependency[];
  selected?: string | null;
  onSelect?: (id: string) => void;
}

type TaskNodeData = {
  task: Task;
  owner?: Member;
  hl: Highlight;
  dates: string;
  critical: boolean;
  selected: boolean;
};

const HL_STYLE: Record<Highlight, { ring: string; tag?: string; tagClass?: string }> = {
  direct: { ring: "border-styx shadow-[0_0_32px_-6px_var(--styx)]", tag: "Direct", tagClass: "bg-[var(--styx-soft)] text-styx-2" },
  downstream: { ring: "border-ember/70 shadow-[0_0_28px_-8px_var(--ember)]", tag: "Downstream", tagClass: "bg-[var(--ember-soft)] text-ember" },
  inferred: { ring: "border-warn/60 border-dashed", tag: "Review", tagClass: "bg-[var(--warn-soft)] text-warn" },
  new: { ring: "border-ok/70 border-dashed shadow-[0_0_28px_-8px_var(--ok)]", tag: "Proposed", tagClass: "bg-[var(--ok-soft)] text-ok" },
  none: { ring: "border-line-2" },
};

const STATUS_DOT: Record<Task["status"], string> = {
  done: "bg-ok",
  in_progress: "bg-styx animate-pulse",
  not_started: "bg-dim",
  blocked: "bg-ember",
};

function TaskNode({ data }: NodeProps<Node<TaskNodeData>>) {
  const { task, owner, hl, dates, critical, selected } = data;
  const s = HL_STYLE[hl];
  return (
    <div
      className={`w-[208px] rounded-xl border bg-surface/95 px-3 py-2.5 text-left transition ${s.ring} ${
        selected ? "outline outline-2 outline-offset-2 outline-styx-2" : ""
      } ${task.status === "done" && hl === "none" ? "opacity-60" : ""}`}
    >
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-line-2" />
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] text-muted">
          {task.id}
          {critical && task.status !== "done" ? <span className="ml-1.5 text-ember">● critical</span> : null}
        </span>
        {s.tag ? <span className={`rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${s.tagClass}`}>{s.tag}</span> : null}
      </div>
      <p className="mt-1 line-clamp-2 text-[12.5px] font-semibold leading-snug text-text">{task.title}</p>
      <div className="mt-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[11px] text-muted">
          <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[task.status]}`} />
          {owner?.name ?? "Unassigned"}
        </span>
        <span className="font-mono text-[10px] text-dim">{dates}</span>
      </div>
      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-0 !bg-line-2" />
    </div>
  );
}

const nodeTypes = { task: TaskNode };

export function TaskGraph({ tasks, dependencies, members, schedule, highlight, proposedEdges = [], removedEdges = [], selected, onSelect }: Props) {
  const { nodes, edges } = useMemo(() => {
    const allDeps = [...dependencies, ...proposedEdges];
    const graph = buildGraph(tasks, allDeps);
    let order: string[];
    try {
      order = topoSort(graph);
    } catch {
      order = tasks.map((t) => t.id);
    }
    const depth = new Map<string, number>();
    for (const id of order) {
      const preds = graph.predecessors.get(id) ?? [];
      depth.set(id, preds.length ? Math.max(...preds.map((p) => (depth.get(p) ?? 0) + 1)) : 0);
    }
    const columns = new Map<number, string[]>();
    for (const id of order) {
      const d = depth.get(id)!;
      columns.set(d, [...(columns.get(d) ?? []), id]);
    }
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const COL = 260;
    const ROW = 112;
    const nodes: Node<TaskNodeData>[] = [];
    for (const [d, ids] of columns) {
      ids.forEach((id, i) => {
        const t = byId.get(id)!;
        const st = schedule.tasks[id];
        nodes.push({
          id,
          type: "task",
          position: { x: d * COL, y: (i - (ids.length - 1) / 2) * ROW },
          data: {
            task: t,
            owner: members.find((m) => m.id === t.ownerId),
            hl: highlight[id] ?? "none",
            dates: st ? `${formatShort(st.startDate)} → ${formatShort(st.endDate)}` : "",
            critical: !!st?.onCriticalPath,
            selected: selected === id,
          },
        });
      });
    }
    const isRemoved = (e: Dependency) => removedEdges.some((r) => r.from === e.from && r.to === e.to);
    const isProposed = (e: Dependency) => proposedEdges.some((r) => r.from === e.from && r.to === e.to);
    const lit = (id: string) => (highlight[id] ?? "none") !== "none";
    const edges: Edge[] = allDeps.map((e) => {
      const hot = lit(e.from) && lit(e.to);
      const color = isRemoved(e) ? "var(--dim)" : isProposed(e) ? "var(--ok)" : hot ? "var(--styx)" : "rgba(232,236,245,0.18)";
      return {
        id: `${e.from}-${e.to}`,
        source: e.from,
        target: e.to,
        animated: hot || isProposed(e),
        style: { stroke: color, strokeDasharray: isRemoved(e) || isProposed(e) ? "5 5" : undefined, opacity: isRemoved(e) ? 0.5 : 1 },
      };
    });
    return { nodes, edges };
  }, [tasks, dependencies, members, schedule, highlight, proposedEdges, removedEdges, selected]);

  return (
    <ReactFlow
      key={nodes.map((n) => n.id).join(",")}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.18 }}
      nodesDraggable={false}
      nodesConnectable={false}
      minZoom={0.3}
      maxZoom={1.6}
      onNodeClick={(_, n) => onSelect?.(n.id)}
      proOptions={{ hideAttribution: true }}
      colorMode="dark"
      style={{ background: "transparent" }}
    >
      <Background color="rgba(232,236,245,0.06)" gap={24} size={1} />
    </ReactFlow>
  );
}
