import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSessionIcs, escapeIcsText, foldIcsLine, formatIcsUtc, sessionIcsFilename } from '../src/lib/ics.ts'

const base = {
  title: 'Sunday doubles, semi-final; bring balls',
  court: 'Schenley Park',
  location: 'Pittsburgh, PA',
  startsAt: '2026-11-01T06:30:00.000Z',
  durationMinutes: 90,
  targetPlayers: 4,
  level: 'Intermediate',
  notes: 'Line one\nLine two, with comma; and semicolon \\ backslash',
  hostId: 'host-1',
  chatChannelId: '',
  status: 'open',
}

/** Reverse RFC 5545 line folding so assertions can read logical lines. */
function unfold(ics) {
  return ics.replace(/\r\n /g, '')
}

function logicalLines(ics) {
  return unfold(ics).split('\r\n').filter(Boolean)
}

test('ics has calendar and event structure with a stable UID', () => {
  const ics = buildSessionIcs({ sessionId: 'session-1', session: base, origin: 'https://rallycircle.app.space', goingCount: 3 })
  assert.ok(ics)
  const lines = logicalLines(ics)
  assert.equal(lines[0], 'BEGIN:VCALENDAR')
  assert.equal(lines[1], 'VERSION:2.0')
  assert.ok(lines.includes('BEGIN:VEVENT'))
  assert.ok(lines.includes('UID:session-1@rallycircle'))
  assert.ok(lines.includes('END:VEVENT'))
  assert.equal(lines.at(-1), 'END:VCALENDAR')
  assert.match(ics, /URL:https:\/\/rallycircle\.app\.space\/rallies\?session=session-1/)
  assert.match(ics, /DESCRIPTION:.*Level: Intermediate.*3 going/)
})

test('DTSTART and DTEND are UTC and correct across the US DST fall-back day', () => {
  // 2026-11-01 is the day US clocks fall back (02:00 EDT -> 01:00 EST).
  // UTC arithmetic is unaffected: 06:30Z + 90 minutes is 08:00Z either way.
  const ics = buildSessionIcs({ sessionId: 's', session: base, origin: 'https://example.test' })
  const lines = logicalLines(ics)
  assert.ok(lines.includes('DTSTART:20261101T063000Z'))
  assert.ok(lines.includes('DTEND:20261101T080000Z'))
})

test('duration crossing midnight rolls the end date forward', () => {
  const ics = buildSessionIcs({
    sessionId: 's',
    session: { ...base, startsAt: '2026-06-15T23:30:00.000Z', durationMinutes: 120 },
    origin: 'https://example.test',
  })
  const lines = logicalLines(ics)
  assert.ok(lines.includes('DTSTART:20260615T233000Z'))
  assert.ok(lines.includes('DTEND:20260616T013000Z'))
})

test('text escaping covers commas, semicolons, backslashes and newlines', () => {
  assert.equal(escapeIcsText('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne')
  const ics = buildSessionIcs({ sessionId: 's', session: base, origin: 'https://example.test' })
  const lines = logicalLines(ics)
  assert.ok(lines.includes('SUMMARY:Sunday doubles\\, semi-final\\; bring balls'))
  assert.ok(lines.some(l => l.startsWith('DESCRIPTION:') && l.includes('Line one\\nLine two\\, with comma\\; and semicolon \\\\ backslash')))
})

test('long lines are folded at 75 octets and unfold back to the original', () => {
  const long = { ...base, title: 'T'.repeat(72), location: 'L'.repeat(100) }
  const ics = buildSessionIcs({ sessionId: 's', session: long, origin: 'https://example.test' })
  assert.ok(ics)
  for (const physical of ics.split('\r\n')) {
    assert.ok(Buffer.byteLength(physical) <= 75, `physical line too long: ${physical.length} chars`)
  }
  const unfolded = unfold(ics)
  assert.ok(unfolded.includes(`LOCATION:Schenley Park\\, ${'L'.repeat(100)}`))
  assert.equal(foldIcsLine('short'), 'short')
})

test('folding never splits a multi-byte UTF-8 character', () => {
  const line = `SUMMARY:${'🎾'.repeat(40)}` // 4 bytes per emoji, 160 content bytes
  const folded = foldIcsLine(line)
  for (const physical of folded.split('\r\n')) {
    assert.ok(Buffer.byteLength(physical) <= 75)
  }
  assert.equal(unfold(folded), line)
})

test('output uses CRLF line endings only, with a trailing CRLF', () => {
  const ics = buildSessionIcs({ sessionId: 's', session: base, origin: 'https://example.test' })
  assert.ok(ics.endsWith('\r\n'))
  assert.ok(!ics.replace(/\r\n/g, '').includes('\n'), 'bare LF found')
  assert.ok(!ics.replace(/\r\n/g, '').includes('\r'), 'bare CR found')
})

test('output is deterministic apart from DTSTAMP', () => {
  const strip = ics => logicalLines(ics).filter(l => !l.startsWith('DTSTAMP:')).join('\n')
  const first = buildSessionIcs({ sessionId: 's', session: base, origin: 'https://example.test' })
  const second = buildSessionIcs({ sessionId: 's', session: base, origin: 'https://example.test' })
  assert.equal(strip(first), strip(second))
  assert.match(first, /^DTSTAMP:\d{8}T\d{6}Z$/m)
})

test('invalid start time or duration returns null', () => {
  assert.equal(buildSessionIcs({ sessionId: 's', session: { ...base, startsAt: 'never' }, origin: 'https://example.test' }), null)
  assert.equal(buildSessionIcs({ sessionId: 's', session: { ...base, durationMinutes: 0 }, origin: 'https://example.test' }), null)
  assert.equal(buildSessionIcs({ sessionId: 's', session: { ...base, durationMinutes: -30 }, origin: 'https://example.test' }), null)
})

test('formatIcsUtc formats a known instant', () => {
  assert.equal(formatIcsUtc(new Date('2026-11-01T06:30:00.000Z')), '20261101T063000Z')
})

test('download filename sanitizes the session id', () => {
  assert.equal(sessionIcsFilename('a+b/2'), 'rallycircle-a_b_2.ics')
})
