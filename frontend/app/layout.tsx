import type { Metadata } from "next";
import type { ReactNode } from "react";
import { TopNav } from "@/components/TopNav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Relight: drag the light around any photo",
  description: "Drag a light around a photo and watch the highlights and shadows follow, live in your browser. Try a sample or your own photo.",
};

// The type is written out: the one Next.js generates (LayoutProps) exists only after a build, and a type check in a fresh clone must pass without one.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <TopNav />
        <main className="flex flex-1 flex-col">{children}</main>
      </body>
    </html>
  );
}
