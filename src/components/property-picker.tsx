'use client';

/**
 * Linear-style property popup: a trigger, then a popup holding a filter input
 * ("Change status..." / "Assign to..."), a keyboard hint, and the options with
 * a check on the current one.
 *
 * Built on Base UI's Combobox (already a dependency), which supplies the
 * filtering, highlight, typeahead, Enter-to-select and Escape for free. The
 * popup closes on selection because the selection mode is single.
 *
 * The picker is deliberately dumb: it renders `currentId` from props and calls
 * `onSelect` once. Persistence, optimistic state and error handling belong to
 * the caller -- every current caller runs a Server Action whose revalidation
 * delivers the new value back down as props.
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Combobox } from '@base-ui/react/combobox';
import { Priority } from '@prisma/client';
import type { WorkflowStateType } from '@prisma/client';

import { PriorityIcon, StateIcon } from '@/components/issue-row';
import { useHotkey } from '@/lib/hotkey';
import { PRIORITY_LABEL } from '@/lib/model';
import { cx } from '@/lib/utils/cx';

export type PickerOption = {
  /** The wire value handed to `onSelect`. The empty string is a legal "none". */
  id: string;
  label: string;
  icon?: ReactNode;
  /** Extra classes for the label text, e.g. a priority tone. */
  labelClassName?: string;
  /**
   * Right-aligned column. A single digit is also a shortcut: pressing that key
   * in the filter input selects the option immediately, as Linear does.
   */
  digit?: string;
};

type PropertyPickerProps = {
  options: PickerOption[];
  /** Compared against `PickerOption.id` for the check mark. */
  currentId: string | null;
  /** The filter input's placeholder: "Change status...", "Assign to...". */
  placeholder: string;
  /** Display-only kbd chip beside the input, e.g. "S". */
  shortcutHint?: string;
  /**
   * Bind `shortcutHint` as a page-wide key that opens this picker. Only for a
   * page with one picker per property -- the issue page, not a board of cards.
   */
  hotkey?: boolean;
  onSelect: (id: string) => void;
  /** Trigger content. The trigger itself is a plain button. */
  children: ReactNode;
  triggerClassName?: string;
  ariaLabel: string;
};

const CHECK = 'M3 8.5 6.5 12 13 4.5';

function Check({ on }: { on: boolean }) {
  return on ? (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-3.5 shrink-0 text-brand-secondary">
      <path d={CHECK} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <span aria-hidden="true" className="size-3.5 shrink-0" />
  );
}

export function PropertyPicker({
  options,
  currentId,
  placeholder,
  shortcutHint,
  hotkey = false,
  onSelect,
  children,
  triggerClassName,
  ariaLabel,
}: PropertyPickerProps) {
  const current = useMemo(
    () => options.find((option) => option.id === currentId) ?? null,
    [options, currentId],
  );
  // Controlled solely so the digit shortcut below can dismiss the popup;
  // item clicks and Escape already close it on their own.
  const [open, setOpen] = useState(false);
  useHotkey(hotkey ? shortcutHint : null, useCallback(() => setOpen(true), []));

  return (
    <Combobox.Root
      items={options}
      value={current}
      open={open}
      onOpenChange={setOpen}
      isItemEqualToValue={(a, b) => a.id === b.id}
      itemToStringLabel={(option) => option.label}
      autoHighlight
      onValueChange={(option) => {
        if (option && option.id !== currentId) onSelect(option.id);
      }}
    >
      <Combobox.Trigger
        aria-label={ariaLabel}
        // Board cards live under a drag sensor; opening the picker must not
        // start a drag. Harmless everywhere else.
        onPointerDown={(event) => event.stopPropagation()}
        className={cx(
          'no-native-drag focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring',
          triggerClassName,
        )}
      >
        {children}
      </Combobox.Trigger>

      <Combobox.Portal>
        <Combobox.Positioner side="bottom" align="start" sideOffset={4} className="z-50 outline-none">
          <Combobox.Popup className="w-64 origin-[var(--transform-origin)] rounded-lg border border-secondary_alt bg-elevated shadow-lg outline-none">
            <div className="flex h-10 items-center gap-2 border-b border-secondary_alt px-3">
              <Combobox.Input
                placeholder={placeholder}
                className="min-w-0 flex-1 bg-transparent text-sm text-primary outline-none placeholder:text-tertiary"
                onKeyDown={(event) => {
                  // Linear's digit shortcuts: 0 clears, 1..n pick.
                  if (event.key.length === 1 && event.key >= '0' && event.key <= '9') {
                    const hit = options.find((option) => option.digit === event.key);
                    if (hit) {
                      event.preventDefault();
                      if (hit.id !== currentId) onSelect(hit.id);
                      setOpen(false);
                    }
                  }
                }}
              />
              {shortcutHint ? (
                <kbd className="grid size-5 shrink-0 place-items-center rounded border border-secondary_alt bg-tertiary text-[0.6875rem] font-medium text-tertiary">
                  {shortcutHint}
                </kbd>
              ) : null}
            </div>

            <Combobox.Empty className="px-3 py-2 text-sm text-tertiary empty:hidden">
              No matches.
            </Combobox.Empty>

            <Combobox.List className="max-h-[min(20rem,60dvh)] overflow-y-auto overscroll-contain p-1 empty:hidden">
              {(option: PickerOption) => (
                <Combobox.Item
                  key={option.id}
                  value={option}
                  className="flex cursor-default select-none items-center gap-2.5 rounded-md px-2 py-2 text-sm text-secondary outline-none data-[highlighted]:bg-elevated_hover data-[highlighted]:text-primary md:py-1.5"
                >
                  {option.icon}
                  <span className={cx('min-w-0 flex-1 truncate', option.labelClassName)}>
                    {option.label}
                  </span>
                  <Check on={option.id === currentId} />
                  {option.digit ? (
                    <span className="w-3 shrink-0 text-end text-xs text-tertiary tabular-nums">
                      {option.digit}
                    </span>
                  ) : (
                    <span aria-hidden="true" className="w-3 shrink-0" />
                  )}
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

/* -------------------------------------------------------------------------- */
/* Shared option builders                                                      */
/*                                                                             */
/* The board cards and the issue page offer the same three pickers; building    */
/* the option lists here keeps their icons, digits and ordering identical.      */
/* -------------------------------------------------------------------------- */

const PRIORITY_TONE: Record<Priority, string> = {
  [Priority.URGENT]: 'text-error-primary',
  [Priority.HIGH]: '',
  [Priority.MEDIUM]: '',
  [Priority.LOW]: '',
  [Priority.NONE]: 'text-tertiary',
};

/** Linear's order and digits: No priority 0, then Urgent 1 down to Low 4. */
export function priorityOptions(): PickerOption[] {
  return [Priority.NONE, Priority.URGENT, Priority.HIGH, Priority.MEDIUM, Priority.LOW].map(
    (priority, index) => ({
      id: priority,
      label: PRIORITY_LABEL[priority],
      icon: <PriorityIcon priority={priority} />,
      labelClassName: PRIORITY_TONE[priority],
      digit: String(index),
    }),
  );
}

export function stateOptions(
  states: Array<{ id: string; name: string; type: WorkflowStateType; color: string }>,
): PickerOption[] {
  return states.map((state, index) => ({
    id: state.id,
    label: state.name,
    icon: <StateIcon type={state.type} color={state.color} />,
    digit: index < 9 ? String(index + 1) : undefined,
  }));
}

const AVATAR = 'grid size-5 shrink-0 place-items-center rounded-full';

function pickerInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = Array.from(parts[0])[0] ?? '';
  const last = parts.length > 1 ? (Array.from(parts[parts.length - 1])[0] ?? '') : '';
  return (first + last).toLocaleUpperCase();
}

/** "No assignee" is digit 0, members 1..9, exactly as the status list counts. */
export function assigneeOptions(members: Array<{ id: string; name: string }>): PickerOption[] {
  return [
    {
      id: '',
      label: 'No assignee',
      labelClassName: 'text-tertiary',
      icon: (
        <span aria-hidden="true" className={cx(AVATAR, 'border border-dashed border-secondary text-[0.5625rem] text-tertiary')}>
          &ndash;
        </span>
      ),
      digit: '0',
    },
    ...members.map((member, index) => ({
      id: member.id,
      label: member.name,
      icon: (
        <span aria-hidden="true" className={cx(AVATAR, 'bg-secondary text-[0.5625rem] font-medium text-tertiary')}>
          {pickerInitials(member.name)}
        </span>
      ),
      digit: index < 9 ? String(index + 1) : undefined,
    })),
  ];
}
