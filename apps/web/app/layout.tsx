import type { Metadata } from 'next';
import { Source_Serif_4, Archivo } from 'next/font/google';
import './globals.css';

const serif = Source_Serif_4({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  weight: ['400', '600'],
  variable: '--font-serif',
});

const sans = Archivo({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-sans',
});

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 120'%3E%3Crect width='120' height='120' fill='%23F4F1E8'/%3E%3Cpolygon points='0,120 120,120 120,0' fill='%230B0B16'/%3E%3Ccircle cx='71' cy='35' r='11.5' fill='%230B0B16'/%3E%3C/svg%3E";

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
