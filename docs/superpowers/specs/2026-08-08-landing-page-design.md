# Landing page — design

**Date:** 2026-08-08
**Status:** Built (autonomous session; design decisions recorded here rather than pre-approved)

## Goal

A public marketing page at `/` in the visual language of linear.app: dark,
oversized tight-tracked display type, sticky blurred nav, glowing product
mockup, feature grid, minimal footer.

## Routing decision

`/` was the signed-in org dispatcher inside `(app)`, whose layout calls
`requireUser()` — signed-out visitors never saw anything but `/login`.

Chosen approach (A): move the dispatcher to `/orgs` (it already owned the
`/orgs/*` namespace) and make `/` a public page that renders the landing for
visitors and `redirect('/orgs')` for sessions.

Rejected:

- (B) Landing at a side path like `/home` — no signed-out visitor would ever
  reach it, which defeats a landing page.
- (C) A separate static marketing site — a second deploy target for one page.

Every legacy `redirect('/')` (login, verify, reset, auth-layout bounce) still
works through one extra hop via the new root redirect, so those call sites were
deliberately left untouched. Only links that *semantically* mean "the org list"
were repointed at `/orgs`: the org-settings breadcrumb, the cancel link on
`/orgs/new`, and the post-delete redirect in org settings actions.

## Page anatomy

Single server component, `src/app/page.tsx`, no client JS:

1. Sticky header — blurred `bg-primary/80`, letter mark + wordmark (shared
   `Wordmark` helper mirroring the auth shell), Log in / Sign up `ButtonLink`s.
2. Hero — "New" pill (Daily Challenges), display-lg headline, subcopy, two
   CTAs. Brand glow via a blurred `bg-brand-solid/15` disc.
3. Product mockup — a kanban board drawn in pure CSS from `MockColumn` /
   `MockCard` helpers (no screenshot to go stale), 3° perspective tilt,
   bottom gradient fade into the page. `aria-hidden` — decorative.
4. Feature grid — six cards, all real features: boards, cycles, daily
   challenges, orgs/workspaces, MCP-for-agents, email.
5. Closing CTA + footer.

## Styling constraints

- Untitled UI tokens only (`text-*`, `bg-*`, display type scale from
  `src/styles/theme.css`); dark ships by default via `.dark-mode` on `<html>`.
- Polish rules applied: concentric radii on the mockup frame (16 − 6 = 10),
  `text-balance` headings / `text-pretty` body, staggered ~100 ms enter
  animations via `tailwindcss-animate` with `motion-reduce:animate-none`,
  white-10% rings instead of hard borders on dark surfaces, hero pill hit area
  extended to ≥40 px with a pseudo-element.

## Out of scope

- `robots: noindex` in the root layout is left as-is — whether this deploy
  should be indexable is a product call, not a styling one.
- No logo cloud, no testimonials, no pricing: nothing to truthfully put there.
