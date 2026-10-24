import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Manrope, Unbounded } from "next/font/google";
import "./globals.css";

const unbounded = Unbounded({ variable: "--font-unbounded", subsets: ["latin"], weight: ["500", "700", "800"] });
const manrope = Manrope({ variable: "--font-manrope", subsets: ["latin"] });
const jetbrains = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"], weight: ["400", "500"] });

export const metadata: Metadata = {
  title: "Hades AI · God of the Backend",
  description:
    "An agentic management platform. Type a change, and Hades traces every task, owner and deadline it touches, lets specialist agents plan the response, and waits for your approval.",
  openGraph: {
    title: "Hades AI · God of the Backend",
    description: "Every change has a ripple. Hades sees it before it hits.",
  },
};

export const viewport: Viewport = {
  themeColor: "#06070a",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${unbounded.variable} ${manrope.variable} ${jetbrains.variable} h-full antialiased`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
