import type { ReactNode } from 'react';

/**
 * Decorative product mockups for the landing page — the app drawn in
 * HTML/CSS instead of screenshots, so nothing goes stale and nothing is
 * fetched. Every export is `aria-hidden` at the call site: the prose around
 * them carries the information.
 *
 * Palette discipline: the page is near-monochrome. Surfaces separate with
 * white-alpha rings and shadows, never gray borders (which read as dirt on a
 * near-black page); the only chroma is tiny status dots.
 */

const CARD = 'rounded-xl bg-secondary shadow-2xl ring-1 ring-white/10';

function Dot({ className }: { className: string }) {
  return <span className={`inline-block size-1.5 shrink-0 rounded-full ${className}`} />;
}

function Avatar({ initials, agent = false }: { initials: string; agent?: boolean }) {
  return (
    <span
      className={`grid size-4.5 shrink-0 place-items-center rounded-full text-[9px] font-medium ${
        agent ? 'bg-brand-primary text-brand-secondary' : 'bg-white/10 text-tertiary'
      }`}
    >
      {initials}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Hero: the app itself — sidebar, issue view, meta rail, agent chat.  */
/* ------------------------------------------------------------------ */

function SideItem({
  label,
  active = false,
  indent = false,
}: {
  label: string;
  active?: boolean;
  indent?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-2 rounded-md px-2 py-1 text-[11px] ${indent ? 'ml-4' : ''} ${
        active ? 'bg-white/5 text-secondary' : 'text-quaternary'
      }`}
    >
      {label}
    </div>
  );
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] tracking-wide text-quaternary uppercase">{label}</span>
      <span className="flex items-center gap-1.5 text-xs text-secondary">{children}</span>
    </div>
  );
}

export function HeroAppMockup() {
  return (
    <div className="relative">
      {/* Concentric: 16px frame − 6px padding = 10px window. */}
      <div className="rounded-2xl bg-white/[0.04] p-1.5 shadow-2xl ring-1 ring-white/10">
        <div className="overflow-hidden rounded-[10px] bg-primary ring-1 ring-white/10">
          <div className="flex items-center gap-1.5 border-b border-white/5 px-4 py-2.5">
            <span className="size-2.5 rounded-full bg-white/10" />
            <span className="size-2.5 rounded-full bg-white/10" />
            <span className="size-2.5 rounded-full bg-white/10" />
            <span className="ml-3 font-mono text-[11px] text-quaternary">acme / platform / FLN-124</span>
          </div>

          <div className="grid md:grid-cols-[190px_minmax(0,1fr)] lg:grid-cols-[190px_minmax(0,1fr)_216px]">
            <aside className="hidden flex-col gap-0.5 border-r border-white/5 px-3 py-4 md:flex">
              <div className="mb-3 flex items-center gap-2 px-2">
                <span className="grid size-5 place-items-center rounded-md bg-brand-solid text-[10px] font-semibold text-white">
                  K
                </span>
                <span className="text-xs font-medium text-secondary">Flone</span>
              </div>
              <SideItem label="Daily Challenges" />
              <div className="mt-3 mb-1 px-2 text-[10px] tracking-wide text-quaternary uppercase">Platform</div>
              <SideItem label="FLN Web" active />
              <SideItem label="Issues" active indent />
              <SideItem label="Cycles" indent />
              <SideItem label="Boards" indent />
              <SideItem label="Views" indent />
              <div className="mt-3 mb-1 px-2 text-[10px] tracking-wide text-quaternary uppercase">Ops</div>
              <SideItem label="OPS Infra" />
              <div className="mt-6 px-2 text-[11px] text-quaternary">Invite teammates</div>
            </aside>

            <section className="px-6 py-5">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-sm font-semibold text-primary">Faster board rendering</h3>
                <span className="font-mono text-[11px] text-quaternary">FLN-124</span>
              </div>
              <p className="mt-2 max-w-md text-xs leading-relaxed text-tertiary">
                Columns repaint on every drag. Render the moved card first and reconcile the rest of
                the column when the drop commits.
              </p>

              <div className="mt-5 text-[10px] font-medium tracking-wide text-quaternary uppercase">Activity</div>
              <div className="mt-2 flex flex-col gap-1.5 text-[11px] text-quaternary">
                <span className="flex items-center gap-2">
                  <Avatar initials="M" /> mira created the issue · 2h
                </span>
                <span className="flex items-center gap-2">
                  <Dot className="bg-white/20" /> Performance label added · 2h
                </span>
              </div>

              <div className="mt-3 flex flex-col gap-2">
                <div className="rounded-lg bg-white/[0.02] p-3 ring-1 ring-white/5">
                  <div className="flex items-center gap-2 text-[11px] text-quaternary">
                    <Avatar initials="J" /> jon · 1h
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-secondary">
                    Drags feel heavy on big boards — the whole column flashes while the card settles.
                  </p>
                </div>
                <div className="rounded-lg bg-white/[0.02] p-3 ring-1 ring-white/5">
                  <div className="flex items-center gap-2 text-[11px] text-quaternary">
                    <Avatar initials="M" /> mira · 12m
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-secondary">@flone-agent can you take a stab at this?</p>
                </div>
              </div>

              <div className="mt-3 flex items-center gap-2 pb-10 text-[11px] text-quaternary sm:pb-14">
                <Dot className="bg-brand-solid" /> flone-agent moved Todo → In progress · just now
              </div>
            </section>

            <aside className="hidden flex-col gap-4 border-l border-white/5 px-4 py-5 lg:flex">
              <MetaRow label="Status">
                <Dot className="bg-brand-solid" /> In progress
              </MetaRow>
              <MetaRow label="Priority">High</MetaRow>
              <MetaRow label="Assignee">
                <Avatar initials="ai" agent /> flone-agent
              </MetaRow>
              <MetaRow label="Cycle">
                Cycle 14
              </MetaRow>
              <MetaRow label="Label">
                <Dot className="bg-success-solid" /> Performance
              </MetaRow>
            </aside>
          </div>
        </div>
      </div>

      {/* Floating agent session, Linear-style, above the fade. */}
      <div className={`absolute right-6 -bottom-8 z-10 hidden w-80 p-4 sm:block ${CARD}`}>
        <div className="flex items-center gap-2">
          <Avatar initials="ai" agent />
          <span className="text-xs font-medium text-secondary">flone-agent</span>
          <span className="rounded-sm bg-white/10 px-1.5 py-0.5 text-[10px] text-tertiary">MCP</span>
        </div>
        <p className="mt-3 text-[11px] text-quaternary">mira connected FLN-124</p>
        <p className="mt-1.5 text-xs text-secondary">Profiling the drag path…</p>
        <p className="mt-1.5 text-[11px] text-quaternary">Thinking…</p>
        <div className="mt-8 rounded-lg bg-white/[0.03] px-3 py-2 text-[11px] text-quaternary ring-1 ring-white/10">
          Tell the agent what to do next…
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 -bottom-px h-24 bg-gradient-to-t from-[var(--color-bg-primary)] to-transparent" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 1.0 Track: dimmed board + floating Daily Challenges card.           */
/* ------------------------------------------------------------------ */

function BoardCard({ id, title, label }: { id: string; title: string; label: string }) {
  return (
    <div className="rounded-md bg-white/[0.02] p-2.5 ring-1 ring-white/5">
      <p className="font-mono text-[10px] text-quaternary">{id}</p>
      <p className="mt-0.5 truncate text-[11px] font-medium text-secondary">{title}</p>
      <span className="mt-1.5 inline-block rounded-full bg-white/5 px-1.5 py-0.5 text-[9px] text-quaternary">
        {label}
      </span>
    </div>
  );
}

function BoardColumn({
  name,
  count,
  dot,
  children,
  className = '',
}: {
  name: string;
  count: number;
  dot: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-2 ${className}`}>
      <div className="flex items-center gap-2 px-1 text-[11px] font-medium text-tertiary">
        <Dot className={dot} />
        <span className="truncate">{name}</span>
        <span className="text-quaternary tabular-nums">{count}</span>
      </div>
      {children}
    </div>
  );
}

export function TrackVisual() {
  return (
    <div className="relative">
      <div className="grid grid-cols-2 gap-3 opacity-60 sm:grid-cols-4 sm:pl-44 lg:pl-56">
        <BoardColumn name="Backlog" count={12} dot="bg-white/20" className="max-sm:hidden">
          <BoardCard id="FLN-131" title="Empty-state copy" label="Design" />
          <BoardCard id="FLN-129" title="Slow query on views" label="Perf" />
        </BoardColumn>
        <BoardColumn name="Todo" count={7} dot="bg-quaternary">
          <BoardCard id="FLN-127" title="Rate-limit invites" label="Security" />
          <BoardCard id="FLN-125" title="Cycle rollover copy" label="Cycles" />
        </BoardColumn>
        <BoardColumn name="In progress" count={3} dot="bg-brand-solid">
          <BoardCard id="FLN-124" title="Faster board rendering" label="Perf" />
          <BoardCard id="FLN-119" title="Burndown tooltips" label="Cycles" />
        </BoardColumn>
        <BoardColumn name="Done" count={41} dot="bg-success-solid" className="max-sm:hidden">
          <BoardCard id="FLN-116" title="Workspace grouping" label="Core" />
          <BoardCard id="FLN-112" title="MCP smoke tests" label="Agents" />
        </BoardColumn>
      </div>

      <div className={`top-6 left-0 mt-6 w-full max-w-xs p-4 sm:absolute sm:mt-0 ${CARD}`}>
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-semibold text-primary">Daily Challenges</span>
          <span className="text-[11px] text-quaternary">Sat, Aug 9</span>
        </div>
        <div className="mt-3 flex flex-col gap-2">
          {[
            { id: 'FLN-127', title: 'Rate-limit invites', done: true },
            { id: 'OPS-88', title: 'Rotate agent tokens', done: true },
            { id: 'FLN-131', title: 'Empty-state copy', done: false },
          ].map((row) => (
            <div key={row.id} className="flex items-center gap-2.5">
              <span
                className={`grid size-3.5 place-items-center rounded-sm text-[9px] ring-1 ${
                  row.done ? 'bg-brand-solid text-white ring-transparent' : 'ring-white/20'
                }`}
              >
                {row.done ? '✓' : ''}
              </span>
              <span className={`text-xs ${row.done ? 'text-quaternary line-through' : 'text-secondary'}`}>
                {row.title}
              </span>
              <span className="ml-auto font-mono text-[10px] text-quaternary">{row.id}</span>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11px] text-quaternary">2 of 3 · across 2 projects</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 2.0 Plan: timeline + floating cycle card with burndown.             */
/* ------------------------------------------------------------------ */

function TimelineBar({ label, left, width, active = false }: { label: string; left: string; width: string; active?: boolean }) {
  return (
    <div
      className={`absolute flex h-6 items-center rounded-md px-2.5 text-[10px] ring-1 ${
        active ? 'bg-brand-primary text-brand-secondary ring-transparent' : 'bg-white/[0.04] text-tertiary ring-white/10'
      }`}
      style={{ left, width }}
    >
      <span className="truncate">{label}</span>
    </div>
  );
}

export function PlanVisual() {
  return (
    <div className="relative">
      <div className="opacity-60 sm:pr-80">
        <div className="grid grid-cols-5 text-[10px] tracking-wide text-quaternary uppercase">
          {['May', 'Jun', 'Jul', 'Aug', 'Sep'].map((m) => (
            <span key={m} className="border-l border-white/5 pb-3 pl-2">
              {m}
            </span>
          ))}
        </div>
        <div className="relative h-40 border-t border-white/5">
          <div className="pointer-events-none absolute inset-0 grid grid-cols-5">
            {['May', 'Jun', 'Jul', 'Aug', 'Sep'].map((m) => (
              <span key={m} className="border-l border-white/5" />
            ))}
          </div>
          <div className="absolute inset-x-0 top-6">
            <TimelineBar label="UI refresh" left="8%" width="30%" />
          </div>
          <div className="absolute inset-x-0 top-16">
            <TimelineBar label="Cycle 14" left="52%" width="18%" active />
          </div>
          <div className="absolute inset-x-0 top-26">
            <TimelineBar label="Mobile beta" left="64%" width="28%" />
          </div>
        </div>
      </div>

      <div className={`top-2 right-0 mt-6 w-full max-w-xs p-4 sm:absolute sm:mt-0 ${CARD}`}>
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-semibold text-primary">Cycle 14</span>
          <span className="text-[11px] text-quaternary">Jul 28 – Aug 8</span>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          {[
            ['Scope', '34'],
            ['Done', '26'],
            ['At risk', '2'],
          ].map(([label, n]) => (
            <div key={label} className="rounded-md bg-white/[0.03] py-2 ring-1 ring-white/5">
              <div className="text-sm font-semibold text-primary tabular-nums">{n}</div>
              <div className="text-[10px] text-quaternary">{label}</div>
            </div>
          ))}
        </div>
        <svg viewBox="0 0 256 64" className="mt-3 w-full" fill="none">
          <path d="M4 6 L252 58" stroke="currentColor" strokeDasharray="3 4" className="text-white/15" />
          {/* `text-brand-solid` doesn't exist in the text namespace — the
              token lives under bg-*; reference the variable directly so the
              line matches the status dots. */}
          <path
            d="M4 6 L64 16 L110 22 L166 42 L212 50 L252 54"
            stroke="var(--color-bg-brand-solid)"
            strokeWidth="1.5"
          />
        </svg>
        <p className="mt-1 text-[11px] text-quaternary">Burndown · updates itself</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 3.0 Agents: MCP session log + assign popover.                       */
/* ------------------------------------------------------------------ */

export function AgentsVisual() {
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_264px]">
      <div className={`p-5 ${CARD}`}>
        <div className="flex items-center gap-2">
          <Avatar initials="cc" agent />
          <span className="text-xs font-medium text-secondary">Claude Code</span>
          <span className="rounded-sm bg-white/10 px-1.5 py-0.5 text-[10px] text-tertiary">Agent</span>
          <span className="ml-auto font-mono text-[10px] text-quaternary">token fln_…9b2</span>
        </div>
        <div className="mt-4 flex flex-col gap-1.5 font-mono text-[11px] leading-relaxed">
          <p className="text-secondary">&gt; search_tickets &quot;drag performance&quot;</p>
          <p className="pl-3 text-quaternary">2 matches · FLN-119, FLN-124</p>
          <p className="text-secondary">&gt; move_ticket FLN-124 &quot;In progress&quot;</p>
          <p className="text-secondary">&gt; create_comment FLN-124 &quot;Repro found — fix incoming.&quot;</p>
          <p className="pt-1 text-tertiary">✓ 3 actions · scoped to its own membership</p>
        </div>
      </div>

      <div className={`p-2 ${CARD}`}>
        <div className="rounded-lg bg-white/[0.03] px-3 py-2 text-[11px] text-quaternary ring-1 ring-white/10">
          Assign to…
        </div>
        <div className="mt-2 flex flex-col">
          {[
            { name: 'Claude Code', initials: 'cc', agent: true, checked: true },
            { name: 'Mira Khan', initials: 'MK', agent: false, checked: false },
            { name: 'Jon Tate', initials: 'JT', agent: false, checked: false },
            { name: 'Codex', initials: 'cx', agent: true, checked: false },
          ].map((row) => (
            <div key={row.name} className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-xs text-secondary first:bg-white/5">
              <Avatar initials={row.initials} agent={row.agent} />
              {row.name}
              {row.agent ? (
                <span className="rounded-sm bg-white/10 px-1.5 py-0.5 text-[10px] text-tertiary">Agent</span>
              ) : null}
              {row.checked ? <span className="ml-auto text-[11px] text-quaternary">✓</span> : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pillar illustrations: monoline isometric wireframes.                */
/* ------------------------------------------------------------------ */

const FIG = 'h-40 w-auto text-tertiary/50';
const STROKE = { fill: 'none', stroke: 'currentColor', strokeWidth: 1, strokeLinejoin: 'round' as const };

/** Stacked slabs with a floating lid — "purpose-built", layers of one thing. */
export function FigStack() {
  return (
    <svg viewBox="0 0 200 200" className={FIG}>
      {[132, 116, 100, 84].map((y) => (
        <g key={y}>
          <path {...STROKE} d={`M100 ${y - 24} L156 ${y} L100 ${y + 24} L44 ${y} Z`} />
          <path {...STROKE} d={`M44 ${y} v10 L100 ${y + 34} L156 ${y + 10} V${y}`} />
        </g>
      ))}
      <path {...STROKE} d="M100 26 L156 50 L100 74 L44 50 Z" />
      <path {...STROKE} d="M44 50 v8 L100 82 L156 58 V50" />
      <ellipse {...STROKE} cx="100" cy="50" rx="24" ry="10" />
    </svg>
  );
}

/** A cluster of cubes — humans and agents working the same objects. */
export function FigCubes() {
  const cube = (x: number, y: number, s: number) =>
    [
      `M${x} ${y - s / 2} L${x + s} ${y} L${x} ${y + s / 2} L${x - s} ${y} Z`,
      `M${x - s} ${y} v${s * 0.9} L${x} ${y + s / 2 + s * 0.9} L${x + s} ${y + s * 0.9} V${y}`,
      `M${x} ${y + s / 2} v${s * 0.9}`,
    ] as const;
  const cubes = [cube(78, 62, 34), cube(140, 84, 26), cube(64, 122, 26), cube(122, 138, 32)];
  return (
    <svg viewBox="0 0 200 200" className={FIG}>
      {cubes.map((paths, i) => (
        <g key={i}>
          {paths.map((d, j) => (
            <path key={j} {...STROKE} d={d} />
          ))}
        </g>
      ))}
    </svg>
  );
}

/** Fanned panels over thin ribs — noise compressed into order, speed. */
export function FigPanels() {
  return (
    <svg viewBox="0 0 200 200" className={FIG}>
      {Array.from({ length: 10 }, (_, i) => 34 + i * 9).map((x, i) => (
        <path key={x} {...STROKE} d={`M${x} ${150 - i * 2} l14 8 v${16 + i * 2} l-14 -8 Z`} />
      ))}
      {[132, 148, 164].map((x, i) => (
        <path
          key={x}
          {...STROKE}
          d={`M${x} ${66 - i * 10} l16 9 v${72 + i * 6} l-16 -9 Z`}
        />
      ))}
    </svg>
  );
}
