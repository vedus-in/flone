import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * The class-name helper registry components expect at `@/lib/utils`.
 *
 * `clsx` resolves conditionals, `twMerge` then drops earlier Tailwind utilities
 * that a later one overrides -- so a `className` passed in at a call site beats
 * the component's own default instead of both landing and letting source order
 * decide. Both packages are already present as HeroUI dependencies.
 *
 * Deliberately NOT `server-only`: this is shared by server and client components.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
