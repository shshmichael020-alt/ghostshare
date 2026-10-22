import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GhostShare — send a file to yourself",
  description: "Pair two browsers with a code and move a file between them. No login.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
