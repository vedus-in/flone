import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Inter } from 'next/font/google';
import { RouteProvider } from './route-provider';
import './globals.css';

/**
 * `next/font` self-hosts Inter at build time and serves it from `/_next/static`,
 * so the `font-src 'self'` CSP in `next.config.ts` needs no exception. The
 * variable name is fixed: `src/styles/theme.css` reads `--font-inter`.
 */
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

export const metadata: Metadata = {
  title: {
    default: 'Flone',
    template: '%s | Flone',
  },
  description: 'A simple, secure Kanban board for small teams.',
  robots: { index: false, follow: false },
};

/**
 * Untitled UI needs no theme provider: every component module carries
 * `'use client'` itself, so this layout -- and every page under it -- stays a
 * Server Component. `RouteProvider` is the one client boundary, and it only
 * wraps `children` rather than rendering them, so nothing below is forced
 * client-side.
 *
 * Dark mode is class-based, not `prefers-color-scheme`. The app ships dark by
 * default; `suppressHydrationWarning` keeps React quiet if the class is ever
 * flipped on the client before hydration.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`dark-mode ${inter.variable}`} suppressHydrationWarning>
      <body>
        <RouteProvider>{children}</RouteProvider>
      </body>
    </html>
  );
}
