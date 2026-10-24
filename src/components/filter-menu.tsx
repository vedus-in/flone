'use client';

import type { Priority } from '@prisma/client';
import {
  Button as AriaButton,
  SubmenuTrigger as AriaSubmenuTrigger,
} from 'react-aria-components';

import { Dropdown } from '@/components/base/dropdown/dropdown';
import { IconFilter } from '@/components/icons';
import { Assignee, PriorityIcon } from '@/components/issue-row';
import { colorClass } from '@/lib/model';
import { cx } from '@/lib/utils/cx';

/**
 * Linear's "Filter" button: a menu of fields, each opening a submenu of values.
 *
 * Every value is a LINK the server built -- the query string with that one
 * filter changed -- so picking one is a plain navigation and the URL stays the
 * whole filter state, exactly as the old row of selects had it. Picking the
 * active value again clears it.
 */

export type FilterGlyph =
  | { type: 'priority'; value: Priority }
  | { type: 'dot'; color: string }
  | { type: 'square'; color: string }
  | { type: 'person'; name: string | null };

export type FilterOption = {
  id: string;
  label: string;
  href: string;
  active: boolean;
  glyph?: FilterGlyph;
};

export type FilterGroup = { id: string; label: string; options: FilterOption[] };

function Glyph({ glyph }: { glyph: FilterGlyph }) {
  switch (glyph.type) {
    case 'priority':
      return <PriorityIcon priority={glyph.value} />;
    case 'person':
      return <Assignee name={glyph.name} size="xs" />;
    case 'dot':
      return <span aria-hidden="true" className={cx('mx-1 size-2 shrink-0 rounded-full', colorClass(glyph.color).dot)} />;
    case 'square':
      return <span aria-hidden="true" className={cx('mx-1 size-2 shrink-0 rounded-[2px]', colorClass(glyph.color).dot)} />;
  }
}

export function FilterMenu({ groups, activeCount }: { groups: FilterGroup[]; activeCount: number }) {
  return (
    <Dropdown.Root>
      <AriaButton
        className={cx(
          'flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors outline-focus-ring hover:bg-secondary hover:text-primary focus-visible:outline-2',
          activeCount > 0 ? 'text-primary' : 'text-tertiary',
        )}
      >
        <IconFilter className="size-3.5" />
        Filter
        {activeCount > 0 ? (
          <span className="grid h-4 min-w-4 place-items-center rounded-full bg-brand-solid px-1 text-[0.625rem] text-white tabular-nums">
            {activeCount}
          </span>
        ) : null}
      </AriaButton>
      <Dropdown.Popover placement="bottom end" className="w-56">
        <Dropdown.Menu aria-label="Filter by">
          {groups.map((group) => (
            <AriaSubmenuTrigger key={group.id}>
              <Dropdown.Item id={group.id} textValue={group.label}>
                {group.label}
              </Dropdown.Item>
              <Dropdown.Popover placement="end top" className="max-h-80 w-60">
                <Dropdown.Menu aria-label={group.label}>
                  {group.options.map((option) => (
                    <Dropdown.Item key={option.id} id={option.id} href={option.href} textValue={option.label}>
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        {option.glyph ? <Glyph glyph={option.glyph} /> : null}
                        <span className="truncate">{option.label}</span>
                        {option.active ? (
                          <svg viewBox="0 0 16 16" fill="none" aria-label="Selected" className="ms-auto size-3.5 shrink-0 text-primary">
                            <path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        ) : null}
                      </span>
                    </Dropdown.Item>
                  ))}
                </Dropdown.Menu>
              </Dropdown.Popover>
            </AriaSubmenuTrigger>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}
