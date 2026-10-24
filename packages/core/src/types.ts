export type TaskStatus = "done" | "in_progress" | "not_started" | "blocked";
export type Priority = "low" | "medium" | "high" | "critical";

/** Where a finding comes from. Graph facts are recorded; inferences are suggestions that need review. */
export type Basis = "graph" | "ai_inference" | "member_report" | "schedule";

export interface Member {
  id: string;
  name: string;
  role: string;
  /** Short label shown in avatars, e.g. "PR". */
  initials: string;
  /** Hue used for the member's accent (0-360). */
  hue: number;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  ownerId: string;
  status: TaskStatus;
  priority: Priority;
  /** Estimated effort in working days. Null means unknown; the scheduler will ask for it. */
  estimateDays: number | null;
  acceptanceCriteria: string[];
  tags: string[];
  version: number;
}

/** `from` must finish before `to` can start. */
export interface Dependency {
  from: string;
  to: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  /** ISO date (yyyy-mm-dd) the plan started. */
  startDate: string;
  /** ISO date (yyyy-mm-dd) the project must ship by. */
  deadline: string;
  version: number;
  members: Member[];
  tasks: Task[];
  dependencies: Dependency[];
}

export interface ScheduledTask {
  taskId: string;
  /** Working-day offsets from the project start. */
  startDay: number;
  endDay: number;
  startDate: string;
  endDate: string;
  slackDays: number;
  onCriticalPath: boolean;
}

export interface Schedule {
  tasks: Record<string, ScheduledTask>;
  finishDay: number;
  finishDate: string;
  deadlineDay: number;
  /** Positive = days to spare, negative = days late. */
  bufferDays: number;
  feasible: boolean;
  missingEstimates: string[];
  criticalPath: string[];
}

export type AgentId = "orchestrator" | "scope" | "conflict" | "timeline" | "member";

export interface Finding {
  id: string;
  agent: AgentId;
  title: string;
  detail: string;
  basis: Basis;
  taskIds: string[];
  severity: "info" | "warning" | "critical";
}

export type ProposedChangeType =
  | "add_task"
  | "update_estimate"
  | "append_criteria"
  | "review_task"
  | "defer_task"
  | "add_dependency"
  | "remove_dependency";

export interface ProposedChange {
  id: string;
  type: ProposedChangeType;
  agent: AgentId;
  summary: string;
  reason: string;
  basis: Basis;
  taskId?: string;
  /** Present for add_task. */
  newTask?: Omit<Task, "version">;
  /** Present for add_task / add_dependency. */
  dependencies?: Dependency[];
  estimateDays?: number;
  criteria?: string[];
  /** Default decision suggested to the manager. */
  recommended: boolean;
}

export interface AgentRun {
  agent: AgentId;
  label: string;
  question: string;
  status: "done" | "skipped" | "failed";
  summary: string;
  findings: Finding[];
  durationMs: number;
}

export interface FeasibilityReport {
  before: Schedule;
  after: Schedule;
  /** Schedule if every recommended change is applied. */
  withRecommended: Schedule;
  verdict: "fits" | "tight" | "slips";
  headline: string;
}

export interface ImpactReport {
  id: string;
  projectId: string;
  projectVersion: number;
  request: string;
  interpretation: string;
  directTaskIds: string[];
  downstreamTaskIds: string[];
  inferredTaskIds: string[];
  affectedMemberIds: string[];
  agents: AgentRun[];
  changes: ProposedChange[];
  feasibility: FeasibilityReport;
  openQuestions: string[];
  engine: "deterministic" | "llm";
  createdAt: string;
}

export type AuditAction =
  | "project_created"
  | "change_requested"
  | "analysis_completed"
  | "change_approved"
  | "change_rejected"
  | "member_notified"
  | "member_update"
  | "reassessed";

export interface AuditEvent {
  id: string;
  at: string;
  actor: string;
  action: AuditAction;
  summary: string;
  projectVersion: number;
  meta?: Record<string, unknown>;
}

export interface MemberMessage {
  id: string;
  memberId: string;
  at: string;
  from: "agent" | "member";
  text: string;
  taskIds: string[];
}
