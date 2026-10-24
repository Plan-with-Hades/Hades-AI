import type { Metadata } from "next";
import { Console } from "@/components/console/console";

export const metadata: Metadata = {
  title: "Console · Hades AI",
};

export default function ConsolePage() {
  return <Console />;
}
