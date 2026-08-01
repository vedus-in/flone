/**
 * Tailwind CSS v4 is a PostCSS plugin now — there is no tailwind.config.js and
 * no autoprefixer entry. HeroUI v3 requires Tailwind v4, which is why this file
 * exists at all.
 */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
