import type { Metadata } from 'next';
import { EB_Garamond, Archivo, JetBrains_Mono } from 'next/font/google';
import './globals.css';

// Two faces only. EB Garamond carries everything human (the French book face;
// Gallimard, Camus's publisher, sets its covers in Garamond-family type).
// JetBrains Mono carries everything machine: labels, code, the receipts.
const serif = EB_Garamond({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  weight: ['400', '500'],
  variable: '--font-serif',
  display: 'swap',
});

const sans = Archivo({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-sans',
  display: 'swap',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
});

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 170 400 400'%3E%3Crect x='0' y='170' width='400' height='400' fill='%23ffffff'/%3E%3Cpolygon points='-24,456 40,520 360,200 416,256 416,600 -24,600' fill='%230A0A0A'/%3E%3Ccircle cx='190' cy='307' r='50' fill='%230A0A0A'/%3E%3C/svg%3E";

export const metadata: Metadata = {
  title: "Camus: autonomous coding that can't approve its own work",
  description:
    "Camus runs a coding task from plan to verified commit, unattended. A competing model reviews every change. Your own tests have the final word.",
  icons: { icon: FAVICON },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
