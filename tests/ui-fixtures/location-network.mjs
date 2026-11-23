// Synthetic discovery responses and map tiles. No request reaches an upstream provider.
export const fixturePlace = { displayName: 'Boston Common, Boston, Massachusetts, United States', lat: 42.355, lng: -71.066 }
export const fixtureCourts = [
  { id: 'osm:way/101', name: 'Boston Common Tennis Courts', lat: 42.3548, lng: -71.0692, locality: 'Boston, Massachusetts', source: 'osm', osmType: 'way', osmId: 101, surface: 'hard', lights: 'unlit', access: 'public' },
  { id: 'osm:node/102', name: 'Charles River Tennis Courts', lat: 42.358, lng: -71.078, locality: 'Boston, Massachusetts', source: 'osm', osmType: 'node', osmId: 102, surface: 'asphalt', lights: 'lit', access: 'public' },
]

export const fixtureTile = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" fill="#dfe5dd"/><path d="M0 64H256M0 192H256M64 0V256M192 0V256" stroke="#f5f6f0" stroke-width="12"/><path d="M0 129L256 93M97 0L125 256" stroke="#bccac2" stroke-width="4"/><path d="M0 220C95 175 140 235 256 185" stroke="#a8c9d0" stroke-width="30" fill="none"/><rect x="141" y="140" width="45" height="32" rx="3" fill="#98b394"/></svg>`

export async function mockDiscovery(page, options = {}) {
  await page.route('**/api/geocode?**', async route => {
    const query = new URL(route.request().url()).searchParams.get('q') ?? ''
    if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs))
    if (options.error || /network error/i.test(query)) return route.fulfill({ status: 503, json: { error: 'Place search is unavailable. Try again.' } })
    const results = options.empty || /nowhere/i.test(query) ? [] : [fixturePlace]
    return route.fulfill({ json: { results, cached: true } })
  })
  await page.route('**/api/courts/nearby?**', route => options.courtError
    ? route.fulfill({ status: 503, json: { error: 'Court search is unavailable. Try again.' } })
    : route.fulfill({ json: { courts: options.noCourts ? [] : fixtureCourts, count: options.noCourts ? 0 : fixtureCourts.length, source: 'osm', attribution: 'OpenStreetMap contributors', cached: true } }))
  await page.route('https://tile.openstreetmap.org/**', route => route.fulfill({ contentType: 'image/svg+xml', body: fixtureTile }))
}
