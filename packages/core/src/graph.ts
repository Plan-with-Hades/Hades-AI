import type { Dependency, Project, Task } from "./types";

export interface Graph {
  successors: Map<string, string[]>;
  predecessors: Map<string, string[]>;
  ids: string[];
}

export function buildGraph(tasks: Pick<Task, "id">[], deps: Dependency[]): Graph {
  const successors = new Map<string, string[]>();
  const predecessors = new Map<string, string[]>();
  for (const t of tasks) {
    successors.set(t.id, []);
    predecessors.set(t.id, []);
  }
  for (const d of deps) {
    if (!successors.has(d.from) || !successors.has(d.to)) continue;
    successors.get(d.from)!.push(d.to);
    predecessors.get(d.to)!.push(d.from);
  }
  return { successors, predecessors, ids: tasks.map((t) => t.id) };
}

/** Every task reachable downstream of the given tasks, each listed once, excluding the start set. */
export function downstreamOf(graph: Graph, start: string[]): string[] {
  const seen = new Set<string>(start);
  const out: string[] = [];
  const queue = [...start];
  while (queue.length) {
    const id = queue.shift()!;
    for (const next of graph.successors.get(id) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      out.push(next);
      queue.push(next);
    }
  }
  return out;
}

export function upstreamOf(graph: Graph, start: string[]): string[] {
  const seen = new Set<string>(start);
  const out: string[] = [];
  const queue = [...start];
  while (queue.length) {
    const id = queue.shift()!;
    for (const prev of graph.predecessors.get(id) ?? []) {
      if (seen.has(prev)) continue;
      seen.add(prev);
      out.push(prev);
      queue.push(prev);
    }
  }
  return out;
}

/** Kahn's algorithm. Throws if the dependency graph has a cycle. */
export function topoSort(graph: Graph): string[] {
  const indegree = new Map<string, number>();
  for (const id of graph.ids) indegree.set(id, graph.predecessors.get(id)!.length);
  const queue = graph.ids.filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of graph.successors.get(id)!) {
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== graph.ids.length) {
    const stuck = graph.ids.filter((id) => !order.includes(id));
    throw new Error(`Dependency cycle detected between: ${stuck.join(", ")}`);
  }
  return order;
}

export function hasCycle(tasks: Pick<Task, "id">[], deps: Dependency[]): boolean {
  try {
    topoSort(buildGraph(tasks, deps));
    return false;
  } catch {
    return true;
  }
}

export function projectGraph(project: Project): Graph {
  return buildGraph(project.tasks, project.dependencies);
}
