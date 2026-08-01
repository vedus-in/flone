import type { ComponentProps, HTMLAttributes, ReactNode } from 'react';
import NextLink from 'next/link';
import { buttonVariants, type ButtonVariants } from '@heroui/react/button';
import { Chip, type ChipVariants } from '@heroui/react/chip';
import { Label } from '@heroui/react/label';

/**
 * Shared presentational primitives, rebuilt on HeroUI v3.
 *
 * These are deliberately server-safe: no hooks, no event handlers, no
 * `'use client'`. HeroUI's own component modules each carry `'use client'`, so
 * they can be rendered straight from a Server Component and these wrappers can
 * too. Nothing here holds logic worth testing -- it is layout and token plumbing.
 *
 * The rule of thumb for what belongs in this file: something the app needs that
 * HeroUI does not ship (`Prose`, `FormError`, `PageHeader`), or a HeroUI
 * component re-exported so call sites have ONE import site. Anything richer --
 * `Card.Header`, `TextField`, `Select`, `Modal` -- is imported from
 * `@heroui/react` directly at the call site.
 *
 * `SubmitButton` is the one client primitive; it lives in its own `'use client'`
 * module and is re-exported here.
 */
export { SubmitButton } from './submit-button';

/**
 * Straight re-exports. `Button` is HeroUI's: it forwards `type`, so
 * `<Button type="submit">` inside `<form action={serverAction}>` submits and the
 * action receives the FormData. `TextField` is the field wrapper -- remember
 * that `value` / `defaultValue` belong on `TextField`, while `name` belongs on
 * the `Input` / `Textarea` inside it.
 */
export { Button } from '@heroui/react/button';
export { Card } from '@heroui/react/card';
export { Input } from '@heroui/react/input';
export { Separator } from '@heroui/react/separator';
export { TextField } from '@heroui/react/textfield';
export { Label };
/**
 * HeroUI spells it `TextArea`; the rest of this app has always spelled it
 * `Textarea`. Aliased rather than renamed so no call site has to care.
 */
export { TextArea, TextArea as Textarea } from '@heroui/react/textarea';

export type ButtonVariant = NonNullable<ButtonVariants['variant']>;
export type ButtonSize = NonNullable<ButtonVariants['size']>;

function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

/* -------------------------------------------------------------------------- */
/* Navigation                                                                  */
/* -------------------------------------------------------------------------- */

type ButtonLinkProps = Omit<ComponentProps<typeof NextLink>, 'className'> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  isIconOnly?: boolean;
  className?: string;
};

/**
 * An anchor wearing HeroUI's button styles. Use for navigation, NEVER for a
 * mutation -- every mutation goes through a `<form action={serverAction}>`.
 *
 * HeroUI's `Button` renders a real `<button>` and its `render` prop may not swap
 * the element type, so the styles are applied via `buttonVariants()` to a
 * `next/link` anchor instead. That also keeps client-side navigation.
 */
export function ButtonLink({
  variant = 'secondary',
  size = 'md',
  fullWidth,
  isIconOnly,
  className,
  ...rest
}: ButtonLinkProps) {
  return (
    <NextLink
      {...rest}
      className={buttonVariants({ variant, size, fullWidth, isIconOnly, className })}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Forms                                                                       */
/* -------------------------------------------------------------------------- */

type FieldProps = {
  /** Must match the `id` of the control passed as `children`. */
  htmlFor: string;
  label: ReactNode;
  hint?: ReactNode;
  /** A field-level message from `ActionResult.fieldErrors`. */
  error?: string | undefined;
  children: ReactNode;
  className?: string;
};

/**
 * Label + control + hint + error, wired by id.
 *
 * Deliberately NOT built on `TextField`: this wrapper takes an arbitrary control
 * as `children` and associates it explicitly, so it also works for selects,
 * checkboxes and native controls. Use HeroUI's `TextField` directly when the
 * field is a plain text input and you want its validation plumbing.
 */
export function Field({ htmlFor, label, hint, error, children, className }: FieldProps) {
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <Label htmlFor={htmlFor} isInvalid={Boolean(error)}>
        {label}
      </Label>
      {children}
      {hint ? (
        <span id={`${htmlFor}-hint`} className="text-xs text-muted">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={`${htmlFor}-error`} role="alert" className="text-xs text-danger">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/**
 * A non-blocking error banner for `{ ok: false }` action results. Renders
 * nothing at all when there is no error, so it is safe to leave mounted.
 */
export function FormError({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  if (!children) return null;
  return (
    <p
      role="alert"
      className={cx(
        'rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-soft-foreground',
        className,
      )}
    >
      {children}
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/* Text                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Multi-line user text. React escapes the child, so no sanitization is needed
 * and none is performed -- `dangerouslySetInnerHTML` is banned project-wide.
 * `.pre-wrap` preserves the author's line breaks with CSS instead of markup.
 */
export function Prose({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('pre-wrap text-sm leading-relaxed', className)}>{children}</div>;
}

/* -------------------------------------------------------------------------- */
/* Badges                                                                      */
/* -------------------------------------------------------------------------- */

export type BadgeTone = 'neutral' | 'accent' | 'danger' | 'success' | 'warning';

const TONE_COLOR: Record<BadgeTone, NonNullable<ChipVariants['color']>> = {
  neutral: 'default',
  accent: 'accent',
  danger: 'danger',
  success: 'success',
  warning: 'warning',
};

type BadgeProps = Omit<HTMLAttributes<HTMLSpanElement>, 'color'> & {
  tone?: BadgeTone;
  children: ReactNode;
};

/** Small inline status pill: a role, a project key, a column name. */
export function Badge({ tone = 'neutral', className, children, ...rest }: BadgeProps) {
  return (
    <Chip {...rest} color={TONE_COLOR[tone]} size="sm" variant="secondary" className={className}>
      {children}
    </Chip>
  );
}

/* -------------------------------------------------------------------------- */
/* Page furniture                                                              */
/* -------------------------------------------------------------------------- */

type PageHeaderProps = {
  title: ReactNode;
  description?: ReactNode;
  /** Right-hand slot: the page's primary action, or a small cluster of them. */
  actions?: ReactNode;
  /** Extra meta under the title -- badges, a key, a count. */
  children?: ReactNode;
  className?: string;
};

export function PageHeader({
  title,
  description,
  actions,
  children,
  className,
}: PageHeaderProps) {
  return (
    <header className={cx('flex flex-wrap items-start justify-between gap-4', className)}>
      <div className="flex min-w-0 flex-col gap-1.5">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
        {description ? <p className="text-sm text-muted">{description}</p> : null}
        {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}

type EmptyStateProps = {
  title: ReactNode;
  description?: ReactNode;
  /** The call to action. Omit it when the viewer's role cannot perform it. */
  children?: ReactNode;
  className?: string;
};

/**
 * A real empty state, not a shrug: says what is missing, why, and offers the one
 * action that fixes it. No icon -- the text carries it.
 */
export function EmptyState({ title, description, children, className }: EmptyStateProps) {
  return (
    <div
      className={cx(
        'flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-12 text-center',
        className,
      )}
    >
      <h2 className="text-base font-medium text-foreground">{title}</h2>
      {description ? <p className="max-w-[46ch] text-sm text-muted">{description}</p> : null}
      {children ? (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{children}</div>
      ) : null}
    </div>
  );
}
