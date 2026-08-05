'use client';

import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { Button, type ButtonProps } from '@/components/base/buttons/button';

/**
 * The ONLY pending primitive in the project (SPEC 7.11): no `useTransition`, no
 * `useOptimistic`.
 *
 * `useFormStatus` must be read from a component rendered INSIDE the `<form>` --
 * that is why this is its own component rather than a hook call in the page.
 *
 * The pending state is also the double-submit guard. Untitled UI forwards
 * `isLoading` to react-aria's Button as `isPending`, which (a) rewrites
 * `type="submit"` to `type="button"` for the duration, so a second click cannot
 * submit, (b) sets `pointer-events: none`, and (c) announces the state to screen
 * readers -- all while keeping the control focusable, which a plain `disabled`
 * would not.
 *
 * `showTextWhileLoading` keeps `pendingLabel` visible next to the spinner;
 * without it Untitled UI hides the label and centres the spinner alone.
 */
type Props = Omit<ButtonProps, 'type' | 'children' | 'isLoading'> & {
  children: ReactNode;
  /** Replaces the label while the form is submitting. */
  pendingLabel?: ReactNode;
  /** Alias for react-aria's `isDisabled`, so plain-HTML call sites keep working. */
  disabled?: boolean;
};

export function SubmitButton({
  children,
  pendingLabel = 'Saving...',
  color = 'primary',
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
      color={color}
      size={size}
      isDisabled={isDisabled ?? disabled}
      isLoading={pending}
      showTextWhileLoading
    >
      {pending ? pendingLabel : children}
    </Button>
  );
}

export default SubmitButton;
