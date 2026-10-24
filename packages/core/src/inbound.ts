import { formatShort } from "./dates";
import { scheduleProject } from "./schedule";
import type { Project, Task, TaskStatus } from "./types";

export type ParsedMemberMessage =
  | { kind: "update"; taskId: string; estimateDays?: number; status?: TaskStatus; note: string }
  | { kind: "tasks" }
  | { kind: "help" }
  | { kind: "unclear"; reason: string };

const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, half: 0.5 };

/**
 * Turns a teammate's chat reply into a structured update, deterministically.
 * Examples: "need 2 more days", "E7 will take 4 days", "E5 done", "blocked on the caterer".
 * Members can only update their own tasks; that is enforced again in applyMemberUpdate.
 */
export function parseMemberMessage(project: Project, memberId: string, raw: string): ParsedMemberMessage {
  const text = raw.trim();
  const lower = text.toLowerCase();
  if (/^\/?(help|start)$/.test(lower)) return { kind: "help" };
  if (/^\/?(tasks|my tasks|status|what'?s next)\??$/.test(lower)) return { kind: "tasks" };

  const own = project.tasks.filter((t) => t.ownerId === memberId);
  const open = own.filter((t) => t.status !== "done");
  if (!own.length) return { kind: "unclear", reason: "You don't have any tasks on this project yet." };

  // Which task? An explicit id wins; otherwise the task they're working on, then their next one.
  const idMatch = text.match(/\b([A-Z]\d{1,3})\b/i);
  let task: Task | undefined = idMatch ? own.find((t) => t.id.toLowerCase() === idMatch[1].toLowerCase()) : undefined;
  if (idMatch && !task) return { kind: "unclear", reason: `${idMatch[1].toUpperCase()} isn't one of your tasks.` };
  if (!task) {
    const sched = scheduleProject(project);
    task = open.find((t) => t.status === "in_progress") ?? [...open].sort((a, b) => (sched.tasks[a.id]?.startDay ?? 0) - (sched.tasks[b.id]?.startDay ?? 0))[0];
  }
  if (!task) return { kind: "unclear", reason: "All your tasks are already done. Nice." };

  let status: TaskStatus | undefined;
  if (/\b(done|finished|completed|complete|wrapped up|shipped)\b/.test(lower) && !/\bnot (done|finished)\b/.test(lower)) status = "done";
  else if (/\b(blocked|stuck|waiting on|can'?t proceed|no response)\b/.test(lower)) status = "blocked";
  else if (/\b(started|starting|working on|on it|in progress)\b/.test(lower)) status = "in_progress";

  let estimateDays: number | undefined;
  const num = lower.match(/(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|half)\s*(more\s+|extra\s+|additional\s+)?(day|days|d)\b/);
  if (num) {
    const n = WORD_NUMBERS[num[1]] ?? Number(num[1]);
    const relative = !!num[2] || /\b(more|extra|another|additional|delay|late)\b/.test(lower);
    estimateDays = relative ? (task.estimateDays ?? 0) + n : n;
  }

  if (status === undefined && estimateDays === undefined) {
    return { kind: "unclear", reason: "I couldn't tell what changed. Try \"need 2 more days\", \"E5 done\" or \"blocked on the caterer\"." };
  }
  return { kind: "update", taskId: task.id, estimateDays, status, note: text };
}

export function memberTaskSummary(project: Project, memberId: string): string {
  const sched = scheduleProject(project);
  const own = project.tasks.filter((t) => t.ownerId === memberId);
  if (!own.length) return "You don't have any tasks yet.";
  return own
    .map((t) => {
      const st = sched.tasks[t.id];
      const when = st ? `${formatShort(st.startDate)} → ${formatShort(st.endDate)}` : "";
      const mark = t.status === "done" ? "✅" : t.status === "blocked" ? "⛔" : t.status === "in_progress" ? "🔵" : "⚪";
      return `${mark} ${t.id} ${t.title} · ${when}`;
    })
    .join("\n");
}

export const MEMBER_HELP =
  "I'm your Hades agent for this event. Reply in plain words and I'll update the plan:\n" +
  "• \"need 2 more days\" or \"E7 will take 4 days\"\n" +
  "• \"E5 done\"\n" +
  "• \"blocked on the caterer\"\n" +
  "• \"tasks\" to see your tasks";
