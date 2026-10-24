import type { AgentTurn, EffectivePlan, ImpactReport, PublicUser, WorkspaceState } from "@hades/core";

/** Base URL of the Hades API. Empty means the console runs its built-in demo engine. */
const RAW_API = (process.env.NEXT_PUBLIC_API_URL ?? "").trim();
export const API_URL = (RAW_API && !/^https?:\/\//.test(RAW_API) ? `https://${RAW_API}` : RAW_API).replace(/\/$/, "");

export type ServerWorkspace = WorkspaceState & {
  effectivePlan: EffectivePlan;
  role?: "manager" | "member" | "guest";
  /** Present right after an approval or update: who was emailed, and which dates moved. */
  emailed?: { sent: string[]; skipped?: string };
  shifts?: { taskId: string; title: string; ownerId: string; from: string | null; to: string }[];
};
export interface InviteResult {
  memberId: string;
  email: string;
  emailed: boolean;
  shared: boolean;
  link: string;
  note?: string;
}

export interface Meta {
  payments: { mode: "live" | "test" | "off"; pricePaise: number; trialDays: number };
  google: { enabled: boolean };
  telegram: { enabled: boolean; bot: string | null };
  whatsapp: { enabled: boolean; number: string | null };
  agenticorg?: { enabled: boolean };
  voice?: { enabled: boolean };
  upi?: { vpa: string; name: string } | null;
}

export interface Me {
  user: PublicUser;
  workspaces: { id: string; name: string; role: "manager" | "member"; plan: EffectivePlan; trialEndsAt: string; updatedAt: string }[];
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: Record<string, unknown>) {
    super(message);
  }
}

const TOKEN_KEY = "hades:token";
const WS_KEY = "hades:workspace";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

export const getToken = () => read(TOKEN_KEY);
export const setToken = (t: string | null) => write(TOKEN_KEY, t);
export const getRememberedWorkspace = () => read(WS_KEY);
export const rememberWorkspace = (id: string) => write(WS_KEY, id);
/** Signs out on this browser: forget the session and the last event. */
export function signOut() {
  write(TOKEN_KEY, null);
  write(WS_KEY, null);
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    if (res.status === 401 && token && path === "/api/me") setToken(null);
    throw new ApiError(res.status, String(body.error ?? `Request failed (${res.status})`), body);
  }
  return body as T;
}

const post = <T,>(path: string, body?: unknown) => call<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  meta: () => call<Meta>("/api/meta"),
  me: () => call<Me>("/api/me"),
  createWorkspace: (blank = false) => post<ServerWorkspace>("/api/workspaces", blank ? { blank: true } : undefined),
  agent: (id: string, message: string) =>
    post<{ turn: AgentTurn; analyze?: string; connectGoogle?: boolean; workspace: ServerWorkspace }>(`/api/workspaces/${id}/agent`, { message }),
  workspace: (id: string, since?: string) =>
    call<ServerWorkspace | { changed: false; updatedAt: string }>(`/api/workspaces/${id}${since ? `?since=${encodeURIComponent(since)}` : ""}`),
  claim: (id: string) => post<ServerWorkspace>(`/api/workspaces/${id}/claim`),
  analyze: (id: string, request: string) => post<ImpactReport>(`/api/workspaces/${id}/analyze`, { request }),
  report: (id: string, reportId: string) => call<ImpactReport>(`/api/workspaces/${id}/reports/${reportId}`),
  voiceUrl: (id: string, reportId: string) => `${API_URL}/api/workspaces/${id}/reports/${reportId}/voice`,
  approve: (id: string, reportId: string, changeIds: string[]) => post<ServerWorkspace>(`/api/workspaces/${id}/approve`, { reportId, changeIds }),
  reject: (id: string, reportId: string) => post<ServerWorkspace>(`/api/workspaces/${id}/reject`, { reportId }),
  memberUpdate: (id: string, body: { memberId: string; taskId: string; estimateDays?: number; note: string }) =>
    post<ServerWorkspace>(`/api/workspaces/${id}/member-updates`, body),
  addMember: (id: string, body: { name: string; role?: string; email: string }) =>
    post<{ invite: InviteResult; workspace: ServerWorkspace }>(`/api/workspaces/${id}/members`, body),
  invite: (id: string, memberId: string) => post<{ invite: InviteResult; workspace: ServerWorkspace }>(`/api/workspaces/${id}/members/${memberId}/invite`),
  reset: (id: string) => post<ServerWorkspace>(`/api/workspaces/${id}/reset`),
  payUpi: (id: string, utr: string) => post<ServerWorkspace>(`/api/workspaces/${id}/upi`, { utr }),
  checkout: (id: string) => post<{ checkoutUrl: string; mode: string }>(`/api/workspaces/${id}/checkout`),
  syncCalendar: (id: string) => post<{ created: number; updated: number; workspace: ServerWorkspace }>(`/api/workspaces/${id}/calendar/sync`),
  signInUrl: (opts: { workspaceId?: string; calendar?: boolean; workspace?: boolean }) => {
    const q = new URLSearchParams({ next: "/app" });
    if (opts.workspaceId) q.set("w", opts.workspaceId);
    if (opts.calendar) q.set("scope", "calendar");
    if (opts.workspace) q.set("scope", "workspace");
    return `${API_URL}/api/auth/google/start?${q}`;
  },
};
