import type { NextConfig } from 'next';

/**
 * Static security headers (SPEC §4.8).
 *
 * The CSP is deliberately NOT nonce-based (SPEC §7.9): there is no `middleware.ts`
 * in this project, so a per-request nonce cannot be minted. `script-src` is
 * therefore documented as NOT being XSS protection. The load-bearing directives
 * here are `base-uri 'none'`, `form-action 'self'`, `object-src 'none'` and
 * `frame-ancestors 'none'` — none of which need a nonce.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Content-Security-Policy', value: CONTENT_SECURITY_POLICY },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  experimental: {
    serverActions: {
      bodySizeLimit: '512kb',
    },
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: SECURITY_HEADERS,
      },
    ];
  },

  /*
   * NO rewrite for pre-workspace project URLs, and the reason is worth keeping.
   *
   * The obvious shim is a `beforeFiles` rewrite matching the old
   * `/orgs/:orgSlug/:projectKey/...` shape by its alphabet -- project keys are
   * uppercase-only, workspace slugs lowercase-only, so a character class ought
   * to separate them. It does not. Next compiles rewrite sources with
   * path-to-regexp's default `sensitive: false`, so `([A-Z][A-Z0-9]{1,9})` also
   * matches `platform`, and `Rewrite` exposes no case-sensitivity option. The
   * shim silently swallowed every workspace whose slug was 2-10 alphanumerics.
   *
   * Legacy project URLs are handled in `[workspaceSlug]/page.tsx` instead, where
   * the ambiguity is resolved by asking the database rather than the spelling.
   */
};

export default nextConfig;
