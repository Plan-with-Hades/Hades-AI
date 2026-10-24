import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type express from "express";
import type { PublicUser } from "@hades/core";
import { getUser, saveUser, upsertUser, type StoredUser } from "./store";

/**
 * Google sign-in with OAuth 2.0 (authorization-code flow, server side).
 * - Sign-in asks only for openid/email/profile (no Google verification needed).
 * - Google Calendar is requested later, incrementally, when the user clicks "Connect".
 * Sessions are short HS256 JWTs sent as a Bearer token (works across the web and API domains).
 */
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";
const SESSION_SECRET = process.env.SESSION_SECRET ?? randomBytes(32).toString("hex");
if (!process.env.SESSION_SECRET) console.warn("SESSION_SECRET not set: sessions will reset when the API restarts.");

export const googleEnabled = () => !!(CLIENT_ID && CLIENT_SECRET);

export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
export const WORKSPACE_SCOPES = [
  CALENDAR_SCOPE,
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
];
export const SCOPES = {
  basic: ["openid", "email", "profile"],
  calendar: ["openid", "email", "profile", CALENDAR_SCOPE],
  /** Calendar, Docs, Sheets and the Drive files Hades creates: what the agents need to plan in Google Workspace. */
  workspace: ["openid", "email", "profile", ...WORKSPACE_SCOPES],
} as const;

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sign = (data: string) => createHmac("sha256", SESSION_SECRET).update(data).digest("base64url");
const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/* ---------------- Signed blobs: OAuth state and session tokens ---------------- */

export function seal(payload: object, ttlSeconds: number): string {
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  return `${head}.${body}.${sign(`${head}.${body}`)}`;
}

export function unseal<T>(token: string | undefined): (T & { exp: number }) | null {
  if (!token) return null;
  const [head, body, sig] = token.split(".");
  if (!head || !body || !sig || !safeEq(sig, sign(`${head}.${body}`))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString()) as T & { exp: number };
    return data.exp > Date.now() / 1000 ? data : null;
  } catch {
    return null;
  }
}

export interface OAuthState {
  next: string;
  scope: keyof typeof SCOPES;
  workspaceId?: string;
  nonce: string;
}

export function googleAuthUrl(redirectUri: string, state: Omit<OAuthState, "nonce">): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES[state.scope].join(" "),
    state: seal({ ...state, nonce: randomBytes(8).toString("hex") }, 600),
    include_granted_scopes: "true",
    access_type: state.scope === "basic" ? "online" : "offline",
    prompt: state.scope === "basic" ? "select_account" : "consent",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...body }),
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok) throw Object.assign(new Error(`Google token error: ${json.error_description ?? json.error}`), { status: 401 });
  return json;
}

/** Exchanges the code, verifies the ID token with Google, and stores the user. */
export async function completeGoogleLogin(code: string, redirectUri: string): Promise<StoredUser> {
  const tokens = await tokenRequest({ code, redirect_uri: redirectUri, grant_type: "authorization_code" });
  if (!tokens.id_token) throw Object.assign(new Error("Google did not return an ID token"), { status: 401 });
  const info = (await (await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokens.id_token)}`)).json()) as Record<string, string>;
  if (info.aud !== CLIENT_ID || !info.sub || !["accounts.google.com", "https://accounts.google.com"].includes(info.iss)) {
    throw Object.assign(new Error("Could not verify your Google sign-in"), { status: 401 });
  }
  return upsertUser({
    id: info.sub,
    email: info.email,
    name: info.name ?? info.email,
    picture: info.picture,
    google: { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + tokens.expires_in * 1000, scope: tokens.scope },
  });
}

/** Returns a valid Google access token for the user, refreshing it if needed. */
export async function googleAccessToken(user: StoredUser): Promise<string> {
  const g = user.google;
  if (!g) throw Object.assign(new Error("Connect your Google account first."), { status: 401 });
  if (g.expiresAt > Date.now() + 60_000) return g.accessToken;
  if (!g.refreshToken) throw Object.assign(new Error("Google access expired. Reconnect Google Calendar."), { status: 401 });
  const t = await tokenRequest({ refresh_token: g.refreshToken, grant_type: "refresh_token" });
  user.google = { ...g, accessToken: t.access_token, expiresAt: Date.now() + t.expires_in * 1000, scope: t.scope ?? g.scope };
  saveUser(user);
  return t.access_token;
}

export const sessionFor = (user: StoredUser) => seal({ sub: user.id }, 60 * 60 * 24 * 7);

export function currentUser(req: express.Request): StoredUser | null {
  const header = req.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : undefined;
  const data = unseal<{ sub: string }>(token);
  return data ? (getUser(data.sub) ?? null) : null;
}

export function requireUser(req: express.Request): StoredUser {
  const u = currentUser(req);
  if (!u) throw Object.assign(new Error("Sign in with Google to continue."), { status: 401 });
  return u;
}

export const publicUser = (u: StoredUser): PublicUser => ({
  id: u.id,
  email: u.email,
  name: u.name,
  picture: u.picture,
  calendarConnected: !!u.google?.scope?.includes(CALENDAR_SCOPE),
  workspaceConnected: WORKSPACE_SCOPES.every((sc) => u.google?.scope?.includes(sc)),
});
