"use client";

import { useEffect, useState } from "react";
import { API_URL } from "@/lib/api";

interface VendorView {
  event: string;
  eventDate: string;
  task: { id: string; title: string; start: string | null; finish: string | null };
  vendor: { name: string; status: "pending" | "confirmed" | "delayed"; delayDays?: number; note?: string };
  manager: string;
}

const fmt = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—");

/** The page a vendor opens from the organiser's link: confirm, or report a delay. No sign-up. */
export function VendorClient({ token }: { token: string }) {
  const [v, setV] = useState<VendorView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [days, setDays] = useState("2");
  const [note, setNote] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`${API_URL}/api/vendor/${token}`)
      .then(async (r) => (r.ok ? setV((await r.json()) as VendorView) : setErr(((await r.json()) as { error?: string }).error ?? "This link is not valid.")))
      .catch(() => setErr("Could not reach Hades. Try again in a minute."));
  }, [token]);

  const send = async (status: "confirmed" | "delayed") => {
    setBusy(true);
    try {
      const r = await fetch(`${API_URL}/api/vendor/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, ...(status === "delayed" ? { delayDays: Number(days) || 1 } : {}), ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      const out = (await r.json()) as { headline?: string; view?: VendorView; error?: string };
      if (!r.ok) throw new Error(out.error ?? "Something went wrong");
      setDone(status === "confirmed" ? "Thanks! The organiser can see you’ve confirmed." : "Thanks. The organiser has been told and the plan is re-planning around the new date.");
      if (out.view) setV(out.view);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="grid min-h-screen place-items-center bg-bg px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-line-2 bg-surface p-6">
        <p className="label">Hades AI · vendor update</p>
        {err ? <p className="mt-4 text-sm text-ember">{err}</p> : null}
        {!v && !err ? <p className="mt-4 text-sm text-muted">Loading…</p> : null}
        {v ? (
          <>
            <h1 className="display mt-3 text-2xl font-bold leading-tight">{v.task.title}</h1>
            <p className="mt-2 text-sm text-muted">
              For <b className="text-text">{v.event}</b> · organised by {v.manager}
            </p>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center text-[12px]">
              <div className="rounded-lg border border-line bg-bg-2 p-2">
                <div className="text-dim">Starts</div>
                <div className="font-mono text-text">{fmt(v.task.start)}</div>
              </div>
              <div className="rounded-lg border border-line bg-bg-2 p-2">
                <div className="text-dim">Due</div>
                <div className="font-mono text-text">{fmt(v.task.finish)}</div>
              </div>
              <div className="rounded-lg border border-line bg-bg-2 p-2">
                <div className="text-dim">Event day</div>
                <div className="font-mono text-text">{fmt(v.eventDate)}</div>
              </div>
            </div>
            <p className="mt-4 text-sm">
              Hi <b>{v.vendor.name}</b>, are you on track?
              {v.vendor.status !== "pending" ? (
                <span className="ml-1 text-muted">
                  (Last answer: {v.vendor.status === "delayed" ? `delayed ${v.vendor.delayDays ?? ""} day(s)` : "confirmed"})
                </span>
              ) : null}
            </p>
            {done ? (
              <p className="mt-4 rounded-lg border border-ok/40 bg-[var(--ok-soft)] p-3 text-sm text-text">{done}</p>
            ) : (
              <>
                <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Optional note for the organiser" className="mt-3 w-full resize-none rounded-lg border border-line-2 bg-bg-2 px-3 py-2 text-sm outline-none focus:border-styx" />
                <button disabled={busy} onClick={() => send("confirmed")} className="mt-3 w-full rounded-xl bg-ok px-4 py-3 text-sm font-semibold text-bg disabled:opacity-50">
                  ✓ Confirmed, on track
                </button>
                <div className="mt-2 flex gap-2">
                  <input value={days} onChange={(e) => setDays(e.target.value.replace(/[^0-9]/g, ""))} className="w-20 rounded-xl border border-line-2 bg-bg-2 px-3 py-3 text-center text-sm outline-none focus:border-styx" aria-label="Days of delay" />
                  <button disabled={busy} onClick={() => send("delayed")} className="flex-1 rounded-xl border border-ember/60 px-4 py-3 text-sm font-semibold text-ember disabled:opacity-50">
                    Delayed by {days || 1} day{days === "1" ? "" : "s"}
                  </button>
                </div>
              </>
            )}
            <p className="mt-5 text-[11px] text-dim">No account needed. Your answer goes straight to the organiser’s plan.</p>
          </>
        ) : null}
      </div>
    </main>
  );
}
