/**
 * Track L — safe-extension server actions.
 *
 * Trust model — read before adding an action (same as action-routes.ts):
 * action tools run RBAC-off, so every handler below derives identity ONLY
 * from `userId` (the verified Bearer token). A `userId` in `params` is
 * never trusted. All extension collections close direct client writes for
 * every role, so these handlers are the only write path.
 *
 * Every response carries `apiVersion` (L14). All reads are bounded
 * (EXTENSION_SCAN_LIMIT rows max) and report `truncated` when the cap was
 * hit, rather than pretending a list is complete.
 */

import type { ActionHandler, ActionResult, ActionTools } from 'deepspace/worker'
import { API_VERSION } from './rally-command-room.js'
import {
  EXTENSION_SCAN_LIMIT,
  findDuplicateSession,
  MAX_AVAILABILITY_WINDOWS_PER_USER,
  MAX_FAVORITE_COURTS_PER_USER,
  MAX_MATCH_NOTES_PER_SESSION,
  MAX_TEMPLATES_PER_USER,
  searchSessions,
  upcomingReminders,
  validateAvailabilityWindow,
  validateChatMessageId,
  validateFavoriteCourt,
  validateMatchNote,
  validateSessionTemplate,
  type SessionRecord,
} from '../lib/extensions.js'
import { readMatchScore, resultStatus } from '../lib/rally-score.js'
import type { RallyRSVP, RallySession } from '../lib/rally.js'
import type { Env } from '../../worker.js'

type Tools = ActionTools

// ActionTools query/get generics require Record<string, unknown>; the rally
// row types gain an index signature through these intersections.
type SessionRow = RallySession & Record<string, unknown>
type RsvpRow = RallyRSVP & Record<string, unknown>

function ok<T extends Record<string, unknown>>(data: T): ActionResult<T & { apiVersion: string }> {
  return { success: true, data: { ...data, apiVersion: API_VERSION } }
}

function fail<T>(error: string): ActionResult<T> {
  return { success: false, error }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asStringParam(params: Record<string, unknown>, key: string, maxLength = 200): string | null {
  const value = params[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null
}

async function getSession(tools: Tools, recordId: string): Promise<RallySession | null> {
  const result = await tools.get<SessionRow>('sessions', recordId)
  if (!result.success) return null
  return result.data.record.data
}

async function isParticipant(tools: Tools, sessionId: string, userId: string): Promise<boolean> {
  const session = await getSession(tools, sessionId)
  if (!session) return false
  if (session.hostId === userId) return true
  const rsvps = await tools.query<RsvpRow>('rsvps', { where: { sessionId, userId }, limit: 1 })
  if (!rsvps.success) return false
  return rsvps.data.records.some(record => record.data.status === 'going' || record.data.status === 'maybe')
}

/** Load the caller's own rows in a collection, newest first. */
async function listOwn<T extends Record<string, unknown>>(
  tools: Tools,
  collection: string,
  userId: string,
  limit = 50,
): Promise<{ recordId: string; data: T }[] | null> {
  const result = await tools.query<T>(collection, {
    where: { userId },
    orderBy: 'createdAt',
    orderDir: 'desc',
    limit,
  })
  if (!result.success) return null
  return result.data.records.map(record => ({ recordId: record.recordId, data: record.data }))
}

/** L01 — bounded, deterministic session search (see lib/extensions.ts). */
export const searchSessionsAction: ActionHandler<Env> = async ({ params, tools }) => {
  const q = typeof params.q === 'string' ? params.q : ''
  if (q.length > 200) return fail('Keep the search text under 200 characters.')
  const format = params.format
  if (format !== undefined && format !== 'any' && format !== 'singles' && format !== 'doubles' && format !== 'practice') {
    return fail('Choose a valid format filter.')
  }
  const level = params.level
  if (level !== undefined && level !== 'Any level' && level !== 'Beginner' && level !== 'Intermediate' && level !== 'Advanced') {
    return fail('Choose a valid level filter.')
  }
  const fromDate = typeof params.fromDate === 'string' ? params.fromDate : undefined
  const toDate = typeof params.toDate === 'string' ? params.toDate : undefined
  if ((fromDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) || (toDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(toDate))) {
    return fail('Use dates in YYYY-MM-DD form.')
  }
  const limit = params.limit === undefined ? 20 : Number(params.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return fail('Choose a result limit between 1 and 50.')

  const where: Record<string, unknown> = {}
  if (params.showCancelled !== true) where.status = 'open'
  const result = await tools.query<SessionRow>('sessions', {
    where,
    orderBy: 'startsAt',
    orderDir: 'asc',
    limit: EXTENSION_SCAN_LIMIT,
  })
  if (!result.success) return fail('Session search is temporarily unavailable.')
  const records: SessionRecord[] = result.data.records.map(record => ({ recordId: record.recordId, data: record.data }))
  const found = searchSessions(records, {
    q,
    format: (format as 'any' | 'singles' | 'doubles' | 'practice' | undefined) ?? 'any',
    level: (level as RallySession['level'] | 'Any level' | undefined) ?? 'Any level',
    fromDate,
    toDate,
    showCancelled: params.showCancelled === true,
    showPast: params.showPast === true,
    limit,
  })
  return ok({ sessions: found.sessions, truncated: found.truncated })
}

/** L02 — save a reusable session template (own records only, max 20). */
export const saveSessionTemplateAction: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const template = validateSessionTemplate(params.template ?? params)
  if (typeof template === 'string') return fail(template)
  const existing = await listOwn(tools, 'sessionTemplates', userId, MAX_TEMPLATES_PER_USER + 1)
  if (existing === null) return fail('Your templates could not be checked.')
  if (existing.length >= MAX_TEMPLATES_PER_USER) return fail('You can save up to 20 session templates.')
  const created = await tools.create('sessionTemplates', { ...template, userId })
  if (!created.success) return fail('Your template could not be saved.')
  return ok({ recordId: created.data.recordId })
}

export const listSessionTemplatesAction: ActionHandler<Env> = async ({ userId, tools }) => {
  const templates = await listOwn(tools, 'sessionTemplates', userId, 50)
  if (templates === null) return fail('Your templates could not be loaded.')
  return ok({ templates })
}

export const deleteSessionTemplateAction: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const recordId = asStringParam(params, 'recordId')
  if (recordId === null) return fail('Choose a template to delete.')
  const existing = await tools.get<Record<string, unknown>>('sessionTemplates', recordId)
  if (!existing.success) return ok({ deleted: false })
  if (existing.data.record.data.userId !== userId) return fail('This template is unavailable.')
  const removed = await tools.remove('sessionTemplates', recordId)
  if (!removed.success) return fail('Your template could not be deleted.')
  return ok({ deleted: true })
}

/** L03 — save a favourite court from court-discovery results only. */
export const saveFavoriteCourtAction: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const court = validateFavoriteCourt(params.court ?? params)
  if (typeof court === 'string') return fail(court)
  const existing = await tools.query('favoriteCourts', { where: { userId, placeId: court.placeId }, limit: 1 })
  if (!existing.success) return fail('Your favourite courts could not be checked.')
  if (existing.data.records.length > 0) {
    return ok({ recordId: existing.data.records[0].recordId, alreadySaved: true })
  }
  const all = await listOwn(tools, 'favoriteCourts', userId, MAX_FAVORITE_COURTS_PER_USER + 1)
  if (all === null) return fail('Your favourite courts could not be checked.')
  if (all.length >= MAX_FAVORITE_COURTS_PER_USER) return fail('You can save up to 50 favourite courts.')
  const created = await tools.create('favoriteCourts', { ...court, userId })
  if (!created.success) return fail('Your favourite court could not be saved.')
  return ok({ recordId: created.data.recordId, alreadySaved: false })
}

export const listFavoriteCourtsAction: ActionHandler<Env> = async ({ userId, tools }) => {
  const courts = await listOwn(tools, 'favoriteCourts', userId, 50)
  if (courts === null) return fail('Your favourite courts could not be loaded.')
  return ok({ courts })
}

export const removeFavoriteCourtAction: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const recordId = asStringParam(params, 'recordId')
  if (recordId === null) return fail('Choose a favourite court to remove.')
  const existing = await tools.get<Record<string, unknown>>('favoriteCourts', recordId)
  if (!existing.success) return ok({ removed: false })
  if (existing.data.record.data.userId !== userId) return fail('This favourite court is unavailable.')
  const removed = await tools.remove('favoriteCourts', recordId)
  if (!removed.success) return fail('Your favourite court could not be removed.')
  return ok({ removed: true })
}

/** L04 — recurring weekly availability windows (ranking signal only). */
export const addAvailabilityWindowAction: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const window = validateAvailabilityWindow(params.window ?? params)
  if (typeof window === 'string') return fail(window)
  const existing = await tools.query('availabilityWindows', {
    where: { userId, dayOfWeek: window.dayOfWeek, startMinutes: window.startMinutes },
    limit: 1,
  })
  if (!existing.success) return fail('Your availability could not be checked.')
  if (existing.data.records.length > 0) {
    return ok({ recordId: existing.data.records[0].recordId, alreadyExists: true })
  }
  const all = await listOwn(tools, 'availabilityWindows', userId, MAX_AVAILABILITY_WINDOWS_PER_USER + 1)
  if (all === null) return fail('Your availability could not be checked.')
  if (all.length >= MAX_AVAILABILITY_WINDOWS_PER_USER) return fail('You can save up to 14 availability windows.')
  const created = await tools.create('availabilityWindows', { ...window, userId })
  if (!created.success) return fail('Your availability window could not be saved.')
  return ok({ recordId: created.data.recordId, alreadyExists: false })
}

export const listAvailabilityWindowsAction: ActionHandler<Env> = async ({ userId, tools }) => {
  const windows = await listOwn(tools, 'availabilityWindows', userId, 50)
  if (windows === null) return fail('Your availability could not be loaded.')
  return ok({ windows })
}

export const removeAvailabilityWindowAction: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const recordId = asStringParam(params, 'recordId')
  if (recordId === null) return fail('Choose an availability window to remove.')
  const existing = await tools.get<Record<string, unknown>>('availabilityWindows', recordId)
  if (!existing.success) return ok({ removed: false })
  if (existing.data.record.data.userId !== userId) return fail('This availability window is unavailable.')
  const removed = await tools.remove('availabilityWindows', recordId)
  if (!removed.success) return fail('Your availability window could not be removed.')
  return ok({ removed: true })
}

/** L05 — reminders computed at read time; no records, no cron, no timers. */
export const upcomingRemindersAction: ActionHandler<Env> = async ({ userId, tools }) => {
  const rsvps = await tools.query<RsvpRow>('rsvps', { where: { userId, status: 'going' }, limit: EXTENSION_SCAN_LIMIT })
  if (!rsvps.success) return fail('Your reminders could not be loaded.')
  const sessions = await tools.query<SessionRow>('sessions', {
    where: { status: 'open' },
    orderBy: 'startsAt',
    orderDir: 'asc',
    limit: EXTENSION_SCAN_LIMIT,
  })
  if (!sessions.success) return fail('Your reminders could not be loaded.')
  const records: SessionRecord[] = sessions.data.records.map(record => ({ recordId: record.recordId, data: record.data }))
  const reminders = upcomingReminders(records, rsvps.data.records.map(record => record.data), userId)
  return ok({ reminders, truncated: rsvps.data.records.length >= EXTENSION_SCAN_LIMIT || records.length >= EXTENSION_SCAN_LIMIT })
}

/** L06 — export the caller's own records as JSON. Own data only, bounded. */
export const exportMyDataAction: ActionHandler<Env> = async ({ userId, tools }) => {
  const [hosted, rsvps, waitlisted, templates, courts, windows, notes] = await Promise.all([
    tools.query<SessionRow>('sessions', { where: { hostId: userId }, limit: EXTENSION_SCAN_LIMIT }),
    tools.query<RsvpRow>('rsvps', { where: { userId }, limit: EXTENSION_SCAN_LIMIT }),
    tools.query('waitlists', { where: { userId }, limit: EXTENSION_SCAN_LIMIT }),
    tools.query('sessionTemplates', { where: { userId }, limit: 50 }),
    tools.query('favoriteCourts', { where: { userId }, limit: 50 }),
    tools.query('availabilityWindows', { where: { userId }, limit: 50 }),
    tools.query('matchNotes', { where: { authorId: userId }, limit: EXTENSION_SCAN_LIMIT }),
  ])
  if (!hosted.success || !rsvps.success || !waitlisted.success || !templates.success || !courts.success || !windows.success || !notes.success) {
    return fail('Your data could not be exported right now.')
  }
  // Finalized results the caller played in, from the sessions they hosted
  // or RSVP'd to — disputed or unfinalized results are never exported as
  // results. One bounded scan, filtered in-handler to the caller's sessions.
  const sessionIds = new Set([
    ...hosted.data.records.map(record => record.recordId),
    ...rsvps.data.records.map(record => record.data.sessionId),
  ])
  const allSessions = await tools.query<SessionRow>('sessions', { limit: EXTENSION_SCAN_LIMIT })
  if (!allSessions.success) return fail('Your data could not be exported right now.')
  const results: { sessionId: string; title: string; winner: number | null; sets: [number, number][]; approvals: string[] }[] = []
  for (const record of allSessions.data.records) {
    if (!sessionIds.has(record.recordId)) continue
    const score = readMatchScore(record.data.matchScore)
    if (score && resultStatus(score) === 'final') {
      results.push({
        sessionId: record.recordId,
        title: record.data.title,
        winner: score.winner,
        sets: score.sets,
        approvals: score.approvals,
      })
    }
  }
  const truncated =
    hosted.data.records.length >= EXTENSION_SCAN_LIMIT ||
    rsvps.data.records.length >= EXTENSION_SCAN_LIMIT ||
    waitlisted.data.records.length >= EXTENSION_SCAN_LIMIT
  return ok({
    sessions: hosted.data.records.map(record => ({ recordId: record.recordId, ...record.data })),
    rsvps: rsvps.data.records.map(record => ({ recordId: record.recordId, ...record.data })),
    waitlist: waitlisted.data.records.map(record => ({ recordId: record.recordId, ...record.data })),
    results,
    templates: templates.data.records.map(record => ({ recordId: record.recordId, ...record.data })),
    favoriteCourts: courts.data.records.map(record => ({ recordId: record.recordId, ...record.data })),
    availabilityWindows: windows.data.records.map(record => ({ recordId: record.recordId, ...record.data })),
    matchNotes: notes.data.records.map(record => ({ recordId: record.recordId, ...record.data })),
    truncated,
  })
}

/** L07 — the caller reads their own match audit entries only. */
export const myMatchAuditsAction: ActionHandler<Env> = async ({ userId, tools }) => {
  const rsvps = await tools.query<RsvpRow>('rsvps', { where: { userId, status: 'going' }, limit: EXTENSION_SCAN_LIMIT })
  if (!rsvps.success) return fail('Your match history could not be loaded.')
  const sessionIds = [...new Set(rsvps.data.records.map(record => record.data.sessionId))]
  const audits: { sessionId: string; title: string; status: string; winner: number | null; approvals: string[]; disputed: boolean; revision: number }[] = []
  for (const sessionId of sessionIds) {
    const session = await getSession(tools, sessionId)
    if (!session) continue
    const score = readMatchScore(session.matchScore)
    if (!score) continue
    if (!score.teams.flat().includes(userId)) continue
    audits.push({
      sessionId,
      title: session.title,
      status: resultStatus(score),
      winner: score.winner,
      approvals: score.approvals,
      disputed: score.disputed,
      revision: score.revision,
    })
  }
  return ok({ audits, truncated: sessionIds.length >= EXTENSION_SCAN_LIMIT })
}

/** L08 — host-only match notes, visible to participants only. */
export const addMatchNoteAction: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const sessionId = asStringParam(params, 'sessionId')
  if (sessionId === null) return fail('Choose a session for the note.')
  const noteError = validateMatchNote(params.note)
  if (noteError) return fail(noteError)
  const session = await getSession(tools, sessionId)
  if (!session) return fail('This session is unavailable.')
  if (session.hostId !== userId) return fail('Only the session host can add a match note.')
  const score = readMatchScore(session.matchScore)
  if (!score || resultStatus(score) !== 'final') return fail('Match notes are only available on finalized matches.')
  const existing = await tools.query('matchNotes', { where: { sessionId }, limit: MAX_MATCH_NOTES_PER_SESSION + 1 })
  if (!existing.success) return fail('Match notes could not be checked.')
  if (existing.data.records.length >= MAX_MATCH_NOTES_PER_SESSION) return fail('This match already has the maximum number of notes.')
  const created = await tools.create('matchNotes', { sessionId, authorId: userId, note: (params.note as string).trim() })
  if (!created.success) return fail('Your match note could not be saved.')
  return ok({ recordId: created.data.recordId })
}

export const listMatchNotesAction: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const sessionId = asStringParam(params, 'sessionId')
  if (sessionId === null) return fail('Choose a session to read notes for.')
  if (!(await isParticipant(tools, sessionId, userId))) return fail('Match notes are only visible to participants.')
  const notes = await tools.query('matchNotes', {
    where: { sessionId },
    orderBy: 'createdAt',
    orderDir: 'asc',
    limit: MAX_MATCH_NOTES_PER_SESSION,
  })
  if (!notes.success) return fail('Match notes could not be loaded.')
  return ok({ notes: notes.data.records.map(record => ({ recordId: record.recordId, ...record.data })) })
}

/**
 * L09 — chat moderation overlay. Resolves the channel to its session and
 * requires the host; the SDK's messages are never mutated here.
 */
async function moderatedSession(tools: Tools, channelId: string, userId: string): Promise<RallySession | null> {
  const sessions = await tools.query<SessionRow>('sessions', { where: { chatChannelId: channelId }, limit: 1 })
  if (!sessions.success || sessions.data.records.length === 0) return null
  const session = sessions.data.records[0].data
  return session.hostId === userId ? session : null
}

function moderationAction(action: 'pinned' | 'removed'): ActionHandler<Env> {
  return async ({ userId, params, tools }) => {
    const channelId = asStringParam(params, 'channelId')
    const messageId = validateChatMessageId(params.messageId)
    if (channelId === null || messageId === null) return fail('Choose a chat message to moderate.')
    if ((await moderatedSession(tools, channelId, userId)) === null) {
      return fail('Only the session host can moderate its chat.')
    }
    const existing = await tools.query('chatModeration', { where: { channelId, messageId, action }, limit: 1 })
    if (!existing.success) return fail('Chat moderation could not be checked.')
    if (existing.data.records.length > 0) {
      return ok({ recordId: existing.data.records[0].recordId, alreadyApplied: true })
    }
    const created = await tools.create('chatModeration', { channelId, messageId, action, actorId: userId })
    if (!created.success) return fail('Your moderation decision could not be saved.')
    return ok({ recordId: created.data.recordId, alreadyApplied: false })
  }
}

export const pinChatMessageAction = moderationAction('pinned')
export const removeChatMessageAction = moderationAction('removed')

export const clearChatModerationAction: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const channelId = asStringParam(params, 'channelId')
  const messageId = validateChatMessageId(params.messageId)
  const action = params.action
  if (channelId === null || messageId === null || (action !== 'pinned' && action !== 'removed')) {
    return fail('Choose a moderation decision to clear.')
  }
  if ((await moderatedSession(tools, channelId, userId)) === null) {
    return fail('Only the session host can moderate its chat.')
  }
  const removed = await tools.deleteWhere('chatModeration', { channelId, messageId, action }, 1)
  if (!removed.success) return fail('Your moderation decision could not be cleared.')
  return ok({ cleared: removed.data.deleted > 0 })
}

export const listChatModerationAction: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const channelId = asStringParam(params, 'channelId')
  if (channelId === null) return fail('Choose a chat channel.')
  const sessions = await tools.query<SessionRow>('sessions', { where: { chatChannelId: channelId }, limit: 1 })
  if (!sessions.success || sessions.data.records.length === 0) return fail('This chat is unavailable.')
  const session = sessions.data.records[0]
  if (!(await isParticipant(tools, session.recordId, userId))) return fail('Chat moderation is only visible to participants.')
  const rows = await tools.query('chatModeration', {
    where: { channelId },
    orderBy: 'createdAt',
    orderDir: 'asc',
    limit: 100,
  })
  if (!rows.success) return fail('Chat moderation could not be loaded.')
  return ok({ moderation: rows.data.records.map(record => ({ recordId: record.recordId, ...record.data })) })
}

/** L10 — the caller's own waitlist position (1-based), never anyone else's. */
export const waitlistPositionAction: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const sessionId = asStringParam(params, 'sessionId')
  if (sessionId === null) return fail('Choose a session to check.')
  const queued = await tools.query('waitlists', {
    where: { sessionId },
    orderBy: 'createdAt',
    orderDir: 'asc',
    limit: EXTENSION_SCAN_LIMIT,
  })
  if (!queued.success) return fail('Your waitlist position could not be checked.')
  const index = queued.data.records.findIndex(record => isRecord(record.data) && record.data.userId === userId)
  // Only the caller's own position is returned; the queue length is never exposed.
  return ok({ queued: index >= 0, position: index >= 0 ? index + 1 : null })
}

/** L12 — advisory duplicate detection (see lib/extensions.ts). */
export const findDuplicateSessionAction: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const court = asStringParam(params, 'court', 100)
  const location = asStringParam(params, 'location', 100)
  const startsAt = typeof params.startsAt === 'string' ? params.startsAt : null
  if (court === null || location === null || startsAt === null || !Number.isFinite(Date.parse(startsAt))) {
    return fail('Provide a court, location, and start time to check.')
  }
  const hosted = await tools.query<SessionRow>('sessions', {
    where: { hostId: userId, status: 'open' },
    limit: EXTENSION_SCAN_LIMIT,
  })
  if (!hosted.success) return fail('Duplicate sessions could not be checked.')
  const records: SessionRecord[] = hosted.data.records.map(record => ({ recordId: record.recordId, data: record.data }))
  const duplicate = findDuplicateSession(records, userId, { court, location, startsAt })
  return ok({ duplicate: duplicate !== null, ...(duplicate ? { sessionId: duplicate.recordId, title: duplicate.title } : {}) })
}

/** L15 — read-only capability status for the frontend. No secrets, no internal state. */
export const appStatusAction: ActionHandler<Env> = async () => {
  return ok({
    features: {
      waitlist: true,
      scoreboard: true,
      courtDiscovery: true,
      calendarExport: true,
      courtboard: true,
      sessionSearch: true,
      sessionTemplates: true,
      favoriteCourts: true,
      availabilityWindows: true,
      reminders: true,
      dataExport: true,
      matchAudits: true,
      matchNotes: true,
      chatModeration: true,
      waitlistPosition: true,
      duplicateDetection: true,
    },
  })
}

export const extensionActions: Record<string, ActionHandler<Env>> = {
  searchSessions: searchSessionsAction,
  saveSessionTemplate: saveSessionTemplateAction,
  listSessionTemplates: listSessionTemplatesAction,
  deleteSessionTemplate: deleteSessionTemplateAction,
  saveFavoriteCourt: saveFavoriteCourtAction,
  listFavoriteCourts: listFavoriteCourtsAction,
  removeFavoriteCourt: removeFavoriteCourtAction,
  addAvailabilityWindow: addAvailabilityWindowAction,
  listAvailabilityWindows: listAvailabilityWindowsAction,
  removeAvailabilityWindow: removeAvailabilityWindowAction,
  upcomingReminders: upcomingRemindersAction,
  exportMyData: exportMyDataAction,
  myMatchAudits: myMatchAuditsAction,
  addMatchNote: addMatchNoteAction,
  listMatchNotes: listMatchNotesAction,
  pinChatMessage: pinChatMessageAction,
  removeChatMessage: removeChatMessageAction,
  clearChatModeration: clearChatModerationAction,
  listChatModeration: listChatModerationAction,
  waitlistPosition: waitlistPositionAction,
  findDuplicateSession: findDuplicateSessionAction,
  appStatus: appStatusAction,
}
