'use client';

/**
 * The pick controls: a type-as-you-go search box and the filters beside it.
 *
 * The query string stays the single source of truth -- results are still
 * server-rendered from the URL, so a filtered picker is shareable and correct
 * under back/forward. This component only drives the URL; it fetches nothing and
 * holds no results.
 *
 * The text box keeps its own state and is NEVER re-seeded from props. Feeding
 * the server's value back in would fight the user mid-word every time a
 * navigation landed, and it is also what would steal focus between keystrokes.
 * The selects have no such state: they navigate on change and the server's value
 * is simply what they render as selected.
 */

import { useEffect, useRef, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { PRIORITY_LABEL, PRIORITY_ORDER } from '@/lib/model';
import { cx } from '@/lib/utils/cx';

export type PickerFilters = {
  q: string;
  project: string;
  priority: string;
  tab: string;
  mine: boolean;
};

export type PickerProject = { id: string; name: string; key: string };

export type PickerTab = { id: string; label: string };

/** Typing pause before the URL is rewritten. Long enough not to fire per key. */
const DEBOUNCE_MS = 250;

const CONTROL =
  'h-7 rounded-md border border-secondary bg-secondary_subtle px-2 text-xs text-primary transition-colors hover:border-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring';

/**
 * The board's own project filter, up in the page header. It writes the same
 * `?project=` the picker's select does -- the server scopes the whole page on
 * it, so the two controls can never disagree -- and edits the LIVE URL rather
 * than a filter snapshot, so it preserves whatever search the picker holds.
 */
export function BoardProjectFilter({ projects }: { projects: PickerProject[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();

  return (
    <select
      aria-label="Filter board by project"
      value={search.get('project') ?? ''}
      onChange={(event) => {
        const params = new URLSearchParams(search);
        if (event.target.value) params.set('project', event.target.value);
        else params.delete('project');
        const query = params.toString();
        router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
      }}
      className={CONTROL}
    >
      <option value="">All projects</option>
      {projects.map((project) => (
        <option key={project.id} value={project.id}>
          {project.name} ({project.key})
        </option>
      ))}
    </select>
  );
}

/** Whole-record equality over the five fields. There are no others. */
function sameFilters(a: PickerFilters, b: PickerFilters): boolean {
  return (
    a.q === b.q &&
    a.project === b.project &&
    a.priority === b.priority &&
    a.tab === b.tab &&
    a.mine === b.mine
  );
}

export function ChallengePicker({
  basePath,
  value,
  projects,
  tabs,
}: {
  basePath: string;
  value: PickerFilters;
  projects: PickerProject[];
  tabs: PickerTab[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [text, setText] = useState(value.q);

  /**
   * The filters as they will be once the in-flight navigation lands.
   *
   * A patch cannot merge into `value`: props do not update until the server
   * round-trip completes, so two changes made in quick succession -- unticking
   * "Assigned to me" and then picking a project -- would both build on the same
   * stale snapshot and the first would be silently thrown away.
   *
   * So the pending state lives in a ref that `go` writes SYNCHRONOUSLY, and is
   * re-seeded from props only when the props actually change, which is exactly
   * when a navigation has landed. Re-seeding on every render would reintroduce
   * the bug, because the transition itself renders once while props are stale.
   */
  const live = useRef<PickerFilters>(value);
  const lastProps = useRef<PickerFilters>(value);
  if (!sameFilters(lastProps.current, value)) {
    lastProps.current = value;
    live.current = value;
  }

  function hrefFor(next: PickerFilters): string {
    const params = new URLSearchParams();
    if (next.q) params.set('q', next.q);
    if (next.project) params.set('project', next.project);
    if (next.priority) params.set('priority', next.priority);
    // 'active' is the default the server assumes, so it stays out of the URL.
    if (next.tab && next.tab !== 'active') params.set('tab', next.tab);
    if (next.mine) params.set('mine', '1');
    const query = params.toString();
    return query.length > 0 ? `${basePath}?${query}` : basePath;
  }

  function go(patch: Partial<PickerFilters>): void {
    // Written before navigating, so a second change made before this one lands
    // builds on it rather than on the stale props.
    const next = { ...live.current, ...patch };
    live.current = next;
    // `replace`, not `push`: typing a nine-character search must not bury the
    // page the user came from under nine history entries. `scroll: false` keeps
    // the board above from jumping as results re-render underneath it.
    startTransition(() => router.replace(hrefFor(next), { scroll: false }));
  }

  useEffect(() => {
    // Compared against the PENDING query, not the rendered one, so the effect
    // does not re-fire on the navigation it just caused.
    if (text === live.current.q) return;
    const id = window.setTimeout(() => go({ q: text }), DEBOUNCE_MS);
    return () => window.clearTimeout(id);
    // `go` and `value` are deliberately absent: this effect exists to react to
    // TYPING, and depending on the props it rewrites would re-arm the timer on
    // its own result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const filtered =
    Boolean(value.project) || Boolean(value.priority) || value.tab !== 'active' || value.mine;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <input
            type="search"
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={100}
            autoComplete="off"
            placeholder="Search by title, or paste an issue ID like VED-153"
            aria-label="Search issues to add"
            className={cx(CONTROL, 'w-full pe-8')}
          />
          {pending ? (
            <span
              aria-hidden="true"
              className="absolute end-2.5 top-1/2 size-3.5 -translate-y-1/2 animate-spin rounded-full border-2 border-secondary border-t-transparent"
            />
          ) : null}
        </div>

        <select
          aria-label="Project"
          value={value.project}
          onChange={(event) => go({ project: event.target.value })}
          className={CONTROL}
        >
          <option value="">All projects</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name} ({project.key})
            </option>
          ))}
        </select>

        <select
          aria-label="Priority"
          value={value.priority}
          onChange={(event) => go({ priority: event.target.value })}
          className={CONTROL}
        >
          <option value="">Any priority</option>
          {PRIORITY_ORDER.map((priority) => (
            <option key={priority} value={priority}>
              {PRIORITY_LABEL[priority]}
            </option>
          ))}
        </select>

        <select
          aria-label="Status"
          value={value.tab}
          onChange={(event) => go({ tab: event.target.value })}
          className={CONTROL}
        >
          {tabs.map((tab) => (
            <option key={tab.id} value={tab.id}>
              {tab.label}
            </option>
          ))}
        </select>

        <label className="flex h-7 cursor-pointer items-center gap-2 rounded-md border border-secondary px-2 text-xs text-primary transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-focus-ring">
          <input
            type="checkbox"
            checked={value.mine}
            onChange={(event) => go({ mine: event.target.checked })}
            className="size-3.5 accent-current"
          />
          Assigned to me
        </label>
      </div>

      {text.length > 0 || filtered ? (
        <div>
          <button
            type="button"
            onClick={() => {
              setText('');
              go({ q: '', project: '', priority: '', tab: 'active', mine: false });
            }}
            className="text-xs text-tertiary underline-offset-2 hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          >
            Clear filters
          </button>
        </div>
      ) : null}
    </div>
  );
}
