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
import { trackBcSchemas } from './schemas/profiles-schema'

export const schemas: CollectionSchema[] = [
  usersSchema,
  settingsSchema,
  sessionsSchema,
  rsvpsSchema,
  waitlistsSchema,
  ...trackBcSchemas,
  CHANNELS_SCHEMA,
  MESSAGES_SCHEMA,
  REACTIONS_SCHEMA,
  CHANNEL_MEMBERS_SCHEMA,
  READ_RECEIPTS_SCHEMA,
]
