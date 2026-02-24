import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Backtrack Orchestra — Workflow Orchestrator",
  description: "DAG-based workflow orchestrator with real-time phase execution and human-in-loop review.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
