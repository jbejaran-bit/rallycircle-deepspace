import { describe, expect, it } from 'vitest'
import { buildPollDraft } from './poll-draft'

describe('buildPollDraft', () => {
  const now = Date.UTC(2026, 0, 1)
  const first = '2027-01-02T17:15'
  const second = '2027-01-03T10:10'

  it('converts local options to canonical instants and assigns unique ids', () => {
    expect(buildPollDraft([first, second], now)).toEqual({
      options: [
        { id: 'option-1', startsAt: new Date(first).toISOString() },
        { id: 'option-2', startsAt: new Date(second).toISOString() },
      ],
    })
  })

  it('rejects duplicates, past options, missing fields and invalid calendar dates', () => {
    expect(buildPollDraft([first, first], now)).toEqual({ error: 'Proposed times must be different.' })
    expect(buildPollDraft(['2025-03-01T12:00', second], now)).toEqual({ error: 'Each proposed time must be in the future.' })
    expect(buildPollDraft([first, ''], now)).toEqual({ error: 'Choose a valid date and time for option 2.' })
    expect(buildPollDraft([first, '2027-02-31T12:00'], now)).toEqual({ error: 'Choose a valid date and time for option 2.' })
  })

  it('reports a supported option count before doing date work', () => {
    expect(buildPollDraft([first], now)).toEqual({ error: 'Propose 2 to 5 times.' })
    expect(buildPollDraft(Array(6).fill(first), now)).toEqual({ error: 'Propose 2 to 5 times.' })
  })
})
