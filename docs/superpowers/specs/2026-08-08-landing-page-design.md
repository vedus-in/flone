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

**Rebuilt 2026-08-09 after design feedback** — the first version was a generic
token-styled SaaS page; the brief is structural fidelity to the reference
(linear.app): near-monochrome, oversized left-aligned type, no hero CTA
buttons, detailed product mockups, numbered feature chapters.

Two server components, no client JS: `src/app/page.tsx` (composition) and
`src/app/landing-mockups.tsx` (decorative CSS-drawn product mockups):

1. Sticky header — wordmark, center anchors (Track/Plan/Agents), Log in, and
   a white rounded-full Sign up pill (the reference's one hard accent).
2. Hero — display-xl headline + one positioning line on the left, a
   "New — Daily Challenges →" text link on the right, **no buttons**; then a
   flat (no tilt) detailed app mockup: sidebar, issue view with comments,
   meta rail, and a floating agent-chat card, fading into the page.
3. Compatibility row — "Works with any MCP client" + client names, the honest
   stand-in for a customer logo cloud (we will not fabricate logos).
4. Two-tone statement paragraph (first sentence white, rest gray) + three
   pillars with `Fig 0.n`-labelled monoline isometric SVG wireframes.
5. Numbered chapters `1.0 Track`, `2.0 Plan`, `3.0 Agents` — each: left H2 /
   right paragraph + mono index label, a large composite visual (dimmed
   backdrop + floating card), and a `n.n` sub-feature index, bottom-right.
6. Closing CTA + minimal footer.

Palette discipline: near-monochrome; surfaces separate with white-alpha rings
and shadows, chroma only in tiny status dots and the brand tile.

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
