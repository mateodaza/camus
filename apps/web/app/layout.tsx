import type { Metadata } from 'next';
import { EB_Garamond, Archivo } from 'next/font/google';
import './globals.css';

// EB Garamond: the French book face — Gallimard (Camus's publisher) sets its
// covers in Garamond-family type. Literary by lineage, not by decoration.
const serif = EB_Garamond({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  weight: ['400', '500'],
  variable: '--font-serif',
});

const sans = Archivo({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-sans',
});

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 120'%3E%3Crect width='120' height='120' fill='%23F4F1E8'/%3E%3Cpolygon points='0,120 120,120 120,0' fill='%230B0B16'/%3E%3Ccircle cx='63' cy='33' r='19' fill='%230B0B16'/%3E%3C/svg%3E";

export const metadata: Metadata = {
  title: "Camus — the coding loop that can't grade its own homework",
  description:
    'Camus runs coding tasks through a closed loop: Claude implements, Codex reviews, your own tests have the final word. Cross-vendor honesty, zero-click autonomy, full audit trail.',
  icons: { icon: FAVICON },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable}`}>
      <body>{children}</body>
    </html>
  );
}
