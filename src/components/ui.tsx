import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  LabelHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from 'react';

/**
 * Shared presentational primitives.
 *
 * These are deliberately server-safe: no hooks, no event handlers, no
 * `'use client'`. They render identically whether imported by a Server
 * Component or pulled into a client bundle, and they carry no logic worth
 * testing -- every class they emit is defined in `globals.css`.
 *
 * `SubmitButton` is the one exception and lives in its own `'use client'` module;
 * it is re-exported here so callers have a single import site.
 */
export { SubmitButton } from './submit-button';

function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

/* -------------------------------------------------------------------------- */
/* Button                                                                      */
/* -------------------------------------------------------------------------- */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'sm' | 'icon';

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'btn btn-primary',
  secondary: 'btn',
  ghost: 'btn btn-ghost',
  danger: 'btn btn-danger',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  md: '',
  sm: 'btn-sm',
  icon: 'btn-sm btn-icon',
};

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={cx(VARIANT_CLASS[variant], SIZE_CLASS[size], className)}
    />
  );
}

/** An `<a>` styled as a button. Use for navigation, never for mutations. */
type ButtonLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export function ButtonLink({
  variant = 'secondary',
  size = 'md',
  className,
  ...rest
}: ButtonLinkProps) {
  return <a {...rest} className={cx(VARIANT_CLASS[variant], SIZE_CLASS[size], className)} />;
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx('input', className)} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cx('textarea', className)} />;
}

export function Label({ className, ...rest }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label {...rest} className={cx('label', className)} />;
}

/* -------------------------------------------------------------------------- */
/* Field                                                                       */
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

export function Field({ htmlFor, label, hint, error, children, className }: FieldProps) {
  return (
    <div className={cx('field', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? (
        <span className="hint" id={`${htmlFor}-hint`}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="error" id={`${htmlFor}-error`} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Surfaces                                                                    */
/* -------------------------------------------------------------------------- */

type CardProps = HTMLAttributes<HTMLDivElement> & { tight?: boolean };

export function Card({ tight = false, className, ...rest }: CardProps) {
  return <div {...rest} className={cx('card', tight && 'card-tight', className)} />;
}

export type BadgeTone = 'neutral' | 'accent' | 'danger';

type BadgeProps = HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone };

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: '',
  accent: 'badge-accent',
  danger: 'badge-danger',
};

export function Badge({ tone = 'neutral', className, ...rest }: BadgeProps) {
  return <span {...rest} className={cx('badge', TONE_CLASS[tone], className)} />;
}

/* -------------------------------------------------------------------------- */
/* Empty state                                                                 */
/* -------------------------------------------------------------------------- */

type EmptyStateProps = {
  title: ReactNode;
  description?: ReactNode;
  /** The call to action. Omit it when the viewer's role cannot perform it. */
  children?: ReactNode;
  className?: string;
};

export function EmptyState({ title, description, children, className }: EmptyStateProps) {
  return (
    <div className={cx('empty', className)}>
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Text                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Multi-line user text. React escapes the child, so no sanitization is needed
 * and none is performed -- `dangerouslySetInnerHTML` is banned project-wide.
 * `white-space: pre-wrap` preserves the author's line breaks.
 */
export function Prose({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('prose', className)}>{children}</div>;
}

/** A non-blocking error banner for `{ ok: false }` action results. */
export function FormError({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <p className="error" role="alert">
      {children}
    </p>
  );
}
