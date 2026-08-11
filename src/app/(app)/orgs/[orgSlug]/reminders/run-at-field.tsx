'use client';

import { useState } from 'react';
import {
  Button,
  Calendar,
  CalendarCell,
  CalendarGrid,
  CalendarGridBody,
  CalendarGridHeader,
  CalendarHeaderCell,
  DateInput,
  DatePicker,
  DateSegment,
  Dialog,
  Group,
  Heading,
  Popover,
} from 'react-aria-components';
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from '@untitledui/icons';
import { CalendarDateTime, getLocalTimeZone, today } from '@internationalized/date';

import { Label } from '@/components/base/input/label';

/**
 * "First send" — a react-aria `DatePicker` with minute granularity.
 *
 * Replaces `<input type="datetime-local">`. The native control renders as a
 * browser widget rather than as part of this app, and its time half is close to
 * unusable: an empty `--:-- --` with no way in but arrow keys or a tiny caret.
 *
 * react-aria is not a new dependency for the sake of this field — it is what
 * every component under `@/components/base` already wraps, which is also why
 * this can reuse that `Label` verbatim: it IS a react-aria `Label`, so it wires
 * itself to the picker through context with no `htmlFor` to keep in sync.
 *
 * WHY THIS IS A CLIENT MODULE AND HOLDS ITS OWN STATE. `ActionForm` restores a
 * rejected submit by writing back through `form.elements`, which only reaches
 * real form controls -- the reason the rest of this page uses native `<select>`s.
 * A react-aria picker cannot be restored that way, so it keeps the value in
 * React state instead, where React 19's post-action form reset cannot touch it.
 * Submitting a reminder with a bad title therefore no longer throws away the
 * date, which the native input did.
 *
 * The value reaches the Server Action through the hidden input below, in the
 * same `YYYY-MM-DDTHH:mm` shape the native control submitted -- so
 * `localDateTimeSchema`, `toInstant` and the action are untouched by this
 * change.
 */

/** 09:00 tomorrow: the overwhelmingly common case, and never in the past. */
function defaultPlaceholder(): CalendarDateTime {
  const tomorrow = today(getLocalTimeZone()).add({ days: 1 });
  return new CalendarDateTime(tomorrow.year, tomorrow.month, tomorrow.day, 9, 0);
}

/**
 * `CalendarDateTime.toString()` includes seconds (`...T09:00:00`), which the
 * action's schema deliberately does not accept. Pad the parts by hand instead:
 * one obvious function beats loosening a validator that is doing its job.
 */
function serialize(value: CalendarDateTime | null): string {
  if (!value) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(value.year).padStart(4, '0')}-${pad(value.month)}-${pad(value.day)}T${pad(value.hour)}:${pad(value.minute)}`;
}

/* -------------------------------------------------------------------------- */
/* Styling — the app's own field tokens, not react-aria's defaults             */
/* -------------------------------------------------------------------------- */

const GROUP =
  'flex min-h-9 w-full items-center gap-1 rounded-lg border border-primary bg-primary px-3 py-2 text-sm text-primary shadow-xs transition-colors hover:bg-primary_hover focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus-ring';

/** Each segment is its own tab stop, so the focus ring has to sit on it. */
const SEGMENT =
  'rounded px-0.5 tabular-nums caret-transparent outline-none focus:bg-brand-solid focus:text-white data-[placeholder]:text-placeholder data-[type=literal]:px-0 data-[type=literal]:text-tertiary';

/**
 * `text-quaternary` is this theme's muted text. `text-disabled` reads better but
 * is not a token here, and Tailwind v4 drops an unknown utility silently -- the
 * past dates would have looked identical to the selectable ones.
 */
const CELL =
  'flex size-9 cursor-default items-center justify-center rounded-md text-sm text-secondary outline-none transition-colors data-[hovered]:bg-secondary data-[selected]:bg-brand-solid data-[selected]:font-medium data-[selected]:text-white data-[unavailable]:text-quaternary data-[disabled]:text-quaternary data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-1 data-[focus-visible]:outline-focus-ring';

const NAV_BUTTON =
  'grid size-8 place-items-center rounded-md text-tertiary outline-none transition-colors hover:bg-secondary hover:text-primary pressed:bg-secondary data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-1 data-[focus-visible]:outline-focus-ring';

export function RunAtField() {
  const [value, setValue] = useState<CalendarDateTime | null>(null);

  return (
    <div className="flex flex-col gap-1.5">
      <DatePicker
        value={value}
        onChange={setValue}
        granularity="minute"
        /* 24-hour, because every other time on this page is rendered 24-hour.
           A picker that says 9:00 PM beside a table that says 21:00 is one
           screen speaking two dialects. */
        hourCycle={24}
        /* The action rejects a first send in the past; saying so here with a
           disabled calendar is kinder than saying it after a round trip. */
        minValue={today(getLocalTimeZone())}
        placeholderValue={defaultPlaceholder()}
        shouldForceLeadingZeros
        className="flex flex-col gap-1.5"
      >
        <Label>First send</Label>

        <Group className={GROUP}>
          <DateInput className="flex flex-1 items-center">
            {(segment) => <DateSegment segment={segment} className={SEGMENT} />}
          </DateInput>
          <Button
            className={`${NAV_BUTTON} size-6 shrink-0`}
            aria-label="Choose a date from the calendar"
          >
            <CalendarIcon className="size-4" aria-hidden="true" />
          </Button>
        </Group>

        <Popover
          placement="bottom start"
          className="rounded-xl bg-primary p-3 shadow-lg ring-1 ring-secondary entering:animate-in entering:fade-in exiting:animate-out exiting:fade-out"
        >
          <Dialog className="outline-none">
            <Calendar className="flex flex-col gap-3">
              <header className="flex items-center justify-between gap-2">
                <Button slot="previous" className={NAV_BUTTON} aria-label="Previous month">
                  <ChevronLeft className="size-4" aria-hidden="true" />
                </Button>
                {/* react-aria fills this with the month and year in the
                    viewer's own locale. */}
                <Heading className="text-sm font-medium text-primary" />
                <Button slot="next" className={NAV_BUTTON} aria-label="Next month">
                  <ChevronRight className="size-4" aria-hidden="true" />
                </Button>
              </header>

              <CalendarGrid className="border-collapse">
                <CalendarGridHeader>
                  {(day) => (
                    <CalendarHeaderCell className="size-9 text-xs font-medium text-tertiary">
                      {day}
                    </CalendarHeaderCell>
                  )}
                </CalendarGridHeader>
                <CalendarGridBody>
                  {(date) => <CalendarCell date={date} className={CELL} />}
                </CalendarGridBody>
              </CalendarGrid>
            </Calendar>
          </Dialog>
        </Popover>
      </DatePicker>

      {/*
       * What the Server Action actually reads.
       *
       * Written to `defaultValue` (the ATTRIBUTE) rather than `value`, for the
       * same reason as `TzOffsetField`: React 19 resets the form once the
       * action settles, and a reset restores each control to its attribute. An
       * inline ref callback re-runs on every render, so the attribute tracks
       * the state above and survives that reset.
       */}
      <input
        type="hidden"
        name="runAt"
        defaultValue=""
        ref={(node) => {
          if (node) node.defaultValue = serialize(value);
        }}
      />
    </div>
  );
}
