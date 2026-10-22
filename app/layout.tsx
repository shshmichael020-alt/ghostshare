import type { Metadata, Viewport } from "next";
import { Geist, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "GhostShare — Ephemeral Direct Peer Transfer",
  description:
    "Direct browser-to-browser file transfer via Cloudflare R2 and Workers KV. Zero accounts, zero login, automatic self-destruction.",
  keywords: ["file transfer", "p2p", "ephemeral", "privacy", "r2", "cloudflare"],
  authors: [{ name: "GhostShare" }],
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`dark ${geistSans.variable} ${jetbrainsMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-canvas-default text-on-surface">
        {children}
      </body>
    </html>
  );
}
