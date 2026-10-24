"use client";

import { useEffect, useState } from "react";
import { setToken } from "@/lib/api";

/** Google sign-in lands here with the session in the URL fragment (never sent to a server). */
export default function AuthDone() {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const err = params.get("error");
    if (err) {
      setError(err);
      return;
    }
    const token = params.get("token");
    const next = params.get("next") ?? "/app";
    if (token) setToken(token);
    window.location.replace(next.startsWith("/") ? next : "/app");
  }, []);
  return (
    <main className="grid min-h-screen place-items-center px-6 text-center">
      {error ? (
        <div>
          <p className="display text-lg font-bold">Sign-in didn&apos;t finish</p>
          <p className="mt-2 text-sm text-muted">{error}</p>
          <a href="/app" className="mt-6 inline-block rounded-full bg-text px-5 py-2.5 text-sm font-semibold text-bg">
            Back to the console
          </a>
        </div>
      ) : (
        <p className="text-muted">Signing you in…</p>
      )}
    </main>
  );
}
