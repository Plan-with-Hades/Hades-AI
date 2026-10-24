"use client";

import { useEffect, useRef } from "react";

/** Full-page looping video that never stays stopped: restarts on end, on stall and when the tab returns. */
export function VideoBackground({ src, poster }: { src: string; poster: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const play = () => {
      if (document.hidden) return;
      v.muted = true;
      v.play().catch(() => {});
    };
    const restart = () => {
      v.currentTime = 0;
      play();
    };
    v.addEventListener("ended", restart);
    v.addEventListener("pause", play);
    v.addEventListener("stalled", play);
    v.addEventListener("suspend", play);
    document.addEventListener("visibilitychange", play);
    window.addEventListener("focus", play);
    window.addEventListener("pointerdown", play, { once: true });
    play();
    // Safety net: if playback froze for any reason, kick it again.
    let last = -1;
    const t = window.setInterval(() => {
      if (document.hidden) return;
      if (v.paused || v.ended || v.currentTime === last) restart();
      last = v.currentTime;
    }, 4000);
    return () => {
      window.clearInterval(t);
      v.removeEventListener("ended", restart);
      v.removeEventListener("pause", play);
      v.removeEventListener("stalled", play);
      v.removeEventListener("suspend", play);
      document.removeEventListener("visibilitychange", play);
      window.removeEventListener("focus", play);
    };
  }, []);
  return (
    <video
      ref={ref}
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-20 h-full w-full object-cover motion-reduce:hidden"
      src={src}
      poster={poster}
      autoPlay
      loop
      muted
      playsInline
      preload="auto"
      disablePictureInPicture
    />
  );
}
