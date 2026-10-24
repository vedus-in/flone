import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Inter } from 'next/font/google';
import Script from 'next/script';
import { THEME_BOOT_SCRIPT } from '@/lib/theme';
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
 * default; the boot script in the head swaps the class before first paint for
 * anyone who picked light or system (`src/lib/theme.ts`), and
 * `suppressHydrationWarning` keeps React quiet about the class it changed.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`dark-mode ${inter.variable}`} suppressHydrationWarning>
      <body>
        {/* A constant, not user input; `beforeInteractive` puts it in the head
            ahead of hydration, and the CSP already allows inline scripts. */}
        <Script id="theme-boot" strategy="beforeInteractive">
          {THEME_BOOT_SCRIPT}
        </Script>
        <RouteProvider>{children}</RouteProvider>
      </body>
    </html>
  );
}
