import localFont from 'next/font/local';

/*
 * Both faces are Velvetyne releases under the SIL Open Font License 1.1, served from this
 * app. Velvetyne sends its font files without an Access-Control-Allow-Origin header, so a
 * cross-origin @font-face would silently fall back to a system face.
 */

/** Basteleur Bold, drawn by Keussel. Its own weight class says 400; it is declared as the 700 we set. */
export const display = localFont({
  src: [{ path: '../public/fonts/Basteleur-Bold.woff2', weight: '700', style: 'normal' }],
  variable: '--font-display',
  display: 'block',
  fallback: ['Georgia', 'serif'],
  adjustFontFallback: 'Times New Roman',
});

/** Gulax, drawn by Morgan Gilbert. One weight only, so nothing on the page asks for another. */
export const text = localFont({
  src: [{ path: '../public/fonts/Gulax-Regular.woff2', weight: '400', style: 'normal' }],
  variable: '--font-text',
  display: 'swap',
  fallback: ['system-ui', 'sans-serif'],
});

/**
 * Sligoil Micro, drawn by Ariel Martín Pérez. The app sets its dense rows — figures,
 * ids, hashes — in this: it is monospaced, so columns of numbers align by construction,
 * and it was drawn to hold at small sizes where the display faces do not.
 */
export const data = localFont({
  src: [{ path: '../public/fonts/Sligoil-Micro.woff2', weight: '400', style: 'normal' }],
  variable: '--font-data',
  display: 'swap',
  fallback: ['ui-monospace', 'monospace'],
});
