/**
 * Tailwind theme for email.
 *
 * react-email's `<Tailwind>` runs a v3-style config object, so this cannot be
 * `src/styles/theme.css` -- that file is Tailwind v4 CSS-first tokens, which
 * have no config object to hand over. The values below are lifted from it so
 * the two do not drift: `brand` is `--color-brand-600` (rgb(127 86 217)), and
 * the neutrals are the Untitled UI ramp the app already renders.
 *
 * The scale is deliberately tiny. An email has one column, five type sizes and
 * two buttons; anything more is a design system nobody is maintaining.
 *
 * NOTE: unknown utility classes are silently dropped by `<Tailwind>` rather
 * than erroring, so a typo'd class is invisible until someone opens the mail.
 * Keep to the names declared here.
 */
export const emailTailwindConfig = {
  theme: {
    extend: {
      colors: {
        /** Card surface. */
        bg: '#ffffff',
        /** Page and panel surface. */
        'bg-2': '#fafafa',
        /** Primary text. */
        fg: '#181d27',
        /** Body text. */
        'fg-2': '#414651',
        /** Muted text: eyebrows, footer, metadata. */
        'fg-3': '#717680',
        /** Text on a filled button. */
        'fg-inverted': '#ffffff',
        brand: '#7f56d9',
        'brand-strong': '#6941c6',
        stroke: '#e9eaeb',
        'stroke-strong': '#d5d7da',
        /** Quoted comment bodies and inline code. */
        quote: '#f5f5f5',
      },
      fontSize: {
        '11': ['11px', { lineHeight: '16px' }],
        '13': ['13px', { lineHeight: '20px' }],
        '16': ['16px', { lineHeight: '24px' }],
        '20': ['20px', { lineHeight: '30px' }],
        '28': ['28px', { lineHeight: '36px' }],
        '32': ['32px', { lineHeight: '40px' }],
      },
      fontFamily: {
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Helvetica',
          'Arial',
          'sans-serif',
        ],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      screens: {
        /**
         * `<Tailwind>` emits media queries into a `<style>` block. Outlook
         * ignores that block entirely, which is why every layout below is
         * readable at 640px WITHOUT the `mobile:` rules -- they narrow the
         * padding on phones, they never carry the layout.
         */
        mobile: { max: '600px' },
      },
    },
  },
} as const;

/** Product name in the header wordmark and the footer. */
export const PRODUCT_NAME = 'Flone';
