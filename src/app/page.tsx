import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowRight } from '@untitledui/icons';
import { readSession } from '@/lib/session';
import {
  AgentsVisual,
  FigCubes,
  FigPanels,
  FigStack,
  HeroAppMockup,
  PlanVisual,
  TrackVisual,
} from './landing-mockups';

/**
 * SPEC 5 amendment -- `/` is the public landing page. The signed-in dispatcher
 * that used to live here moved to `/orgs`; anyone with a session is bounced
 * there, so every legacy `redirect('/')` (login, verify, reset) still lands in
 * the app after exactly one extra hop.
 *
 * `readSession()` rather than `requireUser()` for the same reason as the auth
 * layout: the interesting case is the absence of a session, which must not
 * throw. The `.catch` goes further: a visitor carrying a stale cookie during a
 * DB outage still gets the marketing page, not the error boundary — the one
 * page with no reason to hard-depend on the database. Signed-in users with a
 * broken DB fail at `/orgs` exactly as before. Reading the session makes the
 * route dynamic; `force-dynamic` is the same belt-and-braces the rest of the
 * session-aware tree wears.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: { absolute: 'Flone — the kanban system for teams and agents' },
  description:
    'Flone is a purpose-built kanban tool for small teams and the agents working alongside them: boards, cycles, daily challenges and a first-class MCP server.',
};

/* Stagger per make-interfaces-feel-better: semantic chunks ~100ms apart,
   hero only — the rest of the page holds still, like the reference. */
const ENTER =
  'animate-in fade-in slide-in-from-bottom-2 duration-700 fill-mode-backwards motion-reduce:animate-none';

/* ≥40px hit area for small text links (skill principle 16). */
const HIT = "relative before:absolute before:-inset-x-1 before:-inset-y-2.5 before:content-['']";

/* No radius here: each caller sets its own, so `rounded-full` on the pill
   never fights a shared `rounded-sm` (conflicting utilities resolve by
   stylesheet order, not class order).

   No `outline-none` either: in Tailwind v4 it sets `--tw-outline-style: none`
   unconditionally, which the `focus-visible:outline-2` ramp then inherits —
   the ring gets width and color but `outline-style: none`, i.e. an invisible
   focus indicator. Browsers only draw the default outline on focus, and on
   focus these utilities fully replace it, so nothing is lost by omitting it. */
const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

function Container({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-6xl px-6 ${className}`}>{children}</div>;
}

function NavLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className={`${HIT} ${FOCUS} rounded-sm text-sm text-tertiary transition-colors hover:text-primary`}>
      {children}
    </Link>
  );
}

function PillLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className={`${FOCUS} relative rounded-full bg-white px-4 py-1.5 text-sm font-medium text-neutral-950 transition-[background-color,scale] before:absolute before:inset-x-0 before:-inset-y-1 before:content-[''] hover:bg-neutral-200 active:scale-[0.96]`}
    >
      {children}
    </Link>
  );
}

function Wordmark({ muted = false }: { muted?: boolean }) {
  return (
    <Link
      href="/"
      className={`${FOCUS} relative flex items-center gap-2.5 rounded-md before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-['']`}
    >
      <span
        aria-hidden="true"
        className="grid size-6 place-items-center rounded-md bg-brand-solid text-xs font-semibold text-white"
      >
        K
      </span>
      <span className={`text-md font-semibold tracking-tight ${muted ? 'text-tertiary' : 'text-primary'}`}>
        Flone
      </span>
    </Link>
  );
}

/** Left heading, right description — the reference's two-column section head. */
function SectionHead({
  index,
  title,
  children,
}: {
  index: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-8 lg:grid-cols-2 lg:gap-16">
      <h2 className="max-w-md text-display-sm font-semibold text-balance text-primary sm:text-display-md">
        {title}
      </h2>
      <div className="max-w-md lg:justify-self-end lg:pt-1.5">
        <p className="text-lg text-pretty text-tertiary">{children}</p>
        <p className="mt-6 font-mono text-sm text-quaternary">{index}</p>
      </div>
    </div>
  );
}

/** The numbered sub-feature index the reference closes each chapter with. */
function SectionIndex({ items }: { items: Array<[string, string]> }) {
  return (
    <div className="mt-14 grid max-w-md gap-x-12 gap-y-2.5 sm:grid-cols-2 lg:ml-auto">
      {items.map(([n, label]) => (
        <span key={n} className="flex items-baseline gap-3 text-sm">
          <span className="font-mono text-xs text-quaternary tabular-nums">{n}</span>
          <span className="text-tertiary">{label}</span>
        </span>
      ))}
    </div>
  );
}

function Pillar({
  fig,
  title,
  children,
  illustration,
}: {
  fig: string;
  title: string;
  children: ReactNode;
  illustration: ReactNode;
}) {
  return (
    <div className="flex flex-col sm:px-8 sm:first:pl-0 sm:last:pr-0">
      <span className="font-mono text-[10px] tracking-widest text-quaternary uppercase">{fig}</span>
      <div aria-hidden="true" className="my-8 flex h-40 items-center">
        {illustration}
      </div>
      {/* h2, not h3: these are the first headings after the page h1, and the
          statement above them is a paragraph — an h3 here skips a level. */}
      <h2 className="text-sm font-semibold text-primary">{title}</h2>
      <p className="mt-2 text-sm text-pretty text-tertiary">{children}</p>
    </div>
  );
}

export default async function LandingPage() {
  const session = await readSession().catch(() => null);
  if (session) redirect('/orgs');

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-50 border-b border-white/5 bg-primary/80 backdrop-blur-md">
        <Container className="flex h-16 items-center justify-between">
          <Wordmark />
          <nav aria-label="Sections" className="hidden items-center gap-8 md:flex">
            <NavLink href="#track">Track</NavLink>
            <NavLink href="#plan">Plan</NavLink>
            <NavLink href="#agents">Agents</NavLink>
          </nav>
          <nav aria-label="Account" className="flex items-center gap-6">
            <NavLink href="/login">Log in</NavLink>
            <PillLink href="/register">Sign up</PillLink>
          </nav>
        </Container>
      </header>

      <main className="flex-1">
        {/* Hero — no buttons, like the reference: headline, one line of
            positioning, the announcement link, then the product itself. */}
        <section className="pt-20 sm:pt-28">
          <Container>
            <div className="flex flex-col gap-10 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h1
                  className={`max-w-2xl text-display-md font-semibold text-balance text-primary sm:text-display-lg lg:text-display-xl ${ENTER}`}
                >
                  The kanban system for teams and agents
                </h1>
                <p className={`mt-6 max-w-md text-md text-pretty text-tertiary ${ENTER} delay-100`}>
                  Purpose-built for planning and shipping. Small enough to stay honest, open enough
                  for the agents you work with.
                </p>
              </div>
              <Link
                href="#track"
                className={`${HIT} ${FOCUS} flex items-center gap-3 rounded-sm text-sm ${ENTER} delay-200`}
              >
                <span className="font-medium text-primary">New</span>
                <span className="text-tertiary transition-colors hover:text-primary">
                  Daily Challenges
                </span>
                <ArrowRight aria-hidden="true" className="size-3.5 text-tertiary" />
              </Link>
            </div>
          </Container>
          <Container className="max-w-7xl">
            <div aria-hidden="true" className={`mt-16 sm:mt-20 ${ENTER} delay-300`}>
              <HeroAppMockup />
            </div>
          </Container>
        </section>

        {/* Compatibility row — the one claim we can make instead of a logo
            cloud: the MCP server speaks to every client. */}
        <section className="pt-24 pb-4 sm:pt-32">
          <Container className="text-center">
            <p className="font-mono text-[11px] tracking-widest text-quaternary uppercase">
              Works with any MCP client
            </p>
            <p className="mt-5 flex flex-wrap items-center justify-center gap-x-10 gap-y-3 text-sm font-medium text-tertiary">
              <span>Claude Code</span>
              <span>Claude</span>
              <span>Cursor</span>
              <span>Codex</span>
              <span>Copilot</span>
              <span>Windsurf</span>
            </p>
          </Container>
        </section>

        {/* Two-tone statement + pillars. */}
        <section className="py-24 sm:py-32">
          <Container>
            <p className="max-w-4xl text-display-xs font-semibold text-pretty sm:text-display-sm">
              <span className="text-primary">A deliberately small tracker. </span>
              <span className="text-quaternary">
                Built for compact teams working alongside agents, Flone keeps planning honest and
                shipping quick — boards, cycles, and nothing you have to administer.
              </span>
            </p>
            <div className="mt-20 grid gap-12 sm:grid-cols-3 sm:gap-0 sm:divide-x sm:divide-white/5">
              <Pillar fig="Fig 0.1" title="Purpose-built" illustration={<FigStack />}>
                Shaped by how small teams actually ship: boards, issues and cycles — no plugin
                marketplace, no seat-math, no admin console.
              </Pillar>
              <Pillar fig="Fig 0.2" title="Powered by agents" illustration={<FigCubes />}>
                Humans and agents work the same issues through the same rules. From filing a bug to
                moving the card to Done.
              </Pillar>
              <Pillar fig="Fig 0.3" title="Designed for speed" illustration={<FigPanels />}>
                Server-rendered and keyboard-first. Less noise, fewer clicks, and momentum that
                survives Monday.
              </Pillar>
            </div>
          </Container>
        </section>

        {/* 1.0 Track */}
        <section id="track" className="scroll-mt-24 py-24 sm:py-32">
          <Container>
            <SectionHead index="1.0 Track" title="Make the day's work obvious">
              Boards that stay current, issues that carry their own context, and a personal Daily
              Challenges board that cuts across every project you're part of.
            </SectionHead>
            <div aria-hidden="true" className="mt-16">
              <TrackVisual />
            </div>
            <SectionIndex
              items={[
                ['1.1', 'Boards'],
                ['1.2', 'Issues'],
                ['1.3', 'Saved views'],
                ['1.4', 'Daily Challenges'],
              ]}
            />
          </Container>
        </section>

        {/* 2.0 Plan */}
        <section id="plan" className="scroll-mt-24 py-24 sm:py-32">
          <Container>
            <SectionHead index="2.0 Plan" title="Define the cycle ahead">
              Timeboxed cycles with a burndown that draws itself. See what's current, what's
              upcoming and what slipped — without calling a status meeting.
            </SectionHead>
            <div aria-hidden="true" className="mt-16">
              <PlanVisual />
            </div>
            <SectionIndex
              items={[
                ['2.1', 'Cycles'],
                ['2.2', 'Burndown'],
                ['2.3', 'Workspaces'],
                ['2.4', 'Projects'],
              ]}
            />
          </Container>
        </section>

        {/* 3.0 Agents */}
        <section id="agents" className="scroll-mt-24 py-24 sm:py-32">
          <Container>
            <SectionHead index="3.0 Agents" title="Move work forward across teams and agents">
              Hand Claude — or any MCP client — a token and let it file, move and search issues
              alongside your team. Every action is scoped to its own membership, like any other
              teammate.
            </SectionHead>
            <div aria-hidden="true" className="mt-16">
              <AgentsVisual />
            </div>
            <SectionIndex
              items={[
                ['3.1', 'MCP server'],
                ['3.2', 'API tokens'],
                ['3.3', 'Comments'],
                ['3.4', 'Email'],
              ]}
            />
          </Container>
        </section>

        {/* Closing CTA */}
        <section className="py-24 sm:py-32">
          <Container>
            <h2 className="text-display-sm font-semibold text-balance text-primary">
              Plan less. Ship more.
            </h2>
            <p className="mt-4 max-w-md text-lg text-pretty text-tertiary">
              Set up an organization in a minute. Invite the team — and the agents — when you're
              ready.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-6">
              <PillLink href="/register">Start your board</PillLink>
              <NavLink href="/login">Log in</NavLink>
            </div>
          </Container>
        </section>
      </main>

      <footer className="border-t border-white/5">
        <Container className="flex flex-wrap items-center justify-between gap-4 py-8">
          <Wordmark muted />
          <nav aria-label="Footer" className="flex items-center gap-8 text-sm text-tertiary">
            <Link className={`${HIT} ${FOCUS} rounded-sm transition-colors hover:text-secondary`} href="/login">
              Log in
            </Link>
            <Link className={`${HIT} ${FOCUS} rounded-sm transition-colors hover:text-secondary`} href="/register">
              Sign up
            </Link>
          </nav>
        </Container>
      </footer>
    </div>
  );
}
