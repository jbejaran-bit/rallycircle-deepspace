import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import CourtsPage from '../pages/(app)/(protected)/courts'
import { courts, distanceMiles, findCourt, matchesCourt, rankCourts } from './courts'

describe('court discovery', () => {
  it('keeps one main landmark and renders the court list without map tiles', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <main><CourtsPage /></main>
      </MemoryRouter>,
    )

    expect(html.match(/<main\b/g)).toHaveLength(1)
    expect(html).toContain('<h1')
    expect(html).toContain('aria-label="Pittsburgh courts"')
    expect(html).toContain('id="court-tab-pittsburgh"')
    expect(html).toContain('aria-controls="court-source-panel-pittsburgh"')
    expect(html).toContain('id="court-source-panel-pittsburgh"')
    expect(html).toContain('aria-labelledby="court-tab-pittsburgh"')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('Schenley Oval Tennis Courts')
    expect(html).toContain('href="/rallies?court=schenley"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('returns no court prefill for missing and unknown court IDs', () => {
    expect(findCourt(null)).toBeUndefined()
    expect(findCourt('not-in-the-dataset')).toBeUndefined()
  })

  it('returns zero at the venue and a positive distance for another court', () => {
    const origin = findCourt('schenley')!
    const other = findCourt('frick')!
    expect(distanceMiles(origin, origin)).toBe(0)
    expect(distanceMiles(origin, other)).toBeGreaterThan(0)
    expect(distanceMiles(origin, other)).toBeCloseTo(distanceMiles(other, origin))
  })
})

it('finds courts by case-insensitive name and area terms', () => {
  const venue = findCourt('frick')!
  expect(matchesCourt(venue, '  CLAY   Regent ')).toBe(true)
  expect(matchesCourt(venue, 'Downtown')).toBe(false)
  expect(matchesCourt(venue, '')).toBe(true)
})

it('keeps court map pin numbering in the same nearest-first list order', () => {
  const nearestHighland = findCourt('highland')!
  const ranked = rankCourts(courts, nearestHighland)
  expect(ranked[0].court.id).toBe('highland')
  expect(ranked[0].distance).toBe(0)
  expect(ranked.map(item => item.distance)).toEqual(
    [...ranked.map(item => item.distance)].sort((a, b) => (a ?? 0) - (b ?? 0)),
  )
  expect(rankCourts(courts).map(item => item.court.id)).toEqual(courts.map(court => court.id))
})
