'use client';

import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
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
import {
  CalendarDateTime,
  getLocalTimeZone,
  toCalendarDate,
  today,
  type CalendarDate,
} from '@internationalized/date';

import { Label } from '@/components/base/input/label';
import { formatLocalDateTime, stepClock, typeClockDigit } from '@/lib/reminder-math';

/**
 * "First send" — one field: date segments, then hours and minutes, then the
 * calendar button, all inside a single border.
 *
 * The date half is react-aria's `DatePicker`, the library everything under
 * `@/components/base` already wraps. The TIME half follows the interaction
 * model of openstatusHQ/time-picker (MIT), which the segmented react-aria time
 * input it replaces did not: one two-digit box per unit, digits typed left to
 * right with focus advancing on its own, and arrows that step the value rather
 * than the caret.
 *
 * PORTED RATHER THAN INSTALLED, deliberately. That component publishes no
 * registry entry -- it is copy-paste by design -- and it is written against
 * shadcn/ui's `Input` and `Label`, neither of which exists in this app. Pulling
 * them in would stand a second design system up beside Untitled UI for the sake
 * of two boxes. What is reproduced here is the BEHAVIOUR, on this app's own
 * field tokens; the arithmetic in `reminder-math.ts` matches its
 * `time-picker-utils.ts` exactly, including the wrap-on-arrow and clamp-on-type
 * asymmetry.
 *
 * Its LAYOUT is deliberately not reproduced. That component stacks a captioned
 * box per unit, which beside an existing date field gave three separate widgets
 * on three baselines at two heights. The units are unlabelled here and sit
 * inside the date field's own border instead, named for assistive tech through
 * `aria-label`.
 *
 * The value stays one `CalendarDateTime`, and reaches the Server Action through
 * the hidden input at the bottom in the same `YYYY-MM-DDTHH:mm` shape the
 * original native control submitted -- so `localDateTimeSchema`, `toInstant` and
 * the action are untouched by any of this.
 */

const HOUR_MAX = 23;
const MINUTE_MAX = 59;

/** The window in which a second digit continues the first rather than restarting. */
const SECOND_DIGIT_MS = 2000;

/** 09:00 tomorrow. Applied on mount, never during render -- see the effect below. */
function defaultValue(): CalendarDateTime {
  const tomorrow = today(getLocalTimeZone()).add({ days: 1 });
  return new CalendarDateTime(tomorrow.year, tomorrow.month, tomorrow.day, 9, 0);
}

const pad = (value: number) => String(value).padStart(2, '0');

/** Empty until the mount effect below has run; the action reads this. */
function serialize(value: CalendarDateTime | null): string {
  return value ? formatLocalDateTime(value) : '';
}

/* -------------------------------------------------------------------------- */
/* Styling — this app's field tokens, not react-aria's or shadcn's defaults    */
/* -------------------------------------------------------------------------- */

/**
 * ONE box holds the date, the time and the calendar button.
 *
 * The first attempt at this hung the two time boxes off the side of the date
 * field as their own bordered controls with their own labels. They were a
 * different height, sat on a different baseline, and read as three unrelated
 * widgets -- because they were. Everything editable now lives inside this one
 * border, so the field looks like the single thing it is, and the heights
 * cannot disagree.
 */
const FIELD =
  'flex min-h-9 items-center gap-1 rounded-lg border border-primary bg-primary px-3 py-2 text-sm text-primary shadow-xs transition-colors hover:bg-primary_hover focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus-ring';

/**
 * Borderless: the field's own border is around all of it. `caret-transparent`
 * because every keystroke is handled, never inserted -- a blinking caret would
 * promise text editing the box does not do.
 */
const TIME_BOX =
  'w-7 rounded bg-transparent p-0 text-center tabular-nums text-primary caret-transparent outline-none focus:bg-brand-solid focus:text-white';

const SEGMENT =
  'rounded px-0.5 tabular-nums caret-transparent outline-none focus:bg-brand-solid focus:text-white data-[placeholder]:text-placeholder data-[type=literal]:px-0 data-[type=literal]:text-tertiary';

/** Hairline between the date and the time, same token as `Separator`. */
const DIVIDER = 'mx-1 h-4 w-px shrink-0 bg-border-secondary';

/**
 * `text-quaternary` is this theme's muted text. `text-disabled` reads better but
 * is not a token here, and Tailwind v4 drops an unknown utility silently -- the
 * past dates would have looked identical to the selectable ones.
 */
const CELL =
  'flex size-9 cursor-default items-center justify-center rounded-md text-sm text-secondary outline-none transition-colors data-[hovered]:bg-secondary data-[selected]:bg-brand-solid data-[selected]:font-medium data-[selected]:text-white data-[unavailable]:text-quaternary data-[disabled]:text-quaternary data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-1 data-[focus-visible]:outline-focus-ring';

const NAV_BUTTON =
  'grid size-8 place-items-center rounded-md text-tertiary outline-none transition-colors hover:bg-secondary hover:text-primary pressed:bg-secondary data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-1 data-[focus-visible]:outline-focus-ring';

/* -------------------------------------------------------------------------- */
/* One two-digit box                                                           */
/* -------------------------------------------------------------------------- */

function TimeBox({
  label,
  value,
  max,
  onChange,
  inputRef,
  onLeftFocus,
  onRightFocus,
}: {
  /** No visible label -- the box sits inside the field, so this names it for AT. */
  label: string;
  value: number;
  max: number;
  onChange: (next: number) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  onLeftFocus?: () => void;
  onRightFocus?: () => void;
}) {
  /** True when the NEXT digit continues this one rather than starting over. */
  const [continuing, setContinuing] = useState(false);

  useEffect(() => {
    if (!continuing) return;
    const timer = setTimeout(() => setContinuing(false), SECOND_DIGIT_MS);
    return () => clearTimeout(timer);
  }, [continuing]);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Tab is the one key that still belongs to the browser.
    if (event.key === 'Tab') return;
    event.preventDefault();

    if (event.key === 'ArrowRight') return onRightFocus?.();
    if (event.key === 'ArrowLeft') return onLeftFocus?.();

    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      setContinuing(false);
      onChange(stepClock(value, event.key === 'ArrowUp' ? 1 : -1, max));
      return;
    }

    if (event.key >= '0' && event.key <= '9') {
      onChange(typeClockDigit(value, Number(event.key), continuing, max));
      // Two digits in, so the unit is finished -- move on without being asked.
      if (continuing) onRightFocus?.();
      setContinuing((previous) => !previous);
    }
  }

  return (
    <input
      ref={inputRef}
      aria-label={label}
      // `tel` + decimal gets the numeric keypad on a phone without the spinner
      // and scroll-wheel behaviour `number` brings.
      type="tel"
      inputMode="decimal"
      value={pad(value)}
      className={TIME_BOX}
      // Every change goes through the key handler; this only silences React's
      // read-only-input warning.
      onChange={() => {}}
      onKeyDown={handleKeyDown}
      onFocus={(event) => event.currentTarget.select()}
    />
  );
}

/* -------------------------------------------------------------------------- */

export function RunAtField() {
  const [value, setValue] = useState<CalendarDateTime | null>(null);
  const hourRef = useRef<HTMLInputElement>(null);
  const minuteRef = useRef<HTMLInputElement>(null);

  /**
   * Filled in on the client, after hydration, and never during render: "tomorrow"
   * depends on the timezone, and a server in UTC would otherwise render a
   * different date from the browser it is hydrating into.
   */
  useEffect(() => {
    setValue((current) => current ?? defaultValue());
  }, []);

  /** Before the effect lands there is no value; show the default's time, not 00:00. */
  const shown = value ?? defaultValue();

  function setTime(part: 'hour' | 'minute', next: number) {
    setValue((current) => (current ?? defaultValue()).set({ [part]: next }));
  }

  function setDate(date: CalendarDate | null) {
    if (!date) return;
    setValue((current) =>
      (current ?? defaultValue()).set({ year: date.year, month: date.month, day: date.day }),
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <DatePicker
        value={value ? toCalendarDate(value) : null}
        onChange={setDate}
        /* Date only. The time is the two boxes inside the same border below. */
        granularity="day"
        minValue={today(getLocalTimeZone())}
        className="flex flex-col gap-1.5"
      >
        <Label>First send</Label>

        <Group className={FIELD}>
          <DateInput className="flex shrink-0 items-center">
            {(segment) => <DateSegment segment={segment} className={SEGMENT} />}
          </DateInput>

          <span aria-hidden="true" className={DIVIDER} />

          {/* Inside the Group deliberately: one border, one focus ring, one
              control as far as the eye is concerned. */}
          <TimeBox
            label="Hours"
            value={shown.hour}
            max={HOUR_MAX}
            onChange={(next) => setTime('hour', next)}
            inputRef={hourRef}
            onRightFocus={() => minuteRef.current?.focus()}
          />
          <span aria-hidden="true" className="text-tertiary">
            :
          </span>
          <TimeBox
            label="Minutes"
            value={shown.minute}
            max={MINUTE_MAX}
            onChange={(next) => setTime('minute', next)}
            inputRef={minuteRef}
            onLeftFocus={() => hourRef.current?.focus()}
          />

          <Button
            className={`${NAV_BUTTON} ms-auto size-6 shrink-0`}
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

      <span className="text-xs text-tertiary">24-hour clock. Arrow keys adjust.</span>

      {/*
       * What the Server Action actually reads.
       *
       * Written to `defaultValue` (the ATTRIBUTE) rather than `value`, for the
       * same reason as `TzOffsetField`: React 19 resets the form once the action
       * settles, and a reset restores each control to its attribute. An inline
       * ref callback re-runs on every render, so the attribute tracks the state
       * above and survives that reset -- a rejected submit keeps the time.
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
