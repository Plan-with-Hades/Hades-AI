import { addWorkingDays, nextWorkingDay, toISO } from "./dates";
import type { Project } from "./types";

/**
 * The golden demo: a five-person team shipping a customer portal.
 * Dates are relative to `now` so the demo always looks current:
 * the team is four working days in, and the launch is 14 working days after the start.
 */
export function createDemoProject(now: Date = new Date()): Project {
  const today = toISO(nextWorkingDay(now));
  const startDate = addWorkingDays(today, -4);
  const deadline = addWorkingDays(startDate, 14);

  return {
    id: "demo-portal",
    name: "Customer Portal Launch",
    description:
      "Ship a self-serve customer portal with secure login, a dashboard and payments before the launch date.",
    startDate,
    deadline,
    version: 1,
    members: [
      { id: "priya", name: "Priya", role: "Project manager", initials: "PR", hue: 268 },
      { id: "arjun", name: "Arjun", role: "Product designer", initials: "AR", hue: 196 },
      { id: "meera", name: "Meera", role: "Backend engineer", initials: "ME", hue: 18 },
      { id: "kabir", name: "Kabir", role: "Frontend engineer", initials: "KA", hue: 152 },
      { id: "zoya", name: "Zoya", role: "QA engineer", initials: "ZO", hue: 330 },
    ],
    tasks: [
      {
        id: "T1",
        title: "Confirm requirements",
        description: "Sign off scope, success metrics and launch checklist with the client.",
        ownerId: "priya",
        status: "done",
        priority: "high",
        estimateDays: 2,
        acceptanceCriteria: ["Client signs off scope document"],
        tags: ["requirements", "scope", "planning"],
        version: 1,
      },
      {
        id: "T2",
        title: "Design login interface",
        description: "Login, password reset and session-expiry screens in Figma.",
        ownerId: "arjun",
        status: "done",
        priority: "high",
        estimateDays: 2,
        acceptanceCriteria: ["Screens approved by client", "Mobile and desktop variants"],
        tags: ["design", "ui", "login", "auth", "screen"],
        version: 1,
      },
      {
        id: "T3",
        title: "Build authentication API",
        description: "Email and password login, sessions and token refresh.",
        ownerId: "meera",
        status: "in_progress",
        priority: "high",
        estimateDays: 3,
        acceptanceCriteria: ["Login and refresh endpoints documented", "Rate limiting on login"],
        tags: ["api", "backend", "auth", "login", "security"],
        version: 1,
      },
      {
        id: "T4",
        title: "Harden payment API",
        description: "Idempotent payment callbacks and retry handling for the checkout flow.",
        ownerId: "meera",
        status: "not_started",
        priority: "medium",
        estimateDays: 3,
        acceptanceCriteria: ["Duplicate callbacks are ignored", "Failed payments are retried safely"],
        tags: ["api", "backend", "payment", "checkout"],
        version: 1,
      },
      {
        id: "T5",
        title: "Integrate frontend login",
        description: "Wire the login screens to the authentication API.",
        ownerId: "kabir",
        status: "not_started",
        priority: "high",
        estimateDays: 2,
        acceptanceCriteria: ["Errors shown inline", "Session persists across refresh"],
        tags: ["frontend", "integration", "login", "auth"],
        version: 1,
      },
      {
        id: "T6",
        title: "Build customer dashboard",
        description: "Orders, invoices and profile views for signed-in customers.",
        ownerId: "kabir",
        status: "not_started",
        priority: "medium",
        estimateDays: 3,
        acceptanceCriteria: ["Loads under 2 seconds", "Empty states for new customers"],
        tags: ["frontend", "ui", "dashboard"],
        version: 1,
      },
      {
        id: "T7",
        title: "Test login flow",
        description: "Functional and security tests for sign-in, reset and sessions.",
        ownerId: "zoya",
        status: "not_started",
        priority: "high",
        estimateDays: 2,
        acceptanceCriteria: ["Happy path and lockout covered", "Session expiry covered"],
        tags: ["test", "qa", "login", "auth"],
        version: 1,
      },
      {
        id: "T8",
        title: "End-to-end regression",
        description: "Full regression across login, dashboard and checkout on staging.",
        ownerId: "zoya",
        status: "not_started",
        priority: "high",
        estimateDays: 2,
        acceptanceCriteria: ["No open P0 or P1 bugs"],
        tags: ["test", "qa", "regression", "release"],
        version: 1,
      },
      {
        id: "T9",
        title: "Prepare release",
        description: "Release notes, rollout plan and go-live checklist.",
        ownerId: "priya",
        status: "not_started",
        priority: "critical",
        estimateDays: 1,
        acceptanceCriteria: ["Rollback plan reviewed", "Client informed of go-live"],
        tags: ["release", "launch", "deploy"],
        version: 1,
      },
    ],
    dependencies: [
      { from: "T1", to: "T2" },
      { from: "T1", to: "T3" },
      { from: "T1", to: "T4" },
      { from: "T2", to: "T5" },
      { from: "T3", to: "T5" },
      { from: "T2", to: "T6" },
      { from: "T5", to: "T7" },
      { from: "T6", to: "T8" },
      { from: "T7", to: "T8" },
      { from: "T4", to: "T8" },
      { from: "T8", to: "T9" },
    ],
  };
}

export const GOLDEN_REQUEST = "Add OTP authentication to the customer portal, but the launch date cannot change.";

export const SAMPLE_REQUESTS = [
  GOLDEN_REQUEST,
  "The client wants UPI checkout through Pine Labs before launch.",
  "Move the dashboard to the next release so we can focus on login.",
];
