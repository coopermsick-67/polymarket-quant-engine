import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PM5 Predictor Terminal",
  description: "A terminal-style paper signal monitor for a Polymarket 5-minute Up/Down predictor.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
