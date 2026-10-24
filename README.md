<p align="center"><img src="apps/web/public/brand/hades-lockup-ink.png" width="320" alt="Hades AI"></p>

# Hades AI · God of Event Management

**Every change has a ripple. Hades sees it first.**

Hades AI is an agentic management platform. You describe a change ("the chief guest moved to Friday", "a sponsor pulled out"), and Hades traces every task, owner and deadline it touches, lets specialist agents plan the response, and waits for your approval before anything moves. Then member agents brief each affected person and re-plan when they push back.

Built at **AI Builders Day '26** (Airtribe × Pine Labs) by Team A68.

## How it works

1. **Say what changed.** In the console, or (soon) on WhatsApp.
2. **Watch the ripple.** A deterministic engine walks the dependency graph: direct, downstream and "needs review" tasks.
3. **Agents argue it out.** Scope, Conflict and Timeline agents each answer one question; the Orchestrator reconciles them.
4. **You approve. They chase.** Only approved edits apply (with version checks). Member agents brief teammates, collect new estimates, and the Timeline agent reassesses.

Agents propose. The engine enforces dates, dependencies, ownership and approvals. Every finding is labelled **graph fact**, **scheduler**, **teammate** or **AI inference**.

## Repo layout

```
apps/
  web/        Next.js 16 frontend: landing page (3D ripple field) + /app console
  api/        Express 5 API: projects, change analysis, approvals, member updates
packages/
  core/       Shared engine: types, dependency graph, scheduler, change analysis, approval workflow
docs/
  PRODUCT_BLUEPRINT.md   Full product concept and technical blueprint
```

## Run locally

```bash
npm install
npm run dev:web     # http://localhost:3000
npm run dev:api     # http://localhost:4000
```

The console works without the API (it runs the engine in the browser). Copy `.env.example` to `.env` to configure the API.

Check the engine on the golden scenario:

```bash
npx tsx packages/core/src/demo.check.ts
```

## Hackathon toolkit plan

| Tool | Where it fits in Hades |
|---|---|
| **AgenticOrg** (Pine Labs) | The Orchestrator / member-coordination agent runs here, with the manager's approval as the human-in-the-loop step |
| **Pine Labs** | Pro plan checkout (UPI), test mode during the event |
| **Render** | Hosts the API, Postgres and the web app |
| **Vobiz** | Voice check-ins: Hades calls a teammate to confirm a revised estimate |
| **ElevenLabs** | The voice for those calls and spoken impact summaries |
| **Greptile** | AI code review on this repo |
| **Replit** | Backup deploy target |

## Team

Team A68 · Vijay M, Sriraksha, Thirukumaran Kathirvelan, Yashwanth Karthik, Yatin R
