"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentTurn, GoogleLinks } from "@hades/core";

const QUICK = [
  "Plan a hackathon for 300 people on 20 Dec",
  "Add Meera as marketing lead",
  "Add an event Award ceremony (1 day)",
  "How are we doing?",
  "Create a Google workspace",
  "Pull updates from the tracker",
  "Nudge owners of late tasks",
];

/** Linkifies URLs in agent replies. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s)]+)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noreferrer" className="break-all text-styx-2 underline decoration-styx/40 underline-offset-2 hover:decoration-styx-2">
            {p.includes("drive.google.com") ? "Drive folder ↗" : p.includes("/spreadsheets/") ? "Google Sheet ↗" : p.includes("/document/") ? "Google Doc ↗" : p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

export function AgentPanel({
  thread,
  busy,
  google,
  connectUrl,
  onSend,
}: {
  thread: AgentTurn[];
  busy: boolean;
  google?: GoogleLinks;
  /** Shown when the agent needs Google access. */
  connectUrl: string | null;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [thread.length, busy]);

  const send = (t: string) => {
    if (!t.trim() || busy) return;
    onSend(t.trim());
    setText("");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {google?.folder ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5 text-[11px] sm:px-5">
          <span className="label !text-[10px]">Google workspace</span>
          {[google.folder, google.tracker, google.planDoc].filter(Boolean).map((f) => (
            <a key={f!.id} href={f!.url} target="_blank" rel="noreferrer" className="rounded-full border border-line px-2 py-0.5 text-muted transition hover:border-styx hover:text-text">
              {f!.kind === "folder" ? "Drive" : f!.kind === "sheet" ? "Tracker" : "Plan doc"} ↗
            </a>
          ))}
        </div>
      ) : null}

      <div className="flex-1 space-y-3 overflow-y-auto p-4 sm:p-5">
        {thread.length === 0 ? (
          <div className="rounded-xl border border-line bg-surface p-4">
            <p className="display text-sm font-bold">Hades agent</p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
              Tell me what you need in plain words. I plan events, add people and tasks, track progress, chase owners, and work in your Google Drive, Docs, Sheets and
              Calendar. Describe a change and I&apos;ll trace its ripple.
            </p>
          </div>
        ) : null}
        {thread.map((t) => (
          <div key={t.id} className={t.role === "user" ? "flex justify-end" : ""}>
            <div
              className={
                t.role === "user"
                  ? "max-w-[85%] rounded-2xl rounded-br-sm bg-styx/15 px-3.5 py-2.5 text-[13px] leading-snug text-text"
                  : "max-w-[95%] whitespace-pre-wrap rounded-2xl rounded-bl-sm border border-line bg-surface px-3.5 py-2.5 text-[13px] leading-relaxed text-text"
              }
            >
              <Rich text={t.text} />
              {t.role === "agent" && t.actions?.some((a) => a.status === "failed") ? (
                <span className="mt-1.5 block font-mono text-[10px] text-ember">action failed</span>
              ) : null}
            </div>
          </div>
        ))}
        {busy ? <p className="animate-pulse font-mono text-[11px] text-styx-2">Hades is working…</p> : null}
        {connectUrl ? (
          <a href={connectUrl} className="flex items-center justify-center gap-2 rounded-xl border border-styx/50 bg-styx/10 px-4 py-2.5 text-[13px] font-semibold text-styx-2 transition hover:bg-styx/20">
            Connect Google Workspace
          </a>
        ) : null}
        <div ref={end} />
      </div>

      <div className="border-t border-line p-4 sm:p-5">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {QUICK.map((q) => (
            <button key={q} onClick={() => send(q)} disabled={busy} className="rounded-full border border-line px-2.5 py-1 text-[11px] text-muted transition hover:border-line-2 hover:text-text disabled:opacity-40">
              {q}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            placeholder="Ask Hades… e.g. Add task Print badges for Kavya (2 days) after T7"
            className="flex-1 resize-none rounded-xl border border-line-2 bg-surface px-3.5 py-2.5 text-sm leading-relaxed text-text outline-none transition placeholder:text-dim focus:border-styx"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(text);
              }
            }}
          />
          <button onClick={() => send(text)} disabled={busy || !text.trim()} className="rounded-xl bg-styx px-4 text-sm font-semibold text-bg transition hover:bg-styx-2 disabled:opacity-40">
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
