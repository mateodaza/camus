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

// The navbar mark, full bleed (2026-06-10): the ridge runs unbroken to the top-right
// corner — the solid corner closes the icon at small sizes (the old peak left a white
// triangle above it that read as noise). Same artwork as og/icon.html — keep in sync.
const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 170 400 400'%3E%3Crect x='0' y='170' width='400' height='400' fill='%23ffffff'/%3E%3Cpolygon points='-24,456 40,520 416,144 416,600 -24,600' fill='%230A0A0A'/%3E%3Ccircle cx='190' cy='307' r='50' fill='%230A0A0A'/%3E%3C/svg%3E";

// The production origin. Link previews (iMessage, WhatsApp, X, Slack, LinkedIn) require
// ABSOLUTE og:image/canonical URLs — metadataBase resolves the relative paths below.
// Override per-environment with NEXT_PUBLIC_SITE_URL (e.g. a preview deploy).
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://camus.sh';

const TITLE = 'Camus: independent review for AI work';
const DESCRIPTION =
  'One AI does the work. Another, from a different company, checks it against your acceptance contract. Tests, sources, human decisions, and a sealed receipt show what actually earned trust.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    url: '/',
    siteName: 'Camus',
    title: TITLE,
    description: DESCRIPTION,
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: 'Camus, independent review and evidence for work made by AI.',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
    images: ['/og.png'],
  },
  icons: {
    // SVG first (crisp at any size); .ico for legacy browsers and pinned tabs.
    icon: [
      { url: FAVICON, type: 'image/svg+xml' },
      { url: '/favicon.ico', sizes: '48x48 32x32 16x16' },
    ],
    apple: '/apple-touch-icon.png',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
