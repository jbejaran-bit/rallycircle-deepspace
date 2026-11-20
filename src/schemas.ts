import type { CollectionSchema } from 'deepspace/schema'
import {
  CHANNELS_SCHEMA,
  MESSAGES_SCHEMA,
  REACTIONS_SCHEMA,
  CHANNEL_MEMBERS_SCHEMA,
  READ_RECEIPTS_SCHEMA,
} from 'deepspace/schema'
import { usersSchema } from './schemas/users-schema'
import { settingsSchema } from './schemas/admin-schema'
import { sessionsSchema, rsvpsSchema, waitlistsSchema } from './schemas/rally-schema'
import { playerRatingsSchema, ratingChangesSchema } from './server/rating-records'

export const schemas: CollectionSchema[] = [
  usersSchema,
  settingsSchema,
  sessionsSchema,
  rsvpsSchema,
  waitlistsSchema,
  playerRatingsSchema,
  ratingChangesSchema,
  CHANNELS_SCHEMA,
  MESSAGES_SCHEMA,
  REACTIONS_SCHEMA,
  CHANNEL_MEMBERS_SCHEMA,
  READ_RECEIPTS_SCHEMA,
]
