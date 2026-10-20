/** Section / notebook colours, inspired by classic notebook tab colours. */
export const SECTION_COLORS = [
  '#8AA8E4',
  '#91BAAE',
  '#F5D78E',
  '#F6B078',
  '#EE9597',
  '#B49EDE',
  '#9595EE',
  '#A6E6A6',
  '#97D9E4',
  '#E7A6D3',
  '#C3C3C3',
  '#D4A373',
];

export const NOTEBOOK_COLORS = [
  '#7A3FB8',
  '#2F7FD0',
  '#16A085',
  '#C0392B',
  '#D35400',
  '#B7950B',
  '#5D6D7E',
  '#AD1457',
  '#2E7D32',
  '#00838F',
];

export const TEXT_COLORS = [
  '#000000',
  '#404040',
  '#7F7F7F',
  '#FFFFFF',
  '#C00000',
  '#FF0000',
  '#FFC000',
  '#FFFF00',
  '#92D050',
  '#00B050',
  '#00B0F0',
  '#0070C0',
  '#002060',
  '#7030A0',
];

export const HIGHLIGHT_COLORS = ['#FFFF00', '#00FF00', '#00FFFF', '#FF00FF', '#FFC000', '#FF8080', '#B4C7E7', '#D9D9D9'];

export const INK_COLORS = [
  '#000000',
  '#5A5A5A',
  '#FFFFFF',
  '#D32F2F',
  '#F57C00',
  '#FBC02D',
  '#388E3C',
  '#0097A7',
  '#1976D2',
  '#283593',
  '#7B1FA2',
  '#C2185B',
  '#795548',
];

export const HIGHLIGHTER_INK_COLORS = ['#FFF200', '#7CFC00', '#00E5FF', '#FF4FD8', '#FF9800', '#B388FF'];

export const PAGE_COLORS: Array<{ name: string; color: string | null }> = [
  { name: 'Keine Farbe', color: null },
  { name: 'Blau', color: '#DCE9F7' },
  { name: 'Gelb', color: '#FFF8D6' },
  { name: 'Grün', color: '#E2F3E1' },
  { name: 'Rosa', color: '#FCE4EC' },
  { name: 'Lila', color: '#EDE3F7' },
  { name: 'Grau', color: '#EEEEEE' },
  { name: 'Sand', color: '#F6EEDF' },
];

export function pickColor(list: string[], seed: number): string {
  return list[Math.abs(seed) % list.length];
}

export interface HSV {
  /** 0–360 */
  h: number;
  /** 0–1 */
  s: number;
  /** 0–1 */
  v: number;
}

/** Normalises "#abcdef" / "abcdef" / "#abc" to "#ABCDEF"; null if it is not a hex colour. */
export function normalizeHex(input: string): string | null {
  let m = /^#?([0-9a-f]{6})$/i.exec(input.trim());
  if (m) return '#' + m[1].toUpperCase();
  m = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(input.trim());
  if (m) return ('#' + m[1] + m[1] + m[2] + m[2] + m[3] + m[3]).toUpperCase();
  return null;
}

export function hexToHsv(hex: string): HSV {
  const n = normalizeHex(hex) ?? '#000000';
  const r = parseInt(n.slice(1, 3), 16) / 255;
  const g = parseInt(n.slice(3, 5), 16) / 255;
  const b = parseInt(n.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return { h: h * 60, s: max ? d / max : 0, v: max };
}

export function hsvToHex({ h, s, v }: HSV): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    const c = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return ('#' + f(5) + f(3) + f(1)).toUpperCase();
}
