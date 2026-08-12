import { Children, Fragment, type HTMLAttributes, type ReactNode } from 'react';
import NextLink from 'next/link';
import Markdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { Badge as UntitledBadge } from '@/components/base/badges/badges';
import { Label } from '@/components/base/input/label';
import { cx } from '@/lib/utils/cx';

/**
 * Shared presentational primitives, built on Untitled UI.
 *
 * These are deliberately server-safe: no hooks, no event handlers, no
 * `'use client'`. Untitled UI's own component modules each carry `'use client'`,
 * so they can be rendered straight from a Server Component and these wrappers
 * can too. Nothing here holds logic worth testing -- it is layout and token
 * plumbing.
 *
 * The rule of thumb for what belongs in this file: something the app needs that
 * Untitled UI's open-source set does not ship (`Card`, `Breadcrumbs`,
 * `Separator`, `PageHeader`, `Prose`, `FormError`), or an Untitled UI component
 * re-exported so call sites have ONE import site. Anything richer -- `Table`,
 * `Modal`, `Dropdown`, `Select`, `Toggle` -- is imported from
 * `@/components/base/...` or `@/components/application/...` at the call site.
 *
 * `SubmitButton` is the one client primitive; it lives in its own `'use client'`
 * module and is re-exported here.
 */
export { SubmitButton } from './submit-button';

/**
 * Straight re-exports. `Button` is Untitled UI's: it forwards `type`, so
 * `<Button type="submit">` inside `<form action={serverAction}>` submits and the
 * action receives the FormData.
 *
 * `Input` and `TextArea` are Untitled UI's *Base* variants deliberately: the
 * `Input` / `TextArea` it also ships wrap react-aria's `TextField`, which owns
 * the label, moves `id` onto a wrapper `<div>`, and restores its own initial
 * value on the form `reset` event. That last one breaks the controlled email in
 * `login-form.tsx` (React 19 resets the form after an action, which would fire
 * `onChange('')` and wipe it). The Base variants are the plain `<input>` /
 * `<textarea>` with the same styling, so `id`, `required`, `value` and a native
 * `onChange` event all behave as they read, and `Field` below owns the label.
 */
export { Button } from '@/components/base/buttons/button';
export { InputBase as Input } from '@/components/base/input/input';
export { Label };
export { Avatar } from '@/components/base/avatar/avatar';
export { LoadingIndicator } from '@/components/application/loading-indicator/loading-indicator';
/**
 * Untitled UI spells it `TextArea`; the rest of this app has always spelled it
 * `Textarea`. Aliased rather than renamed so no call site has to care.
 */
export {
  TextAreaBase as TextArea,
  TextAreaBase as Textarea,
} from '@/components/base/textarea/textarea';

/* -------------------------------------------------------------------------- */
/* Navigation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `ButtonLink` lives in its own `'use client'` module -- it reads Untitled UI's
 * `styles` object, and a plain object imported from a client module into a
 * Server Component arrives as a client reference rather than the object itself.
 */
export { ButtonLink } from './button-link';

/**
 * Untitled UI ships breadcrumbs only in PRO, and the markup is trivial: an
 * ordered list of links whose separator is decoration, not content.
 *
 * The separator is injected here rather than drawn with a `::before` on the item
 * so it can carry `aria-hidden` -- CSS generated content is announced by some
 * screen readers, and "slash" between every crumb is noise.
 */
export function Breadcrumbs({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <nav aria-label="Breadcrumb" className={className}>
      <ol className="flex flex-wrap items-center gap-1.5 text-sm">
        {Children.toArray(children).map((child, index) => (
          <Fragment key={index}>
            {index > 0 ? (
              <li aria-hidden="true" className="text-fg-quaternary">
                /
              </li>
            ) : null}
            {child}
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}

/**
 * One crumb. With `href` it is a link; without, it is the current page and gets
 * `aria-current="page"` -- so the last crumb is written without an href.
 */
Breadcrumbs.Item = function BreadcrumbsItem({
  href,
  children,
}: {
  href?: string;
  children: ReactNode;
}) {
  return (
    <li className="min-w-0">
      {href ? (
        <NextLink
          href={href}
          className="rounded-sm font-medium text-tertiary outline-focus-ring transition duration-100 ease-linear hover:text-tertiary_hover focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {children}
        </NextLink>
      ) : (
        <span aria-current="page" className="font-medium text-secondary">
          {children}
        </span>
      )}
    </li>
  );
};

/* -------------------------------------------------------------------------- */
/* Surfaces                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Untitled UI's open-source set has no card, so this is the app's own: the same
 * surface its `TableCard` and modals use -- `bg-primary`, a hairline ring rather
 * than a border so it does not affect layout, and `shadow-xs`.
 *
 * The subcomponents mirror the shape the app already used, so call sites did not
 * have to change when the design system did.
 */
export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={cx(
        'flex flex-col gap-4 rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary',
        className,
      )}
    />
  );
}

Card.Header = function CardHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={cx('flex flex-col gap-1', className)} />;
};

Card.Title = function CardTitle({ className, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 {...rest} className={cx('text-md font-semibold text-primary', className)} />;
};

Card.Description = function CardDescription({
  className,
  ...rest
}: HTMLAttributes<HTMLParagraphElement>) {
  return <p {...rest} className={cx('text-sm text-tertiary', className)} />;
};

Card.Content = function CardContent({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={cx('flex flex-col gap-3', className)} />;
};

Card.Footer = function CardFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={cx('flex flex-wrap items-center gap-3', className)} />;
};

/**
 * A hairline rule. `<hr>` already means "thematic break" to assistive tech, so
 * no `role` is needed; the border is zeroed and replaced with a background so it
 * renders at exactly one device pixel.
 */
export function Separator({
  className,
  ...rest
}: Omit<HTMLAttributes<HTMLHRElement>, 'children'>) {
  return <hr {...rest} className={cx('h-px w-full border-0 bg-border-secondary', className)} />;
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
 * Deliberately NOT built on Untitled UI's `Input`: that component owns its own
 * label and hint, which is the right choice for a plain text field. This wrapper
 * takes an arbitrary control as `children` and associates it explicitly, so it
 * also works for selects, checkboxes and native controls.
 */
export function Field({ htmlFor, label, hint, error, children, className }: FieldProps) {
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <Label htmlFor={htmlFor} isInvalid={Boolean(error)}>
        {label}
      </Label>
      {children}
      {hint ? (
        <span id={`${htmlFor}-hint`} className="text-xs text-tertiary">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={`${htmlFor}-error`} role="alert" className="text-xs text-error-primary">
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
        'rounded-lg bg-error-primary px-3 py-2 text-sm text-error-primary ring-1 ring-error_subtle',
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
 * Multi-line user text, rendered as Markdown.
 *
 * `react-markdown` builds React ELEMENTS -- it never produces an HTML string,
 * and without `rehype-raw` any HTML in the source is dropped rather than
 * parsed. So `dangerouslySetInnerHTML` stays banned project-wide and the XSS
 * posture is unchanged: the app still never constructs HTML from user input.
 * URLs are filtered by react-markdown's default transform (`javascript:` and
 * friends are stripped).
 *
 * Two plugins, both from the same authors as the parser:
 *   `remark-gfm`    -- tables, strikethrough, task lists, bare URLs.
 *   `remark-breaks` -- a single newline is a line break. Commonmark would fold
 *                      it into a space, which is not what someone typing into a
 *                      textarea means, and would reflow every comment written
 *                      back when this rendered as plain `pre-wrap` text.
 *
 * The tags come out of the parser, so they cannot carry Tailwind classes at a
 * call site; the `markdown` utility in `globals.css` styles them.
 */
export function Prose({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cx('markdown text-sm leading-relaxed', className)}>
      <Markdown remarkPlugins={[remarkGfm, remarkBreaks]}>{children}</Markdown>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Badges                                                                      */
/* -------------------------------------------------------------------------- */

export type BadgeTone = 'neutral' | 'accent' | 'danger' | 'success' | 'warning';

const TONE_COLOR = {
  neutral: 'gray',
  accent: 'brand',
  danger: 'error',
  success: 'success',
  warning: 'warning',
} as const satisfies Record<BadgeTone, string>;

type BadgeProps = {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
};

/**
 * Small inline status pill: a role, a project key, a column name.
 *
 * The app's `tone` vocabulary is kept rather than adopting Untitled UI's colour
 * names, because it says what the badge MEANS -- `danger` survives a rebrand
 * that turns error red into something else.
 */
export function Badge({ tone = 'neutral', className, children }: BadgeProps) {
  return (
    <UntitledBadge type="pill-color" color={TONE_COLOR[tone]} size="sm" className={className}>
      {children}
    </UntitledBadge>
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
        <h1 className="text-xl font-semibold text-primary">{title}</h1>
        {description ? <p className="text-sm text-tertiary">{description}</p> : null}
        {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}

/**
 * `EmptyState` lives in its own `'use client'` module for the same reason as
 * `ButtonLink`: it dots into an Untitled UI compound component, and those
 * sub-components read as `undefined` from a Server Component.
 */
export { EmptyState } from './empty-state';
