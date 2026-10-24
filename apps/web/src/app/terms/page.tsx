import Link from "next/link";

export const metadata = { title: "Terms · Hades AI" };

export default function Terms() {
  return (
    <main className="mx-auto max-w-2xl px-5 py-14 text-[15px] leading-relaxed text-muted">
      <Link href="/" className="display text-sm font-bold text-text">HADES AI</Link>
      <h1 className="display mt-6 text-2xl font-bold text-text">Terms of service</h1>
      <p className="mt-2 text-xs">Last updated 24 October 2026</p>
      <p className="mt-6">By using Hades AI you agree to these terms.</p>
      <h2 className="mt-6 font-semibold text-text">The service</h2>
      <p className="mt-2">Hades AI is an agentic planning tool for event teams. Agents suggest plans and changes; the event manager decides what is applied. You are responsible for checking plans before acting on them.</p>
      <h2 className="mt-6 font-semibold text-text">Accounts</h2>
      <p className="mt-2">You sign in with Google. Keep your account secure and only invite people who should see your event.</p>
      <h2 className="mt-6 font-semibold text-text">Plans and payment</h2>
      <p className="mt-2">New teams get a 3-day free trial. Hades Pro costs ₹599 per team per month, paid by UPI (Google Pay or any UPI app). Access starts once we confirm the payment. You can stop renewing at any time; access continues until the paid month ends.</p>
      <h2 className="mt-6 font-semibold text-text">Acceptable use</h2>
      <p className="mt-2">Don&apos;t use Hades AI to send spam, to invite people who haven&apos;t agreed to be contacted, or to break the law.</p>
      <h2 className="mt-6 font-semibold text-text">Liability</h2>
      <p className="mt-2">Hades AI is provided as is. We are not liable for indirect losses arising from plans, schedules or messages produced by the service.</p>
      <h2 className="mt-6 font-semibold text-text">Contact</h2>
      <p className="mt-2">vijaym2k6@gmail.com</p>
    </main>
  );
}
