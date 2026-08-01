'use client';

import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { Button, Spinner, type ButtonProps } from '@heroui/react';

/**
 * The ONLY pending primitive in the project (SPEC 7.11): no `useTransition`, no
 * `useOptimistic`.
 *
 * `useFormStatus` must be read from a component rendered INSIDE the `<form>` --
 * that is why this is its own component rather than a hook call in the page.
 *
 * The pending state is also the double-submit guard. HeroUI forwards `isPending`
 * to react-aria's Button, which (a) rewrites `type="submit"` to `type="button"`
 * for the duration, so a second click cannot submit, (b) sets
 * `pointer-events: none`, and (c) announces the state to screen readers -- all
 * while keeping the control focusable, which a plain `disabled` would not.
 */
type Props = Omit<ButtonProps, 'type' | 'children' | 'isPending'> & {
  children: ReactNode;
  /** Replaces the label while the form is submitting. */
  pendingLabel?: ReactNode;
  /** Alias for HeroUI's `isDisabled`, so plain-HTML call sites keep working. */
  disabled?: boolean;
};

export function SubmitButton({
  children,
  pendingLabel = 'Saving...',
  variant = 'primary',
  size = 'md',
  disabled,
  isDisabled,
  ...rest
}: Props) {
  const { pending } = useFormStatus();

  return (
    <Button
      {...rest}
      type="submit"
      variant={variant}
      size={size}
      isDisabled={isDisabled ?? disabled}
      isPending={pending}
    >
      {pending ? (
        <>
          <Spinner size="sm" color="current" aria-hidden="true" />
          {pendingLabel}
        </>
      ) : (
        children
      )}
    </Button>
  );
}

export default SubmitButton;
