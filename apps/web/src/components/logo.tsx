import Image from "next/image";

/** The Hades AI "HAI" monogram (white, transparent background) for dark surfaces. */
export function Logo({ className = "", priority = false }: { className?: string; priority?: boolean }) {
  return (
    <Image
      src="/brand/hades-mark-white.png"
      alt=""
      aria-hidden="true"
      width={534}
      height={509}
      priority={priority}
      className={`object-contain ${className}`}
    />
  );
}
