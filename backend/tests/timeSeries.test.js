import { daysBetweenDates, findEntryByDaysAgo, seriesHasGap } from '../src/utils/timeSeries.js';

describe('timeSeries — daysBetweenDates', () => {
  test('positive when b after a', () => {
    expect(daysBetweenDates('2026-06-01', '2026-06-08')).toBe(7);
  });

  test('negative when b before a', () => {
    expect(daysBetweenDates('2026-06-08', '2026-06-01')).toBe(-7);
  });

  test('zero for same date', () => {
    expect(daysBetweenDates('2026-06-01', '2026-06-01')).toBe(0);
  });

  test('null for invalid input', () => {
    expect(daysBetweenDates('nope', '2026-06-01')).toBeNull();
    expect(daysBetweenDates('2026-06-01', undefined)).toBeNull();
  });
});

describe('timeSeries — findEntryByDaysAgo', () => {
  const ref = '2026-06-30';
  const history = [
    { date: '2026-05-31', value: 1 }, // 30d ago exact
    { date: '2026-06-23', value: 2 }, // 7d ago exact
    { date: '2026-06-29', value: 3 }, // 1d ago exact
    { date: '2026-06-30', value: 4 }, // today
  ];

  test('finds exact match by days ago', () => {
    expect(findEntryByDaysAgo(history, 7, 2, ref).value).toBe(2);
    expect(findEntryByDaysAgo(history, 1, 1, ref).value).toBe(3);
    expect(findEntryByDaysAgo(history, 30, 3, ref).value).toBe(1);
  });

  test('returns nearest within tolerance', () => {
    const gappy = [{ date: '2026-06-22', value: 9 }]; // 8d ago, within tolerance 2 of 7d
    expect(findEntryByDaysAgo(gappy, 7, 2, ref).value).toBe(9);
  });

  test('returns null when nothing within tolerance', () => {
    const gappy = [{ date: '2026-06-10', value: 9 }]; // 20d ago, not near 7d
    expect(findEntryByDaysAgo(gappy, 7, 2, ref)).toBeNull();
  });

  test('null for empty history', () => {
    expect(findEntryByDaysAgo([], 7, 2, ref)).toBeNull();
  });
});

describe('timeSeries — seriesHasGap', () => {
  test('false for contiguous daily series', () => {
    const h = [
      { date: '2026-06-27' }, { date: '2026-06-28' },
      { date: '2026-06-29' }, { date: '2026-06-30' },
    ];
    expect(seriesHasGap(h, 3)).toBe(false);
  });

  test('true when a gap exceeds maxGapDays', () => {
    const h = [
      { date: '2026-06-01' }, // then server off ~9 days
      { date: '2026-06-10' },
      { date: '2026-06-11' },
    ];
    expect(seriesHasGap(h, 3)).toBe(true);
  });

  test('false for a small gap within tolerance', () => {
    const h = [{ date: '2026-06-28' }, { date: '2026-06-30' }]; // 2-day gap, <= 3
    expect(seriesHasGap(h, 3)).toBe(false);
  });

  test('false for series shorter than 2', () => {
    expect(seriesHasGap([{ date: '2026-06-30' }], 3)).toBe(false);
    expect(seriesHasGap([], 3)).toBe(false);
  });
});
