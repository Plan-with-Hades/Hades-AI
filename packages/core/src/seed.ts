import { addWorkingDays, nextWorkingDay, toISO } from "./dates";
import type { Project } from "./types";

/**
 * The golden demo: a five-person student team running a college tech fest.
 * Dates are relative to `now` so the demo always looks current:
 * the team is four working days in, and the fest is 14 working days after the start.
 */
export function createDemoProject(now: Date = new Date()): Project {
  const today = toISO(nextWorkingDay(now));
  const startDate = addWorkingDays(today, -4);
  const deadline = addWorkingDays(startDate, 14);

  return {
    id: "demo-fest",
    name: "Ignite ’26 Tech Fest",
    description: "A one-day college tech fest: talks, a hackathon and a cultural night for 1,200 students.",
    startDate,
    deadline,
    version: 1,
    members: [
      { id: "ananya", name: "Ananya", role: "Event lead", initials: "AN", hue: 268 },
      { id: "rohan", name: "Rohan", role: "Sponsorships & finance", initials: "RO", hue: 18 },
      { id: "ishita", name: "Ishita", role: "Design & marketing", initials: "IS", hue: 330 },
      { id: "dev", name: "Dev", role: "Venue & vendors", initials: "DE", hue: 196 },
      { id: "kavya", name: "Kavya", role: "Registrations & volunteers", initials: "KA", hue: 152 },
    ],
    tasks: [
      {
        id: "E1",
        title: "Get HOD and principal approval",
        description: "Letter of request, budget estimate and safety plan signed off.",
        ownerId: "ananya",
        status: "done",
        priority: "high",
        estimateDays: 2,
        acceptanceCriteria: ["Signed approval letter", "Budget ceiling agreed"],
        tags: ["approval", "permission", "planning"],
        version: 1,
      },
      {
        id: "E2",
        title: "Book the main auditorium",
        description: "Reserve the auditorium and two seminar halls for the full day.",
        ownerId: "dev",
        status: "done",
        priority: "high",
        estimateDays: 2,
        acceptanceCriteria: ["Booking confirmed by estate office"],
        tags: ["venue", "logistics"],
        version: 1,
      },
      {
        id: "E3",
        title: "Close the title sponsor",
        description: "Finalise the title sponsor deal that funds 40% of the budget.",
        ownerId: "rohan",
        status: "in_progress",
        priority: "high",
        estimateDays: 4,
        acceptanceCriteria: ["Signed sponsorship agreement", "Logo files received"],
        tags: ["sponsor", "budget", "finance"],
        version: 1,
      },
      {
        id: "E4",
        title: "Confirm chief guest and speakers",
        description: "Lock the keynote speaker, two panel speakers and their travel.",
        ownerId: "ananya",
        status: "in_progress",
        priority: "high",
        estimateDays: 3,
        acceptanceCriteria: ["Written confirmation from each speaker"],
        tags: ["guest", "speaker"],
        version: 1,
      },
      {
        id: "E5",
        title: "Design posters and social creatives",
        description: "Posters, Instagram posts and the stage backdrop with sponsor and speaker names.",
        ownerId: "ishita",
        status: "not_started",
        priority: "high",
        estimateDays: 2,
        acceptanceCriteria: ["Sponsor logos placed per agreement", "Approved by event lead"],
        tags: ["design", "marketing", "poster"],
        version: 1,
      },
      {
        id: "E6",
        title: "Open registrations and passes",
        description: "Registration form, passes and confirmation messages for students.",
        ownerId: "kavya",
        status: "not_started",
        priority: "high",
        estimateDays: 2,
        acceptanceCriteria: ["Form live", "Confirmation sent on signup"],
        tags: ["registration", "tickets"],
        version: 1,
      },
      {
        id: "E7",
        title: "Book AV, stage and catering",
        description: "Sound, lights, stage and food vendors within the agreed budget.",
        ownerId: "dev",
        status: "not_started",
        priority: "high",
        estimateDays: 3,
        acceptanceCriteria: ["Three quotes compared", "Advance paid"],
        tags: ["vendor", "logistics", "budget", "catering"],
        version: 1,
      },
      {
        id: "E8",
        title: "Order fest merch and goodies",
        description: "T-shirts and goodie bags for volunteers and winners.",
        ownerId: "ishita",
        status: "not_started",
        priority: "medium",
        estimateDays: 2,
        acceptanceCriteria: ["Sizes collected", "Delivered two days before the fest"],
        tags: ["merch", "budget"],
        version: 1,
      },
      {
        id: "E9",
        title: "Volunteer briefing and run-of-show",
        description: "Minute-by-minute schedule, volunteer roles and emergency contacts.",
        ownerId: "kavya",
        status: "not_started",
        priority: "high",
        estimateDays: 2,
        acceptanceCriteria: ["Every volunteer knows their slot", "Run-of-show shared with speakers"],
        tags: ["volunteers", "schedule"],
        version: 1,
      },
      {
        id: "E10",
        title: "Rehearsal and fest day",
        description: "Tech rehearsal the evening before, then the fest itself.",
        ownerId: "ananya",
        status: "not_started",
        priority: "critical",
        estimateDays: 1,
        acceptanceCriteria: ["Rehearsal completed", "Doors open on time"],
        tags: ["launch", "rehearsal"],
        version: 1,
      },
    ],
    dependencies: [
      { from: "E1", to: "E2" },
      { from: "E1", to: "E3" },
      { from: "E1", to: "E4" },
      { from: "E3", to: "E5" },
      { from: "E4", to: "E5" },
      { from: "E2", to: "E6" },
      { from: "E5", to: "E6" },
      { from: "E2", to: "E7" },
      { from: "E3", to: "E7" },
      { from: "E3", to: "E8" },
      { from: "E6", to: "E9" },
      { from: "E7", to: "E9" },
      { from: "E8", to: "E9" },
      { from: "E9", to: "E10" },
    ],
  };
}

export const GOLDEN_REQUEST = "Our title sponsor pulled out, so we have 40% less budget. The fest date cannot move.";

export const SAMPLE_REQUESTS = [
  GOLDEN_REQUEST,
  "The chief guest can only do a 4 PM keynote and wants the stage backdrop to show their foundation.",
  "The estate office moved us from the auditorium to the open-air ground.",
  "Drop the merch this year so we can focus on the fest.",
];

/** Suggested replies for the demo's member inboxes, so a judge can play a teammate in one click. */
export const DEMO_REPLIES: Record<string, { taskId: string; estimateDays?: number; note: string }> = {
  rohan: { taskId: "E3", estimateDays: 7, note: "The backup sponsor needs two more days to get approval from their marketing head." },
  dev: { taskId: "E7", estimateDays: 3, note: "Caterer agreed to a smaller menu. AV quote is the same." },
  ishita: { taskId: "E5", estimateDays: 2, note: "I can start with a sponsor-logo placeholder today." },
  kavya: { taskId: "E6", estimateDays: 3, note: "Paid passes need one extra day to test the payment flow." },
};
