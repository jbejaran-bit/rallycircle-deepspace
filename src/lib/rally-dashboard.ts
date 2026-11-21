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
  const myResponses = new Map(responses.filter(row => row.userId === userId).map(row => [row.sessionId, row.status]))
  const myWaitlist = new Set(waitlist.filter(row => row.userId === userId).map(row => row.sessionId))
  const entries = sessions.flatMap(({ recordId, data }) => {
    const score = readMatchScore(data.matchScore)
    const side = score?.teams.findIndex(team => team.includes(userId)) ?? -1
    const hosting = data.hostId === userId
    const response = myResponses.get(recordId)
    const waiting = myWaitlist.has(recordId) && response !== 'going'
    if (!hosting && !response && !waiting && side < 0) return []
    const start = Date.parse(data.startsAt)
    const scheduled = Number.isFinite(start)
    const end = start + data.durationMinutes * 60_000
    const inSession = scheduled && Number.isFinite(end) && start <= now && end > now
    return [{
      recordId, data, hosting, response, waiting, score, side, start,
      cancelled: data.status === 'cancelled',
      inSession,
      past: scheduled && start <= now && !inSession,
      scheduled,
    }]
  }).sort((a, b) => Number(b.scheduled) - Number(a.scheduled) || (a.start - b.start || 0))

  const confirmedPlayers = new Map<string, Set<string>>()
  for (const response of communityResponses ?? []) {
    if (response.status !== 'going') continue
    const players = confirmedPlayers.get(response.sessionId) ?? new Set<string>()
    players.add(response.userId)
    confirmedPlayers.set(response.sessionId, players)
  }
  const gamesNeedingPlayers = communityResponses === null ? [] : sessions
    .filter(({ recordId, data }) => data.status === 'open' && Date.parse(data.startsAt) > now &&
      data.hostId !== userId && !myResponses.has(recordId) && !myWaitlist.has(recordId) &&
      !confirmedPlayers.get(recordId)?.has(userId))
    .map(({ recordId, data }) => ({
      recordId, data,
      needed: Math.min(data.targetPlayers, data.capacity ?? Infinity) - (confirmedPlayers.get(recordId)?.size ?? 0),
    }))
    .filter(row => row.needed > 0)
    .sort((a, b) => Date.parse(a.data.startsAt) - Date.parse(b.data.startsAt))
    .slice(0, 3)

  const matches = entries.filter(row => row.score && row.side >= 0).reverse()
  const finalized = matches.filter(row => row.score && resultStatus(row.score) === 'final')
  const committed = entries.filter(row => row.scheduled && !row.past && !row.cancelled &&
    (row.hosting || row.response === 'going'))
  return {
    entries,
    nextRally: committed[0],
    awaitingResponse: matches.filter(row => !row.cancelled && row.score && row.score.winner !== null &&
      !row.score.disputed && !row.score.approvals.includes(userId)),
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
    case 'waitlisted': return entries.filter(row => row.waiting && !row.cancelled && !row.past)
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

export function groupAgendaByDay(entries: ReturnType<typeof filterAgenda>) {
  const days = new Map<number | null, Entry[]>()
  for (const entry of entries) {
    const start = new Date(entry.start)
    const day = entry.scheduled ? new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime() : null
    const group = days.get(day) ?? []
    group.push(entry)
    days.set(day, group)
  }
  return [...days].map(([day, rows]) => ({ day, entries: rows }))
}
