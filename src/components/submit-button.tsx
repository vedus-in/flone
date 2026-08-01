'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

/**
 * The ONLY pending primitive in the project (SPEC 7.11): no `useTransition`, no
 * `useOptimistic`.
 *
 * `useFormStatus` must be read from a component rendered INSIDE the `<form>` --
 * that is why this is its own component rather than a hook call in the page.
 *
 * Disabling while pending is also the double-submit guard.
 */
type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & {
  children: ReactNode;
  /** Replaces the label while the form is submitting. */
  pendingLabel?: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'md' | 'sm';
};

const VARIANT_CLASS: Record<NonNullable<Props['variant']>, string> = {
  primary: 'btn btn-primary',
  secondary: 'btn',
  ghost: 'btn btn-ghost',
  danger: 'btn btn-danger',
};

export function SubmitButton({
  children,
  pendingLabel = 'Saving...',
  variant = 'primary',
  size = 'md',
  className,
  disabled,
  ...rest
}: Props) {
  const { pending } = useFormStatus();

  const classes = [VARIANT_CLASS[variant], size === 'sm' ? 'btn-sm' : '', className]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      {...rest}
      type="submit"
      className={classes}
      disabled={pending || disabled}
      aria-busy={pending || undefined}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}

export default SubmitButton;
