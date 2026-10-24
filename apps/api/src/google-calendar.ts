import { addWorkingDays, fromISO, scheduleProject, toISO, type WorkspaceState } from "@hades/core";
import { googleAccessToken } from "./auth";
import type { StoredUser } from "./store";

/**
 * Pushes the plan into the owner's Google Calendar: one all-day event per open task
 * (start → finish) and one for the event day. Re-syncing updates the same events.
 */
const CAL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

/** Google all-day events use an exclusive end date. */
const nextDay = (iso: string) => {
  const d = fromISO(iso);
  d.setDate(d.getDate() + 1);
  return toISO(d);
};

export async function syncCalendar(user: StoredUser, w: WorkspaceState): Promise<{ events: Record<string, string>; created: number; updated: number }> {
  const token = await googleAccessToken(user);
  const sched = scheduleProject(w.project);
  const existing = w.calendar?.events ?? {};
  const events: Record<string, string> = {};
  let created = 0;
  let updated = 0;

  const items = w.project.tasks
    .filter((t) => t.status !== "done")
    .map((t) => {
      const st = sched.tasks[t.id];
      const owner = w.project.members.find((m) => m.id === t.ownerId)?.name ?? "";
      // Tasks finish at the start of endDate's working day, so the last busy day is the day before.
      const lastDay = addWorkingDays(st.endDate, -1) < st.startDate ? st.startDate : addWorkingDays(st.endDate, -1);
      return {
        key: t.id,
        body: {
          summary: `${t.id} · ${t.title} (${owner})`,
          description: `${w.project.name}\n${t.description}\n\nOwner: ${owner}\nPlanned by Hades AI.`,
          start: { date: st.startDate },
          end: { date: nextDay(lastDay) },
          colorId: st.onCriticalPath ? "11" : "9",
          extendedProperties: { private: { hadesWorkspace: w.id, hadesTask: t.id } },
          transparency: "transparent",
          attendees: w.project.members.filter((m) => m.id === t.ownerId && m.email && m.email !== user.email).map((m) => ({ email: m.email })),
        },
      };
    });
  items.push({
    key: "__deadline",
    body: {
      summary: `🔥 ${w.project.name}`,
      description: `Event day, planned with Hades AI.`,
      start: { date: w.project.deadline },
      end: { date: nextDay(w.project.deadline) },
      colorId: "6",
      extendedProperties: { private: { hadesWorkspace: w.id, hadesTask: "__deadline" } },
      transparency: "opaque",
      attendees: w.project.members.filter((m) => m.email && m.email !== user.email).map((m) => ({ email: m.email })),
    },
  });

  for (const item of items) {
    const prev = existing[item.key];
    const res = await fetch(prev ? `${CAL}/${encodeURIComponent(prev)}?sendUpdates=all` : `${CAL}?sendUpdates=all`, {
      method: prev ? "PATCH" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(item.body),
    });
    if (res.status === 404 || res.status === 410) {
      // Deleted in Google Calendar: create it again.
      const again = await fetch(`${CAL}?sendUpdates=all`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(item.body) });
      if (!again.ok) throw new Error(`Calendar error ${again.status}: ${await again.text()}`);
      events[item.key] = ((await again.json()) as { id: string }).id;
      created++;
      continue;
    }
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error("Google Calendar access was refused. Reconnect Google Calendar."), { status: 401 });
    if (!res.ok) throw new Error(`Calendar error ${res.status}: ${await res.text()}`);
    events[item.key] = ((await res.json()) as { id: string }).id;
    prev ? updated++ : created++;
  }
  return { events, created, updated };
}
