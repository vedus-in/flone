import { cycleProgress, DAY_MS } from '@/lib/cycle-math';

/**
 * Cycle progress, drawn by hand in SVG.
 *
 * No charting library. This is one filled area and one dashed line over a fixed
 * grid: a dependency for it would be several hundred kilobytes and a client
 * bundle to render something that is fifty lines of arithmetic and stays a
 * Server Component.
 *
 * The filled area is issues COMPLETED over time; the dashed diagonal is the
 * ideal pace from nothing to the full scope. Where the area sits above the line,
 * the cycle is ahead.
 *
 * Scope is an issue count, not story points -- estimates are out of scope, and
 * counting canceled issues either way would misdraw the chart, so they are
 * excluded upstream in `loadCycleProgress`.
 */

const WIDTH = 260;
const HEIGHT = 96;
const PAD = 4;

export function Burndown({
  scope,
  completions,
  startsAt,
  endsAt,
  now,
}: {
  scope: number;
  completions: Date[];
  startsAt: Date;
  endsAt: Date;
  now: Date;
}) {
  const span = Math.max(1, endsAt.getTime() - startsAt.getTime());
  const elapsed = cycleProgress({ startsAt, endsAt }, now);
  const ceiling = Math.max(scope, completions.length, 1);

  const x = (at: number) => PAD + ((at - startsAt.getTime()) / span) * (WIDTH - PAD * 2);
  const y = (count: number) => HEIGHT - PAD - (count / ceiling) * (HEIGHT - PAD * 2);

  // One point per completion, in order, so the line steps exactly where work
  // actually landed rather than being smoothed into a daily average.
  const ordered = [...completions].sort((a, b) => a.getTime() - b.getTime());
  const points: Array<[number, number]> = [[x(startsAt.getTime()), y(0)]];
  ordered.forEach((at, index) => {
    const clamped = Math.min(Math.max(at.getTime(), startsAt.getTime()), endsAt.getTime());
    // Step: hold the old level to the moment of completion, then rise.
    points.push([x(clamped), y(index)]);
    points.push([x(clamped), y(index + 1)]);
  });
  const nowX = x(Math.min(now.getTime(), endsAt.getTime()));
  points.push([nowX, y(ordered.length)]);

  const line = points.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
  const area = `${line} ${nowX.toFixed(1)},${(HEIGHT - PAD).toFixed(1)} ${PAD},${(HEIGHT - PAD).toFixed(1)}`;

  const dayCount = Math.max(1, Math.round(span / DAY_MS));

  return (
    <figure className="flex flex-col gap-1.5">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full"
        role="img"
        aria-label={`${completions.length} of ${scope} issues completed, ${Math.round(elapsed * 100)}% through the cycle`}
      >
        {/* Baseline and ceiling, so the eye has something to measure against. */}
        <line
          x1={PAD}
          y1={HEIGHT - PAD}
          x2={WIDTH - PAD}
          y2={HEIGHT - PAD}
          className="stroke-border-secondary"
          strokeWidth="1"
        />

        {/* The ideal pace: nothing on day one, the whole scope at the end. */}
        <line
          x1={x(startsAt.getTime())}
          y1={y(0)}
          x2={x(endsAt.getTime())}
          y2={y(scope)}
          className="stroke-fg-quaternary"
          strokeWidth="1"
          strokeDasharray="3 3"
          opacity="0.7"
        />

        <polygon points={area} className="fill-warning-solid" opacity="0.18" />
        <polyline
          points={line}
          fill="none"
          className="stroke-warning-solid"
          strokeWidth="1.75"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* Where we are now. */}
        <circle cx={nowX} cy={y(ordered.length)} r="2.5" className="fill-warning-solid" />
      </svg>

      <figcaption className="flex items-center justify-between text-[0.6875rem] text-tertiary tabular-nums">
        <span>{formatDay(startsAt)}</span>
        <span>
          {dayCount} {dayCount === 1 ? 'day' : 'days'}
        </span>
        <span>{formatDay(endsAt)}</span>
      </figcaption>
    </figure>
  );
}

const DAY = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' });

function formatDay(value: Date): string {
  return DAY.format(value);
}
