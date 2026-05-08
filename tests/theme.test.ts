import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error — JS ESM helper, no .d.ts ships with it
import { parseColorFgBg, parseOsc11Response } from '../bin/theme-helpers.mjs';
import { darkTheme, getTheme, lightTheme, resolveThemeName } from '../src/tui/theme.js';

describe('parseColorFgBg', () => {
  it('returns dark for bg index 0 (black)', () => {
    expect(parseColorFgBg('15;0')).toBe('dark');
  });
  it('returns dark for bg index 8 (bright black)', () => {
    expect(parseColorFgBg('15;8')).toBe('dark');
  });
  it('returns light for bg index 7 (white)', () => {
    expect(parseColorFgBg('0;7')).toBe('light');
  });
  it('returns light for bg index 15 (bright white)', () => {
    expect(parseColorFgBg('0;15')).toBe('light');
  });
  it('handles three-segment form', () => {
    expect(parseColorFgBg('0;default;15')).toBe('light');
  });
  it('returns null for ambiguous mid-palette index', () => {
    expect(parseColorFgBg('15;4')).toBeNull();
  });
  it('returns null for unset/empty value', () => {
    expect(parseColorFgBg(undefined)).toBeNull();
    expect(parseColorFgBg('')).toBeNull();
  });
  it('returns null for non-numeric value', () => {
    expect(parseColorFgBg('15;blue')).toBeNull();
  });
});

describe('parseOsc11Response', () => {
  it('classifies a near-black background as dark', () => {
    expect(parseOsc11Response('\x1b]11;rgb:0000/0000/0000\x07')).toBe('dark');
  });
  it('classifies a near-white background as light', () => {
    expect(parseOsc11Response('\x1b]11;rgb:ffff/ffff/ffff\x07')).toBe('light');
  });
  it('handles 2-digit-per-channel form', () => {
    expect(parseOsc11Response('\x1b]11;rgb:1e/1e/1e\x07')).toBe('dark');
  });
  it('handles ST terminator (\\x1b\\\\) instead of BEL', () => {
    expect(parseOsc11Response('\x1b]11;rgb:f5f5/f5f5/f5f5\x1b\\')).toBe('light');
  });
  it('returns null when the response does not match', () => {
    expect(parseOsc11Response('garbage')).toBeNull();
    expect(parseOsc11Response('')).toBeNull();
  });
});

describe('resolveThemeName', () => {
  it('honors explicit "light"', () => {
    expect(resolveThemeName('light')).toBe('light');
  });
  it('honors explicit "dark"', () => {
    expect(resolveThemeName('dark')).toBe('dark');
  });
  it('falls back to dark when value is missing or unknown', () => {
    expect(resolveThemeName(undefined)).toBe('dark');
    expect(resolveThemeName('')).toBe('dark');
    expect(resolveThemeName('weird')).toBe('dark');
  });
  it('is case-insensitive', () => {
    expect(resolveThemeName('LIGHT')).toBe('light');
    expect(resolveThemeName('Dark')).toBe('dark');
  });
});

describe('getTheme', () => {
  const original = process.env.LCODE_THEME;
  afterEach(() => {
    if (original === undefined) delete process.env.LCODE_THEME;
    else process.env.LCODE_THEME = original;
  });

  it('returns the light theme when LCODE_THEME=light', () => {
    process.env.LCODE_THEME = 'light';
    expect(getTheme()).toBe(lightTheme);
  });
  it('returns the dark theme when LCODE_THEME is unset', () => {
    delete process.env.LCODE_THEME;
    expect(getTheme()).toBe(darkTheme);
  });
});
