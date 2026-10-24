import Link from "next/link";
import { RippleField } from "@/components/ripple-field";
import { SiteNav } from "@/components/site-nav";
import { Logo } from "@/components/logo";

const STEPS = [
  {
    t: "Say what changed",
    d: "“Our title sponsor pulled out, but the fest date can't move.” Type it, forward it from an email, or send it on WhatsApp.",
  },
  {
    t: "Watch the ripple",
    d: "Hades walks your event plan and lights up every task, owner and deadline the change touches: posters, vendors, passes, run-of-show. Graph facts are marked apart from AI guesses.",
  },
  {
    t: "Agents argue it out",
    d: "Scope, Conflict and Timeline agents each answer one question, then the Orchestrator reconciles them into one plan with the trade-offs in plain sight.",
  },
  {
    t: "You approve. They chase.",
    d: "Nothing moves until you say yes. Then member agents brief each affected person, collect new estimates, and re-plan when reality pushes back.",
  },
];

const AGENTS = [
  { name: "Orchestrator", q: "What should the manager decide?", tone: "text-text", note: "Runs on AgenticOrg" },
  { name: "Scope agent", q: "What work needs to change?", tone: "text-styx-2", note: "Maps the request to tasks" },
  { name: "Conflict agent", q: "What breaks, and who is affected?", tone: "text-ember", note: "Walks the dependency graph" },
  { name: "Timeline agent", q: "Can we still make the date?", tone: "text-ok", note: "Deterministic scheduler" },
  { name: "Member agents", q: "What does this mean for you?", tone: "text-warn", note: "WhatsApp, voice, web" },
];

const CHANNELS = [
  { name: "Web console", d: "The graph, the impact report and the approve button.", tag: "Live" },
  { name: "WhatsApp & Telegram", d: "Teammates report blockers and get briefed where they already are.", tag: "Live" },
  { name: "Voice check-ins", d: "Hades calls a teammate to confirm an estimate, with Vobiz telephony and an ElevenLabs voice.", tag: "Building" },
  { name: "Google Pay checkout", d: "Start with a 3-day free trial, then upgrade a team to Pro by paying ₹199 with Google Pay or any UPI app.", tag: "Live" },
];

export default function Home() {
  return (
    <main className="relative overflow-x-clip">
      <SiteNav />

      {/* ---------------- Hero ---------------- */}
      <section className="grain relative isolate flex min-h-[92svh] flex-col justify-end px-5 pb-10 pt-32 sm:px-8">
        <RippleField className="absolute inset-0 -z-10" />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_50%_35%,transparent_0%,var(--bg)_72%)]"
        />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-48 bg-gradient-to-b from-transparent to-bg" />

        <div className="mx-auto w-full max-w-6xl">
          <div className="mb-10 flex flex-wrap items-center justify-between gap-3">
            <span className="label flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-ember shadow-[0_0_12px_var(--ember)]" />
              Hades AI · God of Event Management
            </span>
            <span className="label hidden sm:inline">AI Builders Day ’26 · Team A68</span>
          </div>

          <h1 className="display max-w-4xl text-[clamp(40px,7.2vw,96px)] font-extrabold leading-[0.95]">
            Every change
            <br />
            has a ripple.
            <br />
            <span className="bg-gradient-to-r from-styx-2 via-styx to-ember bg-clip-text text-transparent">Hades sees it first.</span>
          </h1>

          <div className="mt-10 grid items-end gap-8 md:grid-cols-[1.2fr_1fr]">
            <p className="max-w-xl text-[17px] leading-relaxed text-muted">
              A sponsor pulls out. The venue moves. The chief guest wants a new slot. Hades traces every task, owner and
              deadline the change touches, lets specialist agents plan the response, and waits for your{" "}
              <span className="text-text">yes</span> before anything moves.
            </p>
            <div className="flex flex-wrap gap-3 md:justify-end">
              <Link
                href="/app"
                className="group flex items-center gap-3 rounded-full bg-text px-6 py-3.5 text-sm font-semibold text-bg transition hover:bg-styx-2"
              >
                Try the live demo
                <span aria-hidden className="transition group-hover:translate-x-1">→</span>
              </Link>
              <a
                href="#how"
                className="glass flex items-center gap-3 rounded-full px-6 py-3.5 text-sm font-semibold transition hover:border-line-2"
              >
                How it works
                <span aria-hidden>↓</span>
              </a>
            </div>
          </div>

          <div className="mt-14 flex items-center justify-between border-t border-line pt-4">
            <span className="label">Scope · Conflict · Timeline · Members</span>
            <span className="label">Move to disturb the graph ↗</span>
          </div>
        </div>
      </section>

      {/* ---------------- Problem ---------------- */}
      <section className="px-5 py-28 sm:px-8">
        <div className="mx-auto grid max-w-6xl gap-14 md:grid-cols-[1fr_1.1fr]">
          <div>
            <span className="label">The problem</span>
            <h2 className="display mt-5 text-[clamp(28px,3.6vw,46px)] font-bold leading-[1.05]">
              The event lead is the human integration layer.
            </h2>
          </div>
          <div className="space-y-6 text-[17px] leading-relaxed text-muted">
            <p>
              Approvals, sponsors, posters, vendors, passes, volunteers: every part of an event leans on another. When one
              thing changes, someone has to work out what it breaks, who to tell, and whether the date still holds.
              Spreadsheets and group chats record that something changed. They don&apos;t tell you what it{" "}
              <span className="text-text">does</span>.
            </p>
            <dl className="grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-3">
              {[
                ["Ripple", "A lost sponsor hits posters, vendors and passes."],
                ["Chasing", "Updates live in WhatsApp groups, not the plan."],
                ["Too late", "Clashes surface the night before the event."],
              ].map(([k, v]) => (
                <div key={k} className="bg-bg-2 p-5">
                  <dt className="display text-sm font-bold text-text">{k}</dt>
                  <dd className="mt-2 text-sm">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>

      {/* ---------------- How it works ---------------- */}
      <section id="how" className="scroll-mt-24 px-5 py-24 sm:px-8">
        <div className="mx-auto max-w-6xl">
          <span className="label">How it works</span>
          <h2 className="display mt-5 max-w-3xl text-[clamp(28px,3.6vw,46px)] font-bold leading-[1.05]">
            From “the sponsor just called…” to an approved plan in under a minute.
          </h2>
          <ol className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-line bg-line md:grid-cols-4">
            {STEPS.map((s, i) => (
              <li key={s.t} className="flex flex-col gap-4 bg-bg-2 p-6">
                <span className="font-mono text-xs text-styx">0{i + 1}</span>
                <h3 className="display text-lg font-bold leading-tight">{s.t}</h3>
                <p className="text-sm leading-relaxed text-muted">{s.d}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ---------------- Agents ---------------- */}
      <section id="agents" className="scroll-mt-24 px-5 py-24 sm:px-8">
        <div className="mx-auto grid max-w-6xl gap-14 md:grid-cols-[1fr_1.4fr]">
          <div>
            <span className="label">The court of Hades</span>
            <h2 className="display mt-5 text-[clamp(28px,3.6vw,46px)] font-bold leading-[1.05]">
              Five agents. One question each.
            </h2>
            <p className="mt-6 max-w-md leading-relaxed text-muted">
              Agents propose. A deterministic engine enforces dependencies, dates, permissions and version checks. You
              decide. No agent can move a deadline on its own.
            </p>
          </div>
          <ul className="divide-y divide-line rounded-2xl border border-line">
            {AGENTS.map((a) => (
              <li key={a.name} className="grid grid-cols-[1fr_auto] items-center gap-4 p-5 sm:grid-cols-[180px_1fr_auto]">
                <span className={`display text-[15px] font-bold ${a.tone}`}>{a.name}</span>
                <span className="order-3 col-span-2 text-sm text-muted sm:order-none sm:col-span-1">“{a.q}”</span>
                <span className="label text-right">{a.note}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ---------------- Trust ---------------- */}
      <section className="px-5 py-24 sm:px-8">
        <div className="mx-auto max-w-6xl overflow-hidden rounded-3xl border border-line bg-bg-2">
          <div className="grid md:grid-cols-3">
            {[
              ["Facts or guesses, always labelled", "Every impact says whether it came from your dependency graph, the scheduler, a teammate, or an AI inference."],
              ["Nothing moves without you", "Approve or reject each proposed edit. Stale proposals are refused if the plan changed since the analysis."],
              ["Dates come from math", "The timeline is a real scheduler over estimates and owners. Missing estimates are asked for, never invented."],
            ].map(([t, d], i) => (
              <div key={t} className={`p-8 ${i > 0 ? "border-t border-line md:border-l md:border-t-0" : ""}`}>
                <h3 className="display text-base font-bold">{t}</h3>
                <p className="mt-3 text-sm leading-relaxed text-muted">{d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------- Channels ---------------- */}
      <section id="channels" className="scroll-mt-24 px-5 py-24 sm:px-8">
        <div className="mx-auto max-w-6xl">
          <span className="label">Where Hades works</span>
          <h2 className="display mt-5 max-w-3xl text-[clamp(28px,3.6vw,46px)] font-bold leading-[1.05]">
            Managers get a console. Teams get a message.
          </h2>
          <div className="mt-12 grid gap-4 sm:grid-cols-2">
            {CHANNELS.map((c) => (
              <div key={c.name} className="flex flex-col gap-3 rounded-2xl border border-line bg-bg-2 p-6">
                <div className="flex items-center justify-between">
                  <h3 className="display text-base font-bold">{c.name}</h3>
                  <span
                    className={`rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest ${
                      c.tag === "Live" ? "bg-[var(--ok-soft)] text-ok" : "bg-[var(--styx-soft)] text-styx-2"
                    }`}
                  >
                    {c.tag}
                  </span>
                </div>
                <p className="text-sm leading-relaxed text-muted">{c.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------- For the room ---------------- */}
      <section className="px-5 py-24 sm:px-8">
        <div className="relative mx-auto max-w-6xl overflow-hidden rounded-3xl border border-line-2 p-10 sm:p-14">
          <div aria-hidden className="absolute -right-24 -top-24 h-80 w-80 rounded-full bg-styx/20 blur-3xl" />
          <div aria-hidden className="absolute -bottom-32 -left-16 h-80 w-80 rounded-full bg-ember/15 blur-3xl" />
          <span className="label relative">Running an event soon?</span>
          <h2 className="display relative mt-5 max-w-3xl text-[clamp(26px,3.4vw,44px)] font-bold leading-[1.05]">
            College fests, meetups, hackathons, launches. If one change can break your plan, run it on Hades.
          </h2>
          <div className="relative mt-8 flex flex-wrap gap-3">
            <Link href="/app" className="rounded-full bg-text px-6 py-3.5 text-sm font-semibold text-bg transition hover:bg-styx-2">
              Try it on a sample fest
            </Link>
          </div>
        </div>
      </section>

      {/* ---------------- Pricing ---------------- */}
      <section id="pricing" className="scroll-mt-24 px-5 py-24 sm:px-8">
        <div className="mx-auto max-w-6xl">
          <span className="label">Pricing</span>
          <h2 className="display mt-5 text-[clamp(28px,3.6vw,46px)] font-bold leading-[1.05]">Try everything free for 3 days.</h2>
          <div className="mt-12 grid gap-4 md:grid-cols-[1fr_1.2fr]">
            <div className="rounded-2xl border border-line bg-bg-2 p-8">
              <h3 className="display text-lg font-bold">Free trial</h3>
              <p className="mt-2 font-mono text-3xl">
                ₹0<span className="text-base text-muted"> · 3 days</span>
              </p>
              <ul className="mt-6 space-y-2 text-sm text-muted">
                <li>Every feature, no card needed</li>
                <li>Sign in with Google</li>
                <li>Your plan stays readable after the trial</li>
              </ul>
            </div>
            <div className="relative rounded-2xl border border-styx/40 bg-bg-2 p-8 shadow-[0_0_60px_-20px_var(--styx)]">
              <h3 className="display text-lg font-bold">Hades Pro</h3>
              <p className="mt-2 font-mono text-3xl">
                ₹199<span className="text-base text-muted"> / team / month</span>
              </p>
              <ul className="mt-6 space-y-2 text-sm text-muted">
                <li>Unlimited change analyses and approvals</li>
                <li>Member agents on Telegram and WhatsApp</li>
                <li>Google Calendar sync and full change history</li>
              </ul>
              <p className="label mt-6">Pay with Google Pay or any UPI app</p>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-line px-5 py-10 sm:px-8">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <Logo className="h-5 w-5" />
            <span className="display text-sm font-bold">HADES AI</span>
            <span className="label ml-2">God of Event Management</span>
          </div>
          <span className="label">Built at AI Builders Day ’26 · Bengaluru</span>
        </div>
      </footer>
    </main>
  );
}
