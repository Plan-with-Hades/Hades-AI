/**
 * Smoke test for the golden scenario. Run with: npx tsx packages/core/src/demo.check.ts
 */
import { analyzeChange, approveChanges, applyMemberUpdate, createDemoProject, GOLDEN_REQUEST, SAMPLE_REQUESTS, scheduleProject } from "./index";

const project = createDemoProject(new Date("2026-10-24T10:00:00"));
const base = scheduleProject(project);
console.log(`Baseline: finish ${base.finishDate} (day ${base.finishDay}), deadline ${project.deadline} (day ${base.deadlineDay}), buffer ${base.bufferDays}`);

const report = analyzeChange(project, GOLDEN_REQUEST);
console.log(`\n${report.interpretation}`);
console.log(`direct=${report.directTaskIds} downstream=${report.downstreamTaskIds} inferred=${report.inferredTaskIds}`);
for (const a of report.agents) {
  console.log(`\n[${a.label}] ${a.summary}`);
  for (const f of a.findings) console.log(`  - (${f.basis}) ${f.title}`);
}
console.log(`\nChanges:`);
for (const c of report.changes) console.log(`  ${c.recommended ? "[x]" : "[ ]"} ${c.id} ${c.type}: ${c.summary}`);
console.log(`\nVerdict: ${report.feasibility.verdict} — ${report.feasibility.headline}`);
console.log(`Questions: ${report.openQuestions.join(" | ")}`);

const approved = approveChanges(project, report, report.changes.filter((c) => c.recommended).map((c) => c.id));
console.log(`\nApproved v${approved.project.version}. Messages:`);
for (const m of approved.messages) console.log(`  -> ${m.memberId}: ${m.text.split("\n").slice(2).join(" ")}`);
console.log(`After approval: ${JSON.stringify((({ finishDate, bufferDays }) => ({ finishDate, bufferDays }))(scheduleProject(approved.project)))}`);

const otp = approved.project.tasks.find((t) => t.title.startsWith("Build OTP"))!;
const upd = applyMemberUpdate(approved.project, { memberId: otp.ownerId, taskId: otp.id, estimateDays: 3, note: "OTP will take 3 days, not 2. I'm also fixing the payment API." });
console.log(`\nMember update → ${upd.reassessment.headline}`);
for (const s of upd.reassessment.suggestions) console.log(`  ? ${s.summary}`);

for (const r of SAMPLE_REQUESTS.slice(1)) {
  const rep = analyzeChange(project, r);
  console.log(`\n"${r}" → ${rep.changes.length} changes, ${rep.feasibility.verdict}: ${rep.feasibility.headline}`);
}
