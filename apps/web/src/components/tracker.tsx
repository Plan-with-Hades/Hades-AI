"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { API_URL } from "@/lib/api";

/** First-party page-view counter: a random per-browser id, no cookies, no personal data. */
export function Tracker() {
  const path = usePathname();
  useEffect(() => {
    if (!API_URL || path.startsWith("/dev")) return;
    let id = "";
    try {
      id = localStorage.getItem("hades:vid") ?? "";
      if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem("hades:vid", id);
      }
    } catch {
      id = "anon-" + Math.random().toString(36).slice(2, 10);
    }
    const body = JSON.stringify({ visitorId: id, path, referrer: document.referrer || undefined });
    fetch(`${API_URL}/api/track`, { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
  }, [path]);
  return null;
}
