import { describe, expect, it } from 'vitest';
import { calculateMasonryMetrics, isPureChineseText, normalizeColorConfig } from './index';

describe('utils', () => {
  it('keeps card width fixed and centers a minimum of three columns', () => {
    expect(calculateMasonryMetrics(920, 16)).toEqual({
      columns: 3,
      gridWidth: 902,
      sidePadding: 9,
    });
    expect(calculateMasonryMetrics(1226, 16).columns).toBe(4);
    expect(calculateMasonryMetrics(680, 16)).toEqual({
      columns: 3,
      gridWidth: 902,
      sidePadding: 0,
    });
  });

  it('detects pure Chinese titles after punctuation is removed', () => {
    expect(isPureChineseText('春江花月夜')).toBe(true);
    expect(isPureChineseText('春江花月夜 2026')).toBe(false);
    expect(isPureChineseText('《静夜思》')).toBe(true);
  });

  it('normalizes color interaction defaults', () => {
    expect(normalizeColorConfig(undefined)).toEqual({
      enabled: true,
      grayscale: 0.6,
      sepia: 0.3,
      overlayColor: 'rgba(74, 128, 118, 0.26)',
      overlayOpacity: 1,
      textColor: '#1d3444',
      lineColor: 'rgba(29, 52, 68, 0.46)',
      transitionDuration: 400,
    });
    expect(normalizeColorConfig({ enabled: false })).toEqual({
      enabled: false,
      grayscale: 0.6,
      sepia: 0.3,
      overlayColor: 'rgba(74, 128, 118, 0.26)',
      overlayOpacity: 1,
      textColor: '#1d3444',
      lineColor: 'rgba(29, 52, 68, 0.46)',
      transitionDuration: 400,
    });
  });
});
