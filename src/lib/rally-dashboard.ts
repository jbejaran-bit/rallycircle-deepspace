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
    return [{
      recordId, data, hosting, response, waiting, score, side, start,
      cancelled: data.status === 'cancelled',
      past: Number.isFinite(start) && start <= now,
      scheduled: Number.isFinite(start),
    }]
  }).sort((a, b) => Number(b.scheduled) - Number(a.scheduled) || (a.start - b.start || 0))

  const matches = entries.filter(row => row.score && row.side >= 0).reverse()
  const finalized = matches.filter(row => row.score && resultStatus(row.score) === 'final')
  return {
    entries,
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
