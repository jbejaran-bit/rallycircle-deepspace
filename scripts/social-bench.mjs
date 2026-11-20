// Synthetic benchmark for Track E+F discovery logic (F12).
// NOT production latency: pure in-memory functions on synthetic fixtures,
// measured on this machine. Run: `node scripts/social-bench.mjs`
import { deriveActivityFeed, derivePlayedWith, rankGames } from '../src/lib/social.ts'

const LEVELS = ['Beginner', 'Intermediate', 'Advanced', 'All levels']
const FORMATS = ['Singles', 'Doubles', 'Practice']
const COURTS = ['Schenley Park', 'Highland Park', 'Frick Park', 'Mellon Park']

function mkSession(i) {
  return {
    recordId: `s${i}`,
    createdAt: new Date(Date.UTC(2030, 5, 1 + (i % 20), 12, 0, 0)).toISOString(),
    data: {
      title: `Rally ${i}`,
      court: COURTS[i % COURTS.length],
      location: 'Pittsburgh, PA',
      startsAt: new Date(Date.UTC(2030, 5, 1 + (i % 20), 14 + (i % 4), 0, 0)).toISOString(),
      durationMinutes: 90,
      targetPlayers: 4,
      level: LEVELS[i % LEVELS.length],
      notes: '',
      hostId: `user-${i % 40}`,
      chatChannelId: '',
      status: i % 25 === 0 ? 'cancelled' : 'open',
      format: FORMATS[i % FORMATS.length],
    },
  }
}

const N = 500
const sessions = Array.from({ length: N }, (_, i) => mkSession(i))
const rsvps = []
for (let i = 0; i < N; i++) {
  for (let j = 0; j < 3; j++) {
    rsvps.push({ sessionId: `s${i}`, userId: `user-${(i + j) % 40}`, status: 'going' })
  }
}
const prefs = {
  formats: ['doubles'],
  level: 'Intermediate',
  area: 'Schenley',
  radiusMiles: 10,
  timeStart: '12:00',
  timeEnd: '18:00',
  days: [6],
}
const games = sessions
  .filter((s) => s.data.status !== 'cancelled')
  .map((s) => ({
    recordId: s.recordId,
    session: s.data,
    going: 3,
    maybe: 0,
    status: 'needs-players',
    cancelled: false,
    past: false,
    distanceMiles: null,
    isMine: false,
  }))

function bench(label, fn, runs = 20) {
  const times = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    fn()
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  console.log(
    `${label}: median ${times[Math.floor(runs / 2)].toFixed(2)} ms, p90 ${times[Math.floor(runs * 0.9)].toFixed(2)} ms (n=${runs})`,
  )
}

console.log(`Fixtures: ${N} sessions, ${rsvps.length} RSVPs, ${games.length} open games`)
bench('rankGames (500 games, prefs)', () => rankGames(games, prefs))
bench('derivePlayedWith (500 sessions, 1500 RSVPs)', () =>
  derivePlayedWith(sessions, rsvps, 'user-1'),
)
bench('deriveActivityFeed (500 sessions, 40 followed)', () =>
  deriveActivityFeed(sessions, 'user-1', new Set(Array.from({ length: 40 }, (_, i) => `user-${i}`)), new Set(), {
    followedOnly: true,
  }),
)
console.log('Note: synthetic in-memory timings only; server-side record queries add DO round-trips (bounded windows: 200 sessions / 500 RSVPs per discoverGames call).')
