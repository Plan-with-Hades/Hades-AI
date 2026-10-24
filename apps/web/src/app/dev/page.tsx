"use client";

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "@/lib/api";

interface Stats {
  generatedAt: string;
  active: { usersNow: number; users24h: number; users7d: number; events24h: number };
  totals: Record<string, number>;
  users: { email: string; name: string; signedUpAt: string; lastSeenAt: string; google: boolean }[];
  payments: { event: string; provider: string; status: string; amount: number; at: string }[];
}

const KEY = "hades:admin-key";
const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

/** Developer console: who is using Hades right now. Protected by the API's ADMIN_KEY. */
export default function DevConsole() {
  const [key, setKey] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (k: string) => {
    if (!k) return;
    try {
      const res = await fetch(`${API_URL}/api/admin/stats`, { headers: { "x-admin-key": k } });
      if (!res.ok) throw new Error(res.status === 404 ? "Wrong admin key" : `Error ${res.status}`);
      setStats((await res.json()) as Stats);
      setError(null);
      try {
        localStorage.setItem(KEY, k);
      } catch {}
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    let k = "";
    try {
      k = localStorage.getItem(KEY) ?? "";
    } catch {}
    setKey(k);
    load(k);
  }, [load]);

  useEffect(() => {
    if (!stats) return;
    const t = window.setInterval(() => load(key), 15000);
    return () => window.clearInterval(t);
  }, [stats, key, load]);

  const card = (label: string, value: number | string) => (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="label">{label}</div>
      <div className="mt-1 font-mono text-2xl">{value}</div>
    </div>
  );

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="display text-xl font-bold">Hades · developer console</h1>
      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          load(key);
        }}
      >
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="ADMIN_KEY" className="flex-1 rounded-lg border border-line-2 bg-surface px-3 py-2 text-sm outline-none focus:border-styx" />
        <button className="rounded-lg bg-text px-4 py-2 text-sm font-semibold text-bg">Load</button>
      </form>
      {error ? <p className="mt-3 text-sm text-ember">{error}</p> : null}
      {stats ? (
        <>
          <h2 className="label mt-8">Active users</h2>
          <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {card("Now (15 min)", stats.active.usersNow)}
            {card("Last 24h", stats.active.users24h)}
            {card("Last 7 days", stats.active.users7d)}
            {card("Active events 24h", stats.active.events24h)}
          </div>
          <h2 className="label mt-8">Totals</h2>
          <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {card("Signed-up users", stats.totals.users)}
            {card("Events", stats.totals.events)}
            {card("Pro teams", stats.totals.pro)}
            {card("Revenue", `₹${stats.totals.revenueInr}`)}
            {card("Agent commands", stats.totals.agentCommands)}
            {card("Google actions", stats.totals.googleActions)}
            {card("Change analyses", stats.totals.analyses)}
            {card("Chat links", stats.totals.chatLinks)}
          </div>
          <h2 className="label mt-8">Users ({stats.users.length})</h2>
          <div className="mt-2 overflow-x-auto rounded-xl border border-line">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted">
                <tr>
                  <th className="p-2.5">Name</th>
                  <th className="p-2.5">Email</th>
                  <th className="p-2.5">Signed up</th>
                  <th className="p-2.5">Last seen</th>
                  <th className="p-2.5">Google</th>
                </tr>
              </thead>
              <tbody>
                {stats.users.map((u) => (
                  <tr key={u.email} className="border-t border-line">
                    <td className="p-2.5">{u.name}</td>
                    <td className="p-2.5 text-muted">{u.email}</td>
                    <td className="p-2.5 font-mono text-xs">{new Date(u.signedUpAt).toLocaleString("en-IN")}</td>
                    <td className="p-2.5 font-mono text-xs">{ago(u.lastSeenAt)}</td>
                    <td className="p-2.5">{u.google ? "✓" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {stats.payments.length ? (
            <>
              <h2 className="label mt-8">Payments</h2>
              <ul className="mt-2 space-y-1 font-mono text-xs text-muted">
                {stats.payments.map((p, i) => (
                  <li key={i}>
                    {new Date(p.at).toLocaleString("en-IN")} · {p.event} · {p.provider} · {p.status} · ₹{p.amount}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <p className="mt-6 font-mono text-[10px] text-dim">Updated {ago(stats.generatedAt)} · refreshes every 15s</p>
        </>
      ) : null}
    </main>
  );
}
