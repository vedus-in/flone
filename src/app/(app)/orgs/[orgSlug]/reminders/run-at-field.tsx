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
  DateField,
  DateInput,
  DateSegment,
  Dialog,
  DialogTrigger,
  Heading,
  ListBox,
  ListBoxItem,
  Popover,
} from 'react-aria-components';
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Clock as ClockIcon,
} from '@untitledui/icons';
import {
  CalendarDateTime,
  getLocalTimeZone,
  toCalendarDate,
  today,
  type CalendarDate,
} from '@internationalized/date';

import { formatLocalDateTime, stepClock, typeClockDigit } from '@/lib/reminder-math';

/**
 * "First send" — one field: date segments, hours and minutes, a clock menu and
 * a calendar menu, all inside a single border.
 *
 * NOT BUILT ON `DatePicker`, and that is the load-bearing detail. A `DatePicker`
 * hands a `PopoverContext` down to every `Popover` beneath it, so a second
 * popover nested inside one -- the clock menu -- is captured by the date
 * picker's own state and opens the CALENDAR instead. Nothing about that fails
 * to compile or throws; the wrong menu simply appears.
 *
 * So the pieces are composed by hand and kept as siblings: a `DateField` for the
 * segments, and one `DialogTrigger` per menu. Each button now owns exactly one
 * popover.
 *
 * The TIME half follows the interaction model of openstatusHQ/time-picker (MIT),
 * which the segmented react-aria time input it replaces did not: one two-digit
 * box per unit, digits typed left to right with focus advancing on its own, and
 * arrows that step the value rather than the caret.
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

/** Shared by the calendar and the clock, so the two menus cannot drift apart. */
const POPOVER =
  'rounded-xl bg-primary p-3 shadow-lg ring-1 ring-secondary entering:animate-in entering:fade-in exiting:animate-out exiting:fade-out';

const OPTION =
  'cursor-default rounded-md px-3 py-1.5 text-center text-sm tabular-nums text-secondary outline-none transition-colors data-[hovered]:bg-secondary data-[selected]:bg-brand-solid data-[selected]:font-medium data-[selected]:text-white data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-1 data-[focus-visible]:outline-focus-ring';

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
/* One scrolling column of the clock menu                                      */
/* -------------------------------------------------------------------------- */

function TimeColumn({
  label,
  max,
  value,
  onSelect,
}: {
  label: string;
  max: number;
  value: number;
  onSelect: (next: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);

  /**
   * Opening at 00 and asking someone to scroll to 21 is the thing that makes
   * these menus tiresome, so the current value is centred on open.
   *
   * ONE FRAME LATE, DELIBERATELY. react-aria builds its collection in a second
   * render pass, so at mount the listbox is still empty and there is no selected
   * option to measure -- doing this in a ref callback silently left the hours
   * column sitting at the top, which is exactly the problem it exists to solve.
   *
   * Empty deps, so it runs once per open: the popover unmounts when it closes,
   * and re-centring after each click would yank the list out from under the
   * pointer mid-selection.
   *
   * `scrollTop` rather than `scrollIntoView` -- the latter walks up to the
   * nearest scrollable ancestor and can take the whole page with it.
   */
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;

    let frame = 0;
    let attempts = 0;

    const centre = () => {
      const selected = node.querySelector<HTMLElement>('[aria-selected="true"]');
      // BOTH conditions matter. The option appears a render pass late, and the
      // popover is measured and positioned a frame after THAT -- until it has,
      // the column has no height, is not scrollable, and assigning `scrollTop`
      // silently clamps to 0. Treating "found the option" as success was what
      // left the hours column sitting at the top.
      const ready = selected && node.clientHeight > 0 && node.scrollHeight > node.clientHeight;

      if (ready) {
        node.scrollTop = selected.offsetTop - node.clientHeight / 2 + selected.clientHeight / 2;
        return;
      }

      // Bounded, so a column that never becomes scrollable -- a short list that
      // needs no centring at all -- costs a few frames rather than spinning.
      if (attempts++ < 20) frame = requestAnimationFrame(centre);
    };

    frame = requestAnimationFrame(centre);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="px-2 text-xs font-medium text-tertiary">{label}</span>
      {/*
       * `relative` is load-bearing: `offsetTop` is measured from the nearest
       * POSITIONED ancestor, and without it the option's offset is measured
       * against the popover -- padding, caption and all -- so the column
       * scrolls to the wrong place.
       */}
      <div ref={scroller} className="relative h-48 overflow-y-auto overscroll-contain">
        <ListBox
          aria-label={label}
          selectionMode="single"
          // Clicking the value you are already on should be a no-op, not a way
          // to end up with no time selected at all.
          disallowEmptySelection
          selectedKeys={[String(value)]}
          onSelectionChange={(keys) => {
            const [key] = [...keys];
            if (key !== undefined) onSelect(Number(key));
          }}
          className="flex flex-col gap-px pe-1"
        >
          {Array.from({ length: max + 1 }, (_, unit) => (
            <ListBoxItem key={unit} id={String(unit)} textValue={pad(unit)} className={OPTION}>
              {pad(unit)}
            </ListBoxItem>
          ))}
        </ListBox>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

export function RunAtField() {
  const [value, setValue] = useState<CalendarDateTime | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
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
      {/*
       * A plain span, not `Label`, and a `role="group"` below rather than a
       * `DatePicker`. See the note at the top of this file: react-aria's
       * DatePicker hands a PopoverContext to every Popover beneath it, so the
       * clock button opened the CALENDAR. The two menus are siblings now, and
       * the caption names the group instead of a single control.
       */}
      <span id="run-at-label" className="text-sm font-medium text-secondary">
        First send
      </span>

      <div role="group" aria-labelledby="run-at-label" className={FIELD}>
        <DateField
          aria-label="Date"
          value={value ? toCalendarDate(value) : null}
          onChange={setDate}
          granularity="day"
          minValue={today(getLocalTimeZone())}
          className="shrink-0"
        >
          <DateInput className="flex items-center">
            {(segment) => <DateSegment segment={segment} className={SEGMENT} />}
          </DateInput>
        </DateField>

        <span aria-hidden="true" className={DIVIDER} />

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

        {/* The time's own menu, beside the time. Typing and the arrow keys
            still work -- this is an addition, not a replacement, so it stays
            open while both columns are picked. */}
        <DialogTrigger>
          <Button className={`${NAV_BUTTON} size-6 shrink-0`} aria-label="Choose a time">
            <ClockIcon className="size-4" aria-hidden="true" />
          </Button>
          <Popover placement="bottom" className={POPOVER}>
            <Dialog className="outline-none">
              <div className="flex gap-2">
                <TimeColumn
                  label="Hours"
                  max={HOUR_MAX}
                  value={shown.hour}
                  onSelect={(next) => setTime('hour', next)}
                />
                <TimeColumn
                  label="Minutes"
                  max={MINUTE_MAX}
                  value={shown.minute}
                  onSelect={(next) => setTime('minute', next)}
                />
              </div>
            </Dialog>
          </Popover>
        </DialogTrigger>

        {/* Controlled, unlike the clock: picking a day is the whole errand, so
            the calendar closes behind you rather than sitting over the form. */}
        <DialogTrigger isOpen={calendarOpen} onOpenChange={setCalendarOpen}>
          <Button
            className={`${NAV_BUTTON} ms-auto size-6 shrink-0`}
            aria-label="Choose a date from the calendar"
          >
            <CalendarIcon className="size-4" aria-hidden="true" />
          </Button>
          <Popover placement="bottom end" className={POPOVER}>
            <Dialog className="outline-none">
              <Calendar
                aria-label="Date"
                value={value ? toCalendarDate(value) : null}
                onChange={(date) => {
                  setDate(date);
                  setCalendarOpen(false);
                }}
                minValue={today(getLocalTimeZone())}
                className="flex flex-col gap-3"
              >
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
        </DialogTrigger>
      </div>

      <span className="text-xs text-tertiary">
        24-hour clock. Type, use the arrow keys, or pick from the menus.
      </span>

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
