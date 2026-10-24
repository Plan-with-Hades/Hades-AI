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
  email?: string;
  phone?: string;
  /** When the manager's Google account sent the invite. */
  invitedAt?: string;
  /** Set once the teammate signs in with Google using the invited email. */
  userId?: string;
  joinedAt?: string;
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
  /** Earliest date the task may start (yyyy-mm-dd), e.g. "the shoot is on 12 Dec". */
  notBefore?: string;
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
  | "remove_dependency"
  | "update_task";

export type TaskPatch = Partial<Pick<Task, "title" | "description" | "status" | "estimateDays" | "priority">>;

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
  /** Present for update_task. */
  patch?: TaskPatch;
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
  /** Second opinion from the Hades coordinator agent on AgenticOrg, filled in after the report returns. */
  review?: AgentReview;
}

/** What the AgenticOrg coordinator said about a report. It recommends; the lead still approves in Hades. */
export interface AgentReview {
  provider: "agenticorg";
  status: "pending" | "done" | "failed";
  runId: string | null;
  decisionBrief: string;
  recommendedChangeIds: string[];
  briefings: { memberId: string; text: string }[];
  questionsForLead: string[];
  escalate: boolean;
  escalationReason: string | null;
  confidence: number | null;
  /** True when AgenticOrg's HITL rule fired (low confidence or escalation). */
  hitl: boolean;
  error?: string;
  durationMs?: number;
}

export type AuditAction =
  | "project_created"
  | "change_requested"
  | "analysis_completed"
  | "change_approved"
  | "change_rejected"
  | "member_notified"
  | "member_update"
  | "member_linked"
  | "payment"
  | "agent_review"
  | "plan_edited"
  | "member_invited"
  | "member_joined"
  | "progress_check"
  | "google"
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

export type Channel = "web" | "telegram" | "whatsapp";

export interface MemberMessage {
  id: string;
  memberId: string;
  at: string;
  from: "agent" | "member";
  text: string;
  taskIds: string[];
  /** Where the message was delivered or came from. */
  channel?: Channel;
}

/** A teammate's chat identity, linked by sending their join code to the bot. */
export interface MemberLink {
  memberId: string;
  channel: Exclude<Channel, "web">;
  /** Telegram chat id or WhatsApp number (E.164). */
  address: string;
  displayName?: string;
  linkedAt: string;
}

export interface PaymentRecord {
  id: string;
  provider: "pinelabs" | "simulated" | "upi";
  /** UPI transaction reference (UTR) the payer entered, for Google Pay / UPI payments. */
  utr?: string;
  orderId: string;
  amountPaise: number;
  status: "created" | "initiated" | "pending" | "authorized" | "captured" | "failed";
  checkoutUrl: string;
  createdAt: string;
  updatedAt: string;
}

/** Everything a team's console needs, served by the API and polled for changes. */
export interface WorkspaceState {
  id: string;
  project: Project;
  history: AuditEvent[];
  messages: MemberMessage[];
  reassessment: {
    headline: string;
    feasible: boolean;
    finishDate: string;
    suggestions: { id: string; summary: string }[];
  } | null;
  links: MemberLink[];
  /** Short code per member, e.g. "fx7k-rohan", used to link a chat to a member. */
  joinCodes: Record<string, string>;
  /** Stored plan. A trial past `trialEndsAt` is treated as expired (see effectivePlan). */
  plan: "trial" | "pro";
  trialEndsAt: string;
  payments: PaymentRecord[];
  /** Google account that owns this workspace (null for a guest demo). */
  ownerId: string | null;
  ownerName?: string;
  /** Google Calendar event ids per task, once synced. */
  calendar?: { syncedAt: string; events: Record<string, string> };
  /** Pro is paid monthly; past this date the team falls back to expired. */
  proUntil?: string;
  /** Google Drive folder, tracker sheet, plan doc and any other files the agents created or read. */
  google?: GoogleLinks;
  /** Conversation with the Hades agent, newest last (capped). */
  agentThread?: AgentTurn[];
  /** Last time anyone opened or changed this event. */
  lastActiveAt?: string;
  updatedAt: string;
}

export interface GoogleFile {
  id: string;
  name: string;
  url: string;
  kind: "folder" | "sheet" | "doc";
  role?: "workspace" | "tracker" | "plan" | "linked";
  at: string;
}

export interface GoogleLinks {
  folder?: GoogleFile;
  tracker?: GoogleFile;
  planDoc?: GoogleFile;
  files: GoogleFile[];
  /** Emails the event folder is shared with. */
  sharedWith?: string[];
}

/* ---------------- The Hades agent ---------------- */

/** Every tool the agent can use. Read tools run straight away; the rest wait for the lead's approval. */
export type AgentToolName =
  | "add_member"
  | "update_member"
  | "remove_member"
  | "add_task"
  | "update_task"
  | "remove_task"
  | "add_dependency"
  | "remove_dependency"
  | "set_event"
  | "generate_plan"
  | "progress_report"
  | "analyze_change"
  | "nudge_owners"
  | "google_create_workspace"
  | "google_sync_tracker"
  | "google_pull_tracker"
  | "google_create_doc"
  | "google_read"
  | "google_append"
  | "calendar_sync";

export interface AgentAction {
  id: string;
  tool: AgentToolName;
  args: Record<string, unknown>;
  /** One line a person can approve or reject. */
  summary: string;
  status: "proposed" | "done" | "rejected" | "failed";
  result?: string;
  url?: string;
}

export interface AgentTurn {
  id: string;
  at: string;
  role: "user" | "agent";
  text: string;
  by?: string;
  actions?: AgentAction[];
  /** Which brain answered: Claude, or the built-in rules when no model is configured. */
  engine?: "claude" | "rules";
}

export type EffectivePlan = "trial" | "pro" | "expired";

export const TRIAL_DAYS = 3;
export const PRO_PRICE_INR = 199;
export const PRO_DAYS = 30;

export function effectivePlan(w: Pick<WorkspaceState, "plan" | "trialEndsAt" | "proUntil">, now = new Date()): EffectivePlan {
  if (w.plan === "pro") return !w.proUntil || new Date(w.proUntil).getTime() > now.getTime() ? "pro" : "expired";
  return new Date(w.trialEndsAt).getTime() > now.getTime() ? "trial" : "expired";
}

/** Trial and Pro both unlock Pro features; only an expired trial or lapsed month drops to Free. */
export const hasPro = (w: Pick<WorkspaceState, "plan" | "trialEndsAt" | "proUntil">, now = new Date()) => effectivePlan(w, now) !== "expired";

/** The free plan's caps. An event that grew past them during the trial stays readable but can't grow. */
export const FREE_LIMITS = { events: 4, tasks: 10, people: 3 } as const;

/** Why a change is blocked on the free plan, or null when it is allowed. */
export function freeLimitMessage(before: { tasks: unknown[]; members: unknown[] }, after: { tasks: unknown[]; members: unknown[] }): string | null {
  if (after.tasks.length > FREE_LIMITS.tasks && after.tasks.length > before.tasks.length)
    return `The free plan holds up to ${FREE_LIMITS.tasks} tasks per event (this would make ${after.tasks.length}).`;
  if (after.members.length > FREE_LIMITS.people && after.members.length > before.members.length)
    return `The free plan holds up to ${FREE_LIMITS.people} people per event, including you.`;
  return null;
}

export const FREE_FEATURES = [
  `Up to ${FREE_LIMITS.events} events, each with ${FREE_LIMITS.tasks} tasks and ${FREE_LIMITS.people} people`,
  "Plan from a sentence, add people and tasks within those limits",
  "Mark tasks done and see dates re-plan",
  "Progress reports and teammate sign-in",
];

export const PRO_FEATURES = [
  "Unlimited events, tasks and people",
  "Change ripple analysis and approvals",
  "Google Workspace: Drive, tracker Sheet, plan Doc, Calendar",
  "Invites and updates emailed from your Gmail",
  "Telegram and WhatsApp member agents, progress nudges",
  "Voice summaries",
];

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  picture?: string;
  calendarConnected: boolean;
  /** Docs, Sheets and Drive access granted (the agent can create and edit files). */
  workspaceConnected: boolean;
}
