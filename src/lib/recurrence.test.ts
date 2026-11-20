import { describe, expect, it } from 'vitest'
import {
  occurrenceStartsAt,
  parseSeriesTemplate,
  SERIES_MAX_COUNT,
  serializeSeriesTemplate,
  seriesEndStartsAt,
  validateSeries,
  type SeriesInput,
} from './recurrence'

const NOW = Date.parse('2026-10-20T12:00:00.000Z')
const TEMPLATE = {
  format: 'Doubles' as const,
  title: 'Weekly doubles',
  court: 'Schenley Park',
  location: 'Pittsburgh, PA',
  durationMinutes: 90,
  targetPlayers: 4,
  level: 'Intermediate' as const,
  notes: '',
}
const INPUT: SeriesInput = {
  template: TEMPLATE,
  startStartsAt: '2026-10-24T18:00:00.000Z',
  intervalWeeks: 1,
  count: 4,
}

describe('validateSeries', () => {
  it('accepts a well-formed series and rejects bad bounds', () => {
    expect(validateSeries(INPUT, NOW)).toBeNull()
    expect(validateSeries({ ...INPUT, count: 1 }, NOW)).toMatch(/2–12/)
    expect(validateSeries({ ...INPUT, count: SERIES_MAX_COUNT + 1 }, NOW)).toMatch(/2–12/)
    expect(validateSeries({ ...INPUT, count: SERIES_MAX_COUNT }, NOW)).toBeNull()
    expect(validateSeries({ ...INPUT, intervalWeeks: 0 }, NOW)).toMatch(/1–4 weeks/)
    expect(validateSeries({ ...INPUT, intervalWeeks: 5 }, NOW)).toMatch(/1–4 weeks/)
    expect(validateSeries({ ...INPUT, startStartsAt: '2026-10-19T18:00:00.000Z' }, NOW)).toMatch(/future start/)
    expect(validateSeries({ ...INPUT, template: { ...TEMPLATE, title: '' } }, NOW)).toMatch(/title/)
    expect(validateSeries({ ...INPUT, template: { ...TEMPLATE, capacity: 1 } }, NOW)).toMatch(/capacity/)
    expect(validateSeries({ ...INPUT, template: { ...TEMPLATE, capacity: 12 } }, NOW)).toBeNull()
  })
})

describe('occurrenceStartsAt', () => {
  it('steps fixed 7-day UTC intervals from the first start', () => {
    expect(occurrenceStartsAt('2026-10-24T18:00:00.000Z', 0, 1)).toBe('2026-10-24T18:00:00.000Z')
    expect(occurrenceStartsAt('2026-10-24T18:00:00.000Z', 1, 1)).toBe('2026-10-31T18:00:00.000Z')
    expect(occurrenceStartsAt('2026-10-24T18:00:00.000Z', 3, 1)).toBe('2026-11-14T18:00:00.000Z')
    expect(occurrenceStartsAt('2026-10-24T18:00:00.000Z', 1, 2)).toBe('2026-11-07T18:00:00.000Z')
    expect(seriesEndStartsAt(INPUT)).toBe('2026-11-14T18:00:00.000Z')
  })

  it('keeps UTC instants fixed across the DST fall-back (documented wall-clock shift)', () => {
    // Weekly 18:00Z series starting 2026-10-24: the 2026-11-01 fall-back
    // does not move the UTC instant — the local wall-clock reading shifts
    // by an hour instead. The test pins the honest behaviour: instants
    // are exact 7-day steps, and the DST limitation is documented, not hidden.
    const before = occurrenceStartsAt('2026-10-24T18:00:00.000Z', 1, 1)
    const after = occurrenceStartsAt('2026-10-24T18:00:00.000Z', 2, 1)
    expect(before).toBe('2026-10-31T18:00:00.000Z')
    expect(after).toBe('2026-11-07T18:00:00.000Z')
    expect(Date.parse(after) - Date.parse(before)).toBe(7 * 86_400_000)
  })
})

describe('series template JSON', () => {
  it('round-trips and rejects malformed input safely', () => {
    expect(parseSeriesTemplate(serializeSeriesTemplate(TEMPLATE))).toEqual(TEMPLATE)
    expect(parseSeriesTemplate('not json')).toBeNull()
    expect(parseSeriesTemplate('{"title": 1}')).toBeNull()
    expect(parseSeriesTemplate(undefined)).toBeNull()
  })
})
