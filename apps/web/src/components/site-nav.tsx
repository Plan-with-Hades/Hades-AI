import Link from "next/link";
import { Logo } from "./logo";

export function SiteNav() {
  return (
    <header className="fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-4">
      <nav className="glass flex w-full max-w-5xl items-center justify-between rounded-full py-2 pl-4 pr-2">
        <Link href="/" className="flex items-center gap-2.5" aria-label="Hades AI home">
          <Logo className="h-6 w-6" />
          <span className="display text-[15px] font-bold tracking-tight">HADES AI</span>
        </Link>
        <div className="hidden items-center gap-7 text-[13px] text-muted md:flex">
          <a href="#how" className="transition hover:text-text">How it works</a>
          <a href="#agents" className="transition hover:text-text">Agents</a>
          <a href="#channels" className="transition hover:text-text">Channels</a>
          <a href="#pricing" className="transition hover:text-text">Pricing</a>
        </div>
        <Link
          href="/app"
          className="group flex items-center gap-2 rounded-full border border-line-2 bg-text px-4 py-2 text-[13px] font-semibold text-bg transition hover:bg-styx-2"
        >
          Open console
          <span aria-hidden className="transition group-hover:translate-x-0.5">→</span>
        </Link>
      </nav>
    </header>
  );
}
