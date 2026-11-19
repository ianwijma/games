import { Logo } from "@games/react";
import type { Metadata, Viewport } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Games", template: "%s | Games" },
  description: "Small multiplayer games you can play with friends. No account needed.",
};

export const viewport: Viewport = {
  viewportFit: "cover",
  // The room colour (--room in table.css); the viewport API takes a literal value.
  themeColor: "#1a1411",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="bar">
          <Link href="/" className="brand flex items-center gap-2">
            <Logo width={32} height={32} aria-hidden="true" />
            Games
          </Link>
        </header>
        <main className="table">
          <div className="felt">{children}</div>
        </main>
      </body>
    </html>
  );
}
