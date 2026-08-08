import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  ArrowRight,
  Columns03,
  Dataflow03,
  Mail01,
  RefreshCcw02,
  Target04,
  Users01,
} from '@untitledui/icons';
import { ButtonLink } from '@/components/ui';
import { readSession } from '@/lib/session';

/**
 * SPEC 5 amendment -- `/` is the public landing page. The signed-in dispatcher
 * that used to live here moved to `/orgs`; anyone with a session is bounced
 * there, so every legacy `redirect('/')` (login, verify, reset) still lands in
 * the app after exactly one extra hop.
 *
 * `readSession()` rather than `requireUser()` for the same reason as the auth
 * layout: the interesting case is the absence of a session, which must not
 * throw. Reading the session makes the route dynamic; `force-dynamic` is the
 * same belt-and-braces the rest of the session-aware tree wears.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: { absolute: 'Flone — plan, track and ship without the ceremony' },
  description:
    'Flone is a simple, secure kanban board for small teams: boards, cycles, daily challenges and first-class agent access. Nothing you don’t need.',
};

/* Stagger per make-interfaces-feel-better: semantic chunks ~100ms apart.
   `fill-mode-backwards` keeps delayed chunks invisible until their turn. */
const ENTER = 'animate-in fade-in slide-in-from-bottom-2 duration-700 fill-mode-backwards motion-reduce:animate-none';

const FEATURES: Array<{ icon: typeof Columns03; title: string; body: string }> = [
  {
    icon: Columns03,
    title: 'Boards that move',
    body: 'Drag-and-drop kanban with per-project boards, saved views and an issue composer that never leaves the keyboard.',
  },
  {
    icon: RefreshCcw02,
    title: 'Cycles',
    body: 'Timeboxed iterations with current and upcoming views, and a burndown that draws itself.',
  },
  {
    icon: Target04,
    title: 'Daily Challenges',
    body: 'A personal board that cuts across every project — what you are doing today, in one place.',
  },
  {
    icon: Users01,
    title: 'Orgs & workspaces',
    body: 'Invite teammates by email, group projects into workspaces and scope roles per organization.',
  },
  {
    icon: Dataflow03,
    title: 'Built for agents',
    body: 'A first-class MCP server: hand Claude or any agent a token and let it file, move and search issues.',
  },
  {
    icon: Mail01,
    title: 'Email that matters',
    body: 'Verification, password resets, invitations and notifications. No digests, no drip campaigns.',
  },
];

export default async function LandingPage() {
  const session = await readSession();
  if (session) redirect('/orgs');

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-50 border-b border-secondary bg-primary/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-6">
          <Wordmark />
          <nav aria-label="Account" className="flex items-center gap-2">
            <ButtonLink href="/login" color="tertiary">
              Log in
            </ButtonLink>
            <ButtonLink href="/register" color="primary">
              Sign up
            </ButtonLink>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero */}
        <section className="relative overflow-hidden">
          {/* Brand glow behind the headline, Linear-style. Decorative. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -top-48 left-1/2 h-[30rem] w-[45rem] -translate-x-1/2 rounded-full bg-brand-solid/15 blur-[10rem]"
          />

          <div className="relative mx-auto w-full max-w-7xl px-6 pt-20 sm:pt-28">
            <div className={ENTER}>
              {/* Pseudo-element grows the hit area to ≥40px without growing the pill. */}
              <Link
                href="#features"
                className="relative inline-flex items-center gap-2 rounded-full bg-secondary py-1 pr-3.5 pl-1 text-sm text-secondary ring-1 ring-white/10 outline-none transition-colors before:absolute before:inset-x-0 before:-inset-y-2 before:content-[''] hover:bg-primary_hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              >
                <span className="rounded-full bg-brand-solid px-2 py-0.5 text-xs font-medium text-white">
                  New
                </span>
                Daily Challenges<span className="hidden sm:inline">&nbsp;— one board across every project</span>
                <ArrowRight aria-hidden="true" className="size-3.5" />
              </Link>
            </div>

            <h1
              className={`mt-6 max-w-3xl text-display-md font-semibold text-balance text-primary sm:text-display-lg ${ENTER} delay-100`}
            >
              Flone is a purpose-built board for planning and shipping
            </h1>

            <p
              className={`mt-6 max-w-xl text-lg text-pretty text-tertiary sm:text-xl ${ENTER} delay-200`}
            >
              A simple, secure kanban tool for small teams. Boards, cycles and daily
              challenges — and nothing you don&rsquo;t need.
            </p>

            <div className={`mt-8 flex flex-wrap items-center gap-3 ${ENTER} delay-300`}>
              <ButtonLink href="/register" color="primary" size="lg">
                Start your board
              </ButtonLink>
              <ButtonLink href="/login" color="secondary" size="lg">
                Log in
              </ButtonLink>
            </div>
          </div>

          {/* Product mockup: pure CSS, no screenshot to keep, nothing to go stale.
              Decorative — the features section says all of this in text. */}
          <div aria-hidden="true" className={`relative mx-auto mt-16 w-full max-w-7xl px-6 sm:mt-20 ${ENTER} delay-500`}>
            <div className="relative [perspective:100rem]">
              {/* Concentric: outer 16px radius − 6px padding = 10px inner. */}
              <div className="origin-top rounded-2xl bg-secondary/60 p-1.5 shadow-2xl ring-1 ring-white/10 [transform:rotateX(3deg)]">
                <div className="overflow-hidden rounded-[10px] bg-primary ring-1 ring-white/10">
                  <div className="flex items-center gap-1.5 border-b border-secondary px-4 py-3">
                    <span className="size-2.5 rounded-full bg-tertiary" />
                    <span className="size-2.5 rounded-full bg-tertiary" />
                    <span className="size-2.5 rounded-full bg-tertiary" />
                    <span className="ml-3 font-mono text-xs text-quaternary">
                      acme / platform / FLN — Cycle 14
                    </span>
                  </div>
                  {/* Two columns fit a phone; the third joins at `sm`. */}
                  <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3">
                    <MockColumn name="Todo" dot="bg-quaternary" count={4}>
                      <MockCard id="FLN-131" title="Empty-state copy for new boards" label="Design" />
                      <MockCard id="FLN-127" title="Rate-limit the invite endpoint" label="Security" />
                    </MockColumn>
                    <MockColumn name="In progress" dot="bg-brand-solid" count={3}>
                      <MockCard id="FLN-124" title="Refile issues across boards" label="Boards" assignee="MK" />
                      <MockCard id="FLN-119" title="Burndown for current cycle" label="Cycles" assignee="AL" />
                    </MockColumn>
                    <MockColumn name="Done" dot="bg-success-solid" count={12} className="max-sm:hidden">
                      <MockCard id="FLN-116" title="Group projects into workspaces" label="Core" done />
                      <MockCard id="FLN-112" title="MCP smoke tests in CI" label="Agents" done />
                    </MockColumn>
                  </div>
                </div>
              </div>
              {/* Fade the mockup into the page the way Linear's hero shot dissolves. */}
              <div className="pointer-events-none absolute inset-x-0 -bottom-px h-32 bg-gradient-to-t from-[var(--color-bg-primary)] to-transparent" />
            </div>
          </div>
        </section>

        {/* Features */}
        <section id="features" className="scroll-mt-16 border-t border-secondary">
          <div className="mx-auto w-full max-w-7xl px-6 py-20 sm:py-24">
            <h2 className="max-w-2xl text-display-xs font-semibold text-balance text-primary sm:text-display-sm">
              Everything a small team needs. Nothing it doesn&rsquo;t.
            </h2>
            <p className="mt-4 max-w-xl text-lg text-pretty text-tertiary">
              No sprawling settings, no plugin marketplace, no seat-math. One tool that
              your whole team — human and otherwise — can drive.
            </p>

            <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map(({ icon: Icon, title, body }) => (
                <li
                  key={title}
                  className="rounded-xl bg-secondary/40 p-6 ring-1 ring-white/5"
                >
                  <span
                    aria-hidden="true"
                    className="grid size-10 place-items-center rounded-lg bg-brand-primary text-brand-secondary"
                  >
                    <Icon className="size-5" />
                  </span>
                  <h3 className="mt-4 text-md font-semibold text-primary">{title}</h3>
                  <p className="mt-1 text-sm text-pretty text-tertiary">{body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Closing CTA */}
        <section className="border-t border-secondary">
          <div className="mx-auto flex w-full max-w-7xl flex-col items-start gap-6 px-6 py-20 sm:py-24">
            <h2 className="text-display-xs font-semibold text-balance text-primary sm:text-display-sm">
              Plan less. Ship more.
            </h2>
            <ButtonLink href="/register" color="primary" size="lg">
              Start your board
            </ButtonLink>
          </div>
        </section>
      </main>

      <footer className="border-t border-secondary">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-8">
          <Wordmark muted />
          <nav aria-label="Footer" className="flex items-center gap-6 text-sm text-tertiary">
            <Link className="rounded-sm outline-none hover:text-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring" href="/login">
              Log in
            </Link>
            <Link className="rounded-sm outline-none hover:text-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring" href="/register">
              Sign up
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}

/** The same letter mark the auth shell uses, sized for a nav bar. */
function Wordmark({ muted = false }: { muted?: boolean }) {
  return (
    <Link
      href="/"
      className="flex items-center gap-2.5 rounded-md outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
    >
      <span
        aria-hidden="true"
        className="grid size-7 place-items-center rounded-lg bg-brand-solid text-sm font-semibold text-white"
      >
        K
      </span>
      <span className={`text-md font-semibold tracking-tight ${muted ? 'text-tertiary' : 'text-primary'}`}>
        Flone
      </span>
    </Link>
  );
}

function MockColumn({
  name,
  dot,
  count,
  className = '',
  children,
}: {
  name: string;
  dot: string;
  count: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-2 ${className}`}>
      <div className="flex items-center gap-2 px-1 text-xs font-medium text-secondary">
        <span className={`size-2 rounded-full ${dot}`} />
        <span className="truncate">{name}</span>
        <span className="text-quaternary">{count}</span>
      </div>
      {children}
    </div>
  );
}

function MockCard({
  id,
  title,
  label,
  assignee,
  done = false,
}: {
  id: string;
  title: string;
  label: string;
  assignee?: string;
  done?: boolean;
}) {
  return (
    <div className="rounded-md bg-secondary/60 p-3 ring-1 ring-white/5">
      <p className="font-mono text-[10px] text-quaternary">{id}</p>
      <p className={`mt-1 truncate text-xs font-medium ${done ? 'text-quaternary line-through' : 'text-secondary'}`}>
        {title}
      </p>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] text-tertiary ring-1 ring-white/10">
          {label}
        </span>
        {assignee ? (
          <span className="grid size-5 place-items-center rounded-full bg-brand-primary text-[9px] font-medium text-brand-secondary">
            {assignee}
          </span>
        ) : null}
      </div>
    </div>
  );
}
