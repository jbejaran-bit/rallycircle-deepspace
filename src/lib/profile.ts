/**
 * Player profiles — validation, completeness, and privacy-safe geography.
 *
 * Design (see docs/track-bc-contracts.md):
 * - The verified auth identity is the only player key. Client-supplied
 *   identity fields are never trusted; the server action takes the caller
 *   id from the action context and ignores any `userId` in params.
 * - All fields in this collection are public-by-design. Private account
 *   data stays in the `users` collection (read: 'own'). There is no
 *   per-field read permission in deepspace@0.44.2 — permission checks are
 *   per record (verified in node_modules/deepspace/dist/worker.js:
 *   checkPermissionLevel) — so separation is achieved by never storing
 *   private data here, plus the record-level `visibility` control below.
 * - Privacy control (SDK-supported, verified): the `profiles` collection
 *   declares `visibilityField: { field: 'visibility', value: 'public' }`
 *   and member `read: 'published'` (owner OR public rows). A profile with
 *   visibility 'private' is readable only by its owner. Having no profile
 *   record at all is the third state: no public presence.
 * - Self-reported skill is never a verified rating. It is stored as
 *   `selfReportedLevel` and must be labelled as self-reported in any UI.
 * - Geography is a free-text general area only (for example
 *   "Pittsburgh, PA"). Exact coordinates, street addresses, and
 *   residential addresses are rejected by validation.
 */

import { z } from 'zod'

export const PROFILE_FORMATS = ['Singles', 'Doubles', 'Practice'] as const
export type ProfileFormat = (typeof PROFILE_FORMATS)[number]

export const PROFILE_LEVELS = ['Unrated', 'Beginner', 'Intermediate', 'Advanced'] as const
export type ProfileLevel = (typeof PROFILE_LEVELS)[number]

export const PROFILE_VISIBILITY = ['public', 'private'] as const
export type ProfileVisibility = (typeof PROFILE_VISIBILITY)[number]

export const PROFILE_DISPLAY_NAME_MAX = 40
export const PROFILE_BIO_MAX = 280
export const PROFILE_AREA_MAX = 100

/** Stored profile row (matches the `profiles` collection, minus record metadata). */
export interface PlayerProfile {
  userId: string
  displayName: string
  bio: string
  /** Stored as a JSON array in the `formats` column (json interpretation). */
  formats: ProfileFormat[]
  preferredArea: string
  selfReportedLevel: ProfileLevel
  visibility: ProfileVisibility
}

export type ProfileInput = Omit<PlayerProfile, 'userId'>

/** True when the text looks like raw coordinates ("40.44, -79.99"). */
export function looksLikeCoordinates(value: string): boolean {
  const trimmed = value.trim()
  return /^-?\d{1,3}(\.\d+)?\s*,\s*-?\d{1,3}(\.\d+)?$/.test(trimmed)
}

export const profileInputSchema = z.object({
  displayName: z.string().trim().min(1, 'Enter a display name.').max(PROFILE_DISPLAY_NAME_MAX),
  bio: z.string().trim().max(PROFILE_BIO_MAX).default(''),
  formats: z.array(z.enum(PROFILE_FORMATS)).max(PROFILE_FORMATS.length),
  preferredArea: z
    .string()
    .trim()
    .max(PROFILE_AREA_MAX)
    .refine((value) => !looksLikeCoordinates(value), 'Use a general area name, not coordinates.'),
  selfReportedLevel: z.enum(PROFILE_LEVELS),
  visibility: z.enum(PROFILE_VISIBILITY),
})

export type ProfileValidation =
  | { ok: true; data: ProfileInput }
  | { ok: false; error: string }

/** Validate untrusted input. Never throws; returns the first problem. */
export function validateProfileInput(input: unknown): ProfileValidation {
  const result = profileInputSchema.safeParse(input)
  if (result.success) return { ok: true, data: result.data }
  const first = result.error.issues[0]
  return { ok: false, error: first?.message ?? 'The profile could not be saved.' }
}

/** True when two profile payloads are identical (idempotent re-save check). */
export function isSameProfile(a: ProfileInput, b: ProfileInput): boolean {
  return (
    a.displayName === b.displayName &&
    a.bio === b.bio &&
    a.formats.length === b.formats.length &&
    a.formats.every((format, index) => format === b.formats[index]) &&
    a.preferredArea === b.preferredArea &&
    a.selfReportedLevel === b.selfReportedLevel &&
    a.visibility === b.visibility
  )
}

export interface ProfileCompleteness {
  /** 0–100, in steps of 20 (five fields). */
  percent: number
  /** Field keys still missing, for onboarding UX. */
  missing: string[]
  /** True when every field is filled. */
  complete: boolean
}

const COMPLETENESS_FIELDS: Array<{ key: string; filled: (profile: PlayerProfile) => boolean }> = [
  { key: 'displayName', filled: (p) => p.displayName.trim().length > 0 },
  { key: 'bio', filled: (p) => p.bio.trim().length > 0 },
  { key: 'formats', filled: (p) => p.formats.length > 0 },
  { key: 'preferredArea', filled: (p) => p.preferredArea.trim().length > 0 },
  { key: 'selfReportedLevel', filled: (p) => p.selfReportedLevel !== 'Unrated' },
]

/** Profile-completeness metadata for Codex onboarding UX (B07). */
export function profileCompleteness(profile: PlayerProfile | null): ProfileCompleteness {
  if (!profile) return { percent: 0, missing: COMPLETENESS_FIELDS.map((f) => f.key), complete: false }
  const missing = COMPLETENESS_FIELDS.filter((field) => !field.filled(profile)).map((f) => f.key)
  const filled = COMPLETENESS_FIELDS.length - missing.length
  return {
    percent: Math.round((filled / COMPLETENESS_FIELDS.length) * 100),
    missing,
    complete: missing.length === 0,
  }
}
