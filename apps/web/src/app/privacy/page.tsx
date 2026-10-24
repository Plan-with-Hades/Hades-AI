import Link from "next/link";

export const metadata = { title: "Privacy · Hades AI" };

export default function Privacy() {
  return (
    <main className="mx-auto max-w-2xl px-5 py-14 text-[15px] leading-relaxed text-muted">
      <Link href="/" className="display text-sm font-bold text-text">HADES AI</Link>
      <h1 className="display mt-6 text-2xl font-bold text-text">Privacy policy</h1>
      <p className="mt-2 text-xs">Last updated 24 October 2026</p>
      <p className="mt-6">Hades AI helps event teams plan and coordinate work. This page explains what we collect and why.</p>
      <h2 className="mt-6 font-semibold text-text">What we collect</h2>
      <p className="mt-2">When you sign in with Google we receive your name, email address and profile picture. Event managers add teammates by name, role and email. We store your events, tasks, plan history and agent messages so the team can work together.</p>
      <h2 className="mt-6 font-semibold text-text">Google data</h2>
      <p className="mt-2">If an event manager connects Google Workspace, Hades uses their Google account only to do what they ask: create and update the event&apos;s Drive folder, tracker Sheet and plan Doc, read or append to Docs and Sheets they link, create Calendar events with teammates as guests, share files with teammates, and send invitation emails from their Gmail. We do not read your inbox, we do not sell Google data, and we do not use it for advertising or to train AI models. Hades AI&apos;s use of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.</p>
      <h2 className="mt-6 font-semibold text-text">Payments</h2>
      <p className="mt-2">Payments are processed by Pine Labs. We never see or store card or UPI details; we keep the order reference and status.</p>
      <h2 className="mt-6 font-semibold text-text">Your choices</h2>
      <p className="mt-2">You can revoke Hades AI&apos;s access at any time from your Google Account (Security → Third-party connections). To delete your data, email vijaym2k6@gmail.com and we will remove it within 7 days.</p>
      <h2 className="mt-6 font-semibold text-text">Contact</h2>
      <p className="mt-2">vijaym2k6@gmail.com</p>
    </main>
  );
}
