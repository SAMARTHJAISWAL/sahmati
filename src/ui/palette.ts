/**
 * Term colours for log cells: the Okabe–Ito palette (designed to stay
 * distinguishable under the common forms of colour-vision deficiency),
 * cycled by term. Every cell also prints its term number, so colour is never
 * the only cue.
 */
const TERM_COLORS = ['#0072B2', '#E69F00', '#009E73', '#CC79A7', '#56B4E9', '#D55E00', '#8E6C8A', '#7A8C2E'];

export function termColor(term: number): string {
  return TERM_COLORS[(Math.max(1, term) - 1) % TERM_COLORS.length]!;
}

/** Dark or light text, whichever reads better on the term colour. */
export function termInk(term: number): string {
  const hex = termColor(term);
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.3 ? '#17140f' : '#ffffff';
}
