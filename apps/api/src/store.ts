import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createDemoProject, TRIAL_DAYS, type ImpactReport, type WorkspaceState } from "@hades/core";

/**
 * Workspaces live in memory and are flushed to a JSON file, so a restart keeps teams' projects.
 * Swap for Postgres when we outgrow one instance.
 */
const DATA_FILE = resolve(process.env.DATA_DIR ?? "./data", "workspaces.json");

export interface StoredUser {
  id: string; // Google "sub"
  email: string;
  name: string;
  picture?: string;
  createdAt: string;
  lastLoginAt: string;
  google?: { accessToken: string; refreshToken?: string; expiresAt: number; scope: string };
}

interface Persisted {
  workspaces: Record<string, WorkspaceState>;
  users?: Record<string, StoredUser>;
}

const workspaces = new Map<string, WorkspaceState>();
const users = new Map<string, StoredUser>();
/** Analyses are kept until approved or replaced; they are not persisted. */
const reports = new Map<string, ImpactReport>();

function load() {
  try {
    if (!existsSync(DATA_FILE)) return;
    const data = JSON.parse(readFileSync(DATA_FILE, "utf8")) as Persisted;
    for (const [id, w] of Object.entries(data.workspaces ?? {})) {
      // Migrate workspaces saved before trials existed.
      if ((w.plan as string) === "free") w.plan = "trial";
      w.trialEndsAt ??= new Date(Date.now() + TRIAL_DAYS * 864e5).toISOString();
      w.ownerId ??= null;
      workspaces.set(id, w);
    }
    for (const [id, u] of Object.entries(data.users ?? {})) users.set(id, u);
    console.log(`Loaded ${workspaces.size} workspaces and ${users.size} users from ${DATA_FILE}`);
  } catch (e) {
    console.error("Could not load workspaces:", e);
  }
}
load();

let flushTimer: NodeJS.Timeout | null = null;
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      mkdirSync(dirname(DATA_FILE), { recursive: true });
      const tmp = `${DATA_FILE}.tmp`;
      writeFileSync(tmp, JSON.stringify({ workspaces: Object.fromEntries(workspaces), users: Object.fromEntries(users) } satisfies Persisted));
      renameSync(tmp, DATA_FILE);
    } catch (e) {
      console.error("Could not save workspaces:", e);
    }
  }, 300);
}

const shortId = (n = 6) => randomBytes(n).toString("base64url").replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, n);

export function createWorkspace(owner?: { id: string; name: string }): WorkspaceState {
  let id = shortId(6);
  while (workspaces.has(id)) id = shortId(6);
  const project = { ...createDemoProject(), id };
  const now = new Date().toISOString();
  const w: WorkspaceState = {
    id,
    project,
    history: [
      {
        id: shortId(8),
        at: now,
        actor: project.members[0].name,
        action: "project_created",
        summary: `Created "${project.name}" with ${project.tasks.length} tasks and ${project.members.length} people`,
        projectVersion: project.version,
      },
    ],
    messages: [],
    reassessment: null,
    links: [],
    joinCodes: Object.fromEntries(project.members.map((m) => [m.id, `${id}-${m.id}`])),
    plan: "trial",
    trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 864e5).toISOString(),
    payments: [],
    ownerId: owner?.id ?? null,
    ownerName: owner?.name,
    updatedAt: now,
  };
  workspaces.set(id, w);
  scheduleFlush();
  return w;
}

export function getWorkspace(id: string): WorkspaceState {
  const w = workspaces.get(id);
  if (!w) throw Object.assign(new Error(`Workspace ${id} not found`), { status: 404 });
  return w;
}

/** Apply a mutation, bump `updatedAt`, and persist. */
export function updateWorkspace(id: string, fn: (w: WorkspaceState) => void): WorkspaceState {
  const w = getWorkspace(id);
  fn(w);
  w.updatedAt = new Date().toISOString();
  scheduleFlush();
  return w;
}

export function resolveJoinCode(code: string): { workspace: WorkspaceState; memberId: string } | null {
  const clean = code.trim().toLowerCase();
  const [wid] = clean.split("-");
  const w = workspaces.get(wid);
  if (!w) return null;
  const memberId = Object.entries(w.joinCodes).find(([, c]) => c === clean)?.[0];
  return memberId ? { workspace: w, memberId } : null;
}

export function findLink(channel: "telegram" | "whatsapp", address: string) {
  for (const w of workspaces.values()) {
    const link = w.links.find((l) => l.channel === channel && l.address === address);
    if (link) return { workspace: w, link };
  }
  return null;
}

export function findPayment(orderId: string) {
  for (const w of workspaces.values()) {
    const p = w.payments.find((x) => x.orderId === orderId);
    if (p) return { workspace: w, payment: p };
  }
  return null;
}

export const saveReport = (r: ImpactReport) => reports.set(r.id, r);
export const getReport = (id: string) => reports.get(id);
export const newId = shortId;

/* ---------------- Users ---------------- */

export function upsertUser(u: Omit<StoredUser, "createdAt" | "lastLoginAt">): StoredUser {
  const now = new Date().toISOString();
  const prev = users.get(u.id);
  const next: StoredUser = {
    ...prev,
    ...u,
    // Keep an existing refresh token: Google only sends it on first consent.
    google: u.google ? { ...prev?.google, ...u.google, refreshToken: u.google.refreshToken ?? prev?.google?.refreshToken } : prev?.google,
    createdAt: prev?.createdAt ?? now,
    lastLoginAt: now,
  };
  users.set(u.id, next);
  scheduleFlush();
  return next;
}

export const getUser = (id: string) => users.get(id);
export function saveUser(u: StoredUser) {
  users.set(u.id, u);
  scheduleFlush();
}
export const allUsers = () => [...users.values()];
export const allWorkspaces = () => [...workspaces.values()];
export const workspacesOf = (userId: string) => [...workspaces.values()].filter((w) => w.ownerId === userId);
