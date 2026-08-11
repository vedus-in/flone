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
 * "First send" — a date field with a calendar, and hours and minutes as two
 * separate boxes.
 *
 * The date half is react-aria's `DatePicker`, the library everything under
 * `@/components/base` already wraps. The TIME half follows the interaction
 * model of openstatusHQ/time-picker (MIT), which the segmented react-aria time
 * input it replaces did not: a labelled two-digit box per unit, digits typed
 * left to right with focus advancing on its own, and arrows that step the value
 * rather than the caret.
 *
 * PORTED RATHER THAN INSTALLED, deliberately. That component publishes no
 * registry entry -- it is copy-paste by design -- and it is written against
 * shadcn/ui's `Input` and `Label`, neither of which exists in this app. Pulling
 * them in would stand a second design system up beside Untitled UI for the sake
 * of two 48px boxes. What is reproduced here is the BEHAVIOUR, on this app's own
 * field tokens; the arithmetic below matches its `time-picker-utils.ts` exactly,
 * including the wrap-on-arrow and clamp-on-type asymmetry.
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

const FIELD =
  'flex min-h-9 items-center gap-1 rounded-lg border border-primary bg-primary px-3 py-2 text-sm text-primary shadow-xs transition-colors hover:bg-primary_hover focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus-ring';

/**
 * `caret-transparent` because every keystroke is handled, never inserted -- a
 * blinking caret would promise text editing the box does not do.
 */
const TIME_BOX =
  'w-12 rounded-lg border border-primary bg-primary px-2 py-2 text-center font-mono text-sm tabular-nums text-primary shadow-xs caret-transparent outline-none transition-colors hover:bg-primary_hover focus:bg-brand-solid focus:text-white';

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

const SUBLABEL = 'text-xs font-medium text-tertiary';

/* -------------------------------------------------------------------------- */
/* One two-digit box                                                           */
/* -------------------------------------------------------------------------- */

function TimeBox({
  id,
  label,
  value,
  max,
  onChange,
  inputRef,
  onLeftFocus,
  onRightFocus,
}: {
  id: string;
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
    <div className="flex flex-col items-center gap-1.5">
      <label htmlFor={id} className={SUBLABEL}>
        {label}
      </label>
      <input
        id={id}
        ref={inputRef}
        // `tel` + decimal gets the numeric keypad on a phone without the
        // spinner and scroll-wheel behaviour `number` brings.
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
    </div>
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
      <div className="flex flex-wrap items-end gap-2">
        <DatePicker
          value={value ? toCalendarDate(value) : null}
          onChange={setDate}
          /* Date only. The time lives in the two boxes beside it, where it can
             carry its own labels -- which is the whole point of the change. */
          granularity="day"
          minValue={today(getLocalTimeZone())}
          className="flex min-w-44 flex-1 flex-col gap-1.5"
        >
          <Label>First send</Label>

          <Group className={FIELD}>
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

        <div className="flex items-end gap-1">
          <TimeBox
            id="reminder-hours"
            label="Hours"
            value={shown.hour}
            max={HOUR_MAX}
            onChange={(next) => setTime('hour', next)}
            inputRef={hourRef}
            onRightFocus={() => minuteRef.current?.focus()}
          />
          <span aria-hidden="true" className="pb-2 text-sm text-tertiary">
            :
          </span>
          <TimeBox
            id="reminder-minutes"
            label="Minutes"
            value={shown.minute}
            max={MINUTE_MAX}
            onChange={(next) => setTime('minute', next)}
            inputRef={minuteRef}
            onLeftFocus={() => hourRef.current?.focus()}
          />
        </div>
      </div>

      <p className="text-xs text-tertiary">
        Type into the boxes, or use the up and down arrows. 24-hour clock.
      </p>

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
