import type { RallyRSVP, RallySession, RallyWaitlist } from './rally'
import { readMatchScore, resultStatus } from './rally-score'

type RecordWithId<T> = { recordId: string; data: T }
export type DashboardFilter = 'upcoming' | 'hosting' | 'participating' | 'waitlisted' | 'cancelled' | 'past'

export function buildDashboard(
  sessions: RecordWithId<RallySession>[],
  responses: RallyRSVP[],
  waitlist: RallyWaitlist[],
  userId: string,
  now: number,
  communityResponses: RallyRSVP[] | null = responses,
) {
  // Keep the first valid membership per session, matching Find Games and
  // rally detail. A later malformed or duplicate legacy row must not turn a
  // confirmed RSVP into a tentative one or hide a joinable game.
  const myResponses = new Map<string, RallyRSVP['status']>()
  for (const response of responses) {
    if (response.userId !== userId || typeof response.sessionId !== 'string' || !response.sessionId ||
        (response.status !== 'going' && response.status !== 'maybe') || myResponses.has(response.sessionId)) continue
    myResponses.set(response.sessionId, response.status)
  }
  const myWaitlist = new Set(waitlist.filter(row => row.userId === userId &&
    typeof row.sessionId === 'string' && row.sessionId).map(row => row.sessionId))
  const entries = sessions.flatMap(({ recordId, data }) => {
    const score = readMatchScore(data.matchScore)
    const side = score?.teams.findIndex(team => team.includes(userId)) ?? -1
    const hosting = data.hostId === userId
    const response = myResponses.get(recordId)
    const waiting = myWaitlist.has(recordId) && response !== 'going'
    if (!hosting && !response && !waiting && side < 0) return []
    const start = Date.parse(data.startsAt)
    return [{
      recordId, data, hosting, response, waiting, score, side, start,
      cancelled: data.status === 'cancelled',
      past: Number.isFinite(start) && start <= now,
      scheduled: Number.isFinite(start),
    }]
  }).sort((a, b) => Number(b.scheduled) - Number(a.scheduled) || (a.start - b.start || 0))

  // Community reads may contain duplicate or malformed legacy RSVPs. Count each
  // player once per session so dashboard openings agree with Find Games.
  const confirmedCounts = new Map<string, number>()
  const seenPlayers = new Set<string>()
  for (const response of communityResponses ?? []) {
    if (response.status !== 'going' || typeof response.sessionId !== 'string' || !response.sessionId ||
        typeof response.userId !== 'string' || !response.userId) continue
    const key = JSON.stringify([response.sessionId, response.userId])
    if (seenPlayers.has(key)) continue
    seenPlayers.add(key)
    confirmedCounts.set(response.sessionId, (confirmedCounts.get(response.sessionId) ?? 0) + 1)
  }
  const gamesNeedingPlayers = communityResponses === null ? [] : sessions
    .filter(({ recordId, data }) => data.status === 'open' && Date.parse(data.startsAt) > now &&
      // Legacy or partially written sessions with invalid planning limits must
      // not be advertised as having a known number of open places.
      Number.isInteger(data.targetPlayers) && data.targetPlayers >= 2 && data.targetPlayers <= 12 &&
      (data.capacity == null || (Number.isInteger(data.capacity) && data.capacity >= data.targetPlayers && data.capacity <= 12)) &&
      data.hostId !== userId && !myResponses.has(recordId) && !myWaitlist.has(recordId))
    .map(({ recordId, data }) => ({
      recordId, data,
      needed: Math.min(data.targetPlayers, data.capacity ?? Infinity) - (confirmedCounts.get(recordId) ?? 0),
    }))
    .filter(row => row.needed > 0)
    .sort((a, b) => Date.parse(a.data.startsAt) - Date.parse(b.data.startsAt))
    .slice(0, 3)

  const matches = entries.filter(row => row.score && row.side >= 0).reverse()
  const finalized = matches.filter(row => row.score && resultStatus(row.score) === 'final')
  return {
    entries,
    nextRally: entries.find(row => row.scheduled && !row.past && !row.cancelled && (row.hosting || row.response === 'going')),
    gamesNeedingPlayers,
    matches,
    finalized: finalized.length,
    wins: finalized.filter(row => row.score?.winner === row.side).length,
  }
}

type Entry = ReturnType<typeof buildDashboard>['entries'][number]

export function filterAgenda(entries: Entry[], filter: DashboardFilter) {
  switch (filter) {
    case 'hosting': return entries.filter(row => row.hosting)
    case 'participating': return entries.filter(row => row.response !== undefined && !row.cancelled)
    case 'waitlisted': return entries.filter(row => row.waiting && !row.cancelled)
    case 'cancelled': return entries.filter(row => row.cancelled).reverse()
    case 'past': return entries.filter(row => row.past && !row.cancelled).reverse()
    case 'upcoming': return entries.filter(row => row.scheduled && !row.past && !row.cancelled)
  }
}

export function agendaWeek(anchor: Date, offset: number, entries: Entry[]) {
  const monday = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - ((anchor.getDay() + 6) % 7) + offset * 7)
  return Array.from({ length: 7 }, (_, day) => {
    const date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + day)
    const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1)
    return { date, entries: entries.filter(entry => entry.start >= date.getTime() && entry.start < next.getTime()) }
  })
}
