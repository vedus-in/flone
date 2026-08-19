import type { ReactNode, SelectHTMLAttributes } from 'react';
import { ChevronDown, InfoCircle } from '@untitledui/icons';

import { COLOR_TOKENS, colorClass } from '@/lib/model';
import { cx } from '@/lib/utils/cx';

/**
 * The controls the two settings pages share.
 *
 * Everything here is server-renderable on purpose: the settings pages are
 * Server Components whose only client island is `ActionForm`, and a picker or a
 * switch that shipped its own JavaScript would undo that for the sake of
 * appearance. Selection state is carried by real form controls and painted with
 * `peer-*` variants, so it also works before hydration and submits with the
 * form the way `ActionForm`'s restore-on-error expects.
 */

/* -------------------------------------------------------------------------- */
/* Select                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A native `<select>` with the OS chevron replaced and a caller-set width.
 *
 * Native rather than a listbox for the reason `ActionForm` documents: React 19
 * resets a form once its action settles, and the restore puts values back by
 * writing to `form.elements`, which only reaches real form controls. The width
 * is the caller's because an intrinsically-sized select changes width with the
 * option that happens to be chosen, which is what made the workflow rows jitter
 * from row to row.
 */
export function SettingsSelect({
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={cx('relative inline-block shrink-0', className)}>
      <select
        {...rest}
        className="h-9 w-full appearance-none truncate rounded-lg border border-secondary bg-primary ps-3 pe-8 text-sm text-primary shadow-xs outline-focus-ring transition-colors hover:bg-primary_hover focus-visible:outline-2 focus-visible:outline-offset-1"
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute end-2.5 top-1/2 size-4 -translate-y-1/2 text-quaternary"
      />
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Colour                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The palette as radio buttons.
 *
 * The old control was a `<select>` of the token NAMES -- you picked "purple"
 * from a list of words and found out what it looked like after saving. These
 * are the colours themselves, at a 32px target, with the chosen one ringed
 * rather than merely tinted so it survives a glance.
 *
 * ponytail: a radio group is one of the two things `ActionForm`'s restore does
 * not reach on a failed submit (`form.elements.namedItem` hands back a
 * RadioNodeList, not an element). The name and type it sits next to do restore.
 * Worth wiring up only if colour ever becomes rejectable on its own.
 */
export function ColorSwatches({
  name,
  defaultValue,
  label = 'Colour',
}: {
  name: string;
  defaultValue: string;
  label?: string;
}) {
  return (
    <fieldset className="flex shrink-0 items-center">
      <legend className="visually-hidden">{label}</legend>
      {COLOR_TOKENS.map((token) => (
        <label
          key={token}
          className="grid size-8 cursor-pointer place-items-center rounded-full"
        >
          <input
            type="radio"
            name={name}
            value={token}
            defaultChecked={token === defaultValue}
            aria-label={token}
            className="peer sr-only"
          />
          <span
            aria-hidden="true"
            className={cx(
              'size-4 rounded-full ring-offset-2 ring-offset-primary transition-[box-shadow,transform] duration-100',
              'peer-checked:scale-110 peer-checked:ring-2 peer-checked:ring-fg-primary',
              'peer-focus-visible:ring-2 peer-focus-visible:ring-focus-ring',
              colorClass(token).dot,
            )}
          />
        </label>
      ))}
    </fieldset>
  );
}

/* -------------------------------------------------------------------------- */
/* Switch                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A checkbox wearing a switch.
 *
 * `value` matters: the access switch submits an enum rather than `on`, and
 * pairs this with a hidden input of the opposite value placed AFTER it, so an
 * unchecked box still submits something the action's schema accepts.
 */
export function Switch({
  name,
  value,
  defaultChecked,
  id,
  'aria-label': ariaLabel,
  'aria-describedby': describedBy,
}: {
  name: string;
  value?: string;
  defaultChecked?: boolean;
  id?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
}) {
  return (
    <label className="relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center">
      <input
        id={id}
        type="checkbox"
        name={name}
        value={value}
        defaultChecked={defaultChecked}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className="h-6 w-11 rounded-full bg-tertiary ring-1 ring-secondary transition-colors duration-100 peer-checked:bg-brand-solid peer-checked:ring-transparent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus-ring"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute start-0.5 size-5 rounded-full bg-white shadow-sm transition-transform duration-100 peer-checked:translate-x-5"
      />
    </label>
  );
}

/* -------------------------------------------------------------------------- */
/* Notes and rows                                                              */
/* -------------------------------------------------------------------------- */

/** The blue "there is nothing to do here" note. Not an error, not a warning. */
export function InfoNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-lg bg-brand-primary px-3 py-2.5 text-xs text-brand-secondary ring-1 ring-brand">
      <InfoCircle aria-hidden="true" className="mt-px size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/**
 * One editable line inside a settings card -- a member, a workflow state, a
 * label. Solid, so the dashed "add another" row below it reads as the one thing
 * that is not yet real.
 */
export const ROW_CLASS =
  'flex flex-wrap items-center gap-2 rounded-lg border border-secondary bg-secondary_subtle px-3 py-2';

/**
 * The same line, dashed, for the row that creates a new one. A class rather
 * than a component because every use of it IS the `<form>` that creates the
 * thing -- wrapping those in a div would add a layer for nothing.
 */
export const NEW_ROW_CLASS =
  'flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-secondary px-3 py-2';

export function SettingsRow({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx(ROW_CLASS, className)}>{children}</div>
  );
}

/**
 * The one destructive-action treatment, used by both pages.
 *
 * The confirm stays behind a `<details>` rather than becoming a one-click
 * button: the type-the-name gate is the only thing standing between a stray
 * click and everything in an organization, and a redesign is not a reason to
 * lower it. The summary is styled as the outline button the design asks for.
 */
export function DangerZone({
  title,
  description,
  buttonLabel,
  children,
}: {
  title: string;
  description: ReactNode;
  buttonLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-primary p-5 shadow-xs ring-1 ring-error_subtle">
      <h2 className="text-md font-semibold text-error-primary">{title}</h2>
      <p className="max-w-prose text-sm text-tertiary">{description}</p>
      <details className="group flex flex-col gap-4">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-2 rounded-lg border border-error px-3 py-2 text-sm font-semibold text-error-primary transition-colors outline-focus-ring hover:bg-error-primary focus-visible:outline-2 focus-visible:outline-offset-2">
          {buttonLabel}
          <ChevronDown
            aria-hidden="true"
            className="size-4 transition-transform duration-100 group-open:rotate-180"
          />
        </summary>
        <div className="pt-4">{children}</div>
      </details>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/** First letters of the first two words, for an avatar with no image. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return parts
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');
}
