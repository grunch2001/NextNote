import { describe, expect, it } from 'vitest';
import { HIGHLIGHTER_INK_COLORS, INK_COLORS, hexToHsv, hsvToHex, normalizeHex } from '../src/model/colors';

describe('colour conversion for the spectrum picker', () => {
  it('normalises hex input', () => {
    expect(normalizeHex('#1976d2')).toBe('#1976D2');
    expect(normalizeHex('1976D2')).toBe('#1976D2');
    expect(normalizeHex(' #abc ')).toBe('#AABBCC');
    expect(normalizeHex('#12345')).toBeNull();
    expect(normalizeHex('blau')).toBeNull();
  });

  it('converts primaries and greys', () => {
    expect(hexToHsv('#FF0000')).toEqual({ h: 0, s: 1, v: 1 });
    expect(hexToHsv('#00FF00')).toEqual({ h: 120, s: 1, v: 1 });
    expect(hexToHsv('#0000FF')).toEqual({ h: 240, s: 1, v: 1 });
    expect(hexToHsv('#000000')).toEqual({ h: 0, s: 0, v: 0 });
    expect(hsvToHex({ h: 60, s: 1, v: 1 })).toBe('#FFFF00');
    expect(hsvToHex({ h: 300, s: 1, v: 1 })).toBe('#FF00FF');
    expect(hsvToHex({ h: 360, s: 1, v: 1 })).toBe('#FF0000');
    expect(hsvToHex({ h: 200, s: 0, v: 1 })).toBe('#FFFFFF');
    expect(hsvToHex({ h: 200, s: 1, v: 0 })).toBe('#000000');
  });

  it('round-trips every palette colour and a sweep of the RGB cube', () => {
    for (const c of [...INK_COLORS, ...HIGHLIGHTER_INK_COLORS]) expect(hsvToHex(hexToHsv(c))).toBe(c);
    for (let r = 0; r < 256; r += 15)
      for (let g = 0; g < 256; g += 15)
        for (let b = 0; b < 256; b += 15) {
          const hex = '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase();
          expect(hsvToHex(hexToHsv(hex))).toBe(hex);
        }
  });
});
