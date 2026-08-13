import { sql } from 'drizzle-orm'
import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import type { NeededExif } from '~~/shared/types/photo'
import type { StorageConfig } from '../services/storage'

type PipelineQueuePayload =
  | {
      type: 'photo'
      storageKey: string
      eraseLocation?: boolean
    }
  | {
      type: 'live-photo-video'
      storageKey: string
    }
  | {
      type: 'video'
      storageKey: string
    }
  | {
      type: 'photo-reverse-geocoding'
      photoId: string
      latitude?: number | null
      longitude?: number | null
    }
  | {
      type: 'photo-erase-location'
      photoId: string
    }

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('name').notNull().unique(),
  email: text('email').notNull().unique(),
  password: text('password'),
  avatar: text('avatar'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  isAdmin: integer('is_admin').default(0).notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).default(true).notNull(),
})

export const photos = sqliteTable(
  'photos',
  {
    id: text('id').primaryKey().unique(),
    title: text('title'),
    description: text('description'),
    width: integer('width'),
    height: integer('height'),
    aspectRatio: real('aspect_ratio'),
    mediaType: text('media_type', { enum: ['image', 'video'] })
      .default('image')
      .notNull(),
    duration: real('duration'),
    videoCodec: text('video_codec'),
    audioCodec: text('audio_codec'),
    videoPlaybackKey: text('video_playback_key'),
    dateTaken: text('date_taken'),
    storageKey: text('storage_key'),
    thumbnailKey: text('thumbnail_key'),
    displayKey: text('display_key'),
    fileSize: integer('file_size'),
    lastModified: text('last_modified'),
    originalUrl: text('original_url'),
    thumbnailUrl: text('thumbnail_url'),
    thumbnailHash: text('thumbnail_hash'),
    tags: text('tags', { mode: 'json' }).$type<string[]>(),
    exif: text('exif', { mode: 'json' }).$type<NeededExif>(),
    // 地理位置信息
    latitude: real('latitude'),
    longitude: real('longitude'),
    country: text('country'),
    city: text('city'),
    locationName: text('location_name'),
    // LivePhoto 相关字段
    isLivePhoto: integer('is_live_photo').default(0).notNull(),
    livePhotoVideoUrl: text('live_photo_video_url'),
    livePhotoVideoKey: text('live_photo_video_key'),
    ownerUserId: integer('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('idx_photos_storage_key').on(t.storageKey),
    index('idx_photos_thumbnail_key').on(t.thumbnailKey),
    index('idx_photos_display_key').on(t.displayKey),
    index('idx_photos_video_playback_key').on(t.videoPlaybackKey),
    index('idx_photos_live_photo_video_key').on(t.livePhotoVideoKey),
    index('idx_photos_owner_user_id').on(t.ownerUserId),
    index('idx_photos_last_modified').on(t.lastModified, t.dateTaken),
    index('idx_photos_location').on(t.latitude, t.longitude),
  ],
)

export const pipelineQueue = sqliteTable('pipeline_queue', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  payload: text('payload', { mode: 'json' })
    .$type<PipelineQueuePayload>()
    .notNull()
    .default({
      type: 'photo',
      storageKey: '',
    } satisfies PipelineQueuePayload),
  priority: integer('priority').default(0).notNull(),
  attempts: integer('attempts').default(0).notNull(),
  maxAttempts: integer('max_attempts').default(3).notNull(),
  status: text('status', {
    enum: [
      'pending', // Waiting to be processed
      'in-stages', // Currently being processed
      'completed', // Successfully processed
      'failed', // Processing failed
    ],
  })
    .notNull()
    .default('pending'),
  statusStage: text('status_stage', {
    enum: [
      'preprocessing',
      'metadata',
      'thumbnail',
      'exif',
      'motion-photo',
      'reverse-geocoding',
      'live-photo',
      'location-erase',
    ],
  }),
  errorMessage: text('error_message'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
  ownerUserId: integer('owner_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
})

// 照片表态表
export const photoReactions = sqliteTable('photo_reactions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  photoId: text('photo_id')
    .notNull()
    .references(() => photos.id, { onDelete: 'cascade' }),
  reactionType: text('reaction_type', {
    enum: ['like', 'love', 'amazing', 'funny', 'wow', 'sad', 'fire', 'sparkle'],
  }).notNull(),
  // 使用指纹而不是 IP 地址，更准确且支持匿名用户
  fingerprint: text('fingerprint').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

// 相簿表
export const albums = sqliteTable(
  'albums',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    title: text('title').notNull(),
    description: text('description'),
    coverPhotoId: text('cover_photo_id').references(() => photos.id, {
      onDelete: 'set null',
    }),
    isHidden: integer('is_hidden', { mode: 'boolean' })
      .default(false)
      .notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    ownerUserId: integer('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('idx_albums_is_hidden_created_at').on(t.isHidden, t.createdAt),
    index('idx_albums_owner_user_id').on(t.ownerUserId),
  ],
)

// 相簿-照片 多对多关系表
export const albumPhotos = sqliteTable(
  'album_photos',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    albumId: integer('album_id')
      .notNull()
      .references(() => albums.id, { onDelete: 'cascade' }),
    photoId: text('photo_id')
      .notNull()
      .references(() => photos.id, { onDelete: 'cascade' }),
    position: real('position').notNull().default(1000000),
    addedAt: integer('added_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    index('idx_album_photos_album_position').on(t.albumId, t.position),
    index('idx_album_photos_photo_id').on(t.photoId),
  ],
)

export const uploadShares = sqliteTable(
  'upload_shares',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tokenHash: text('token_hash').notNull().unique(),
    token: text('token'),
    ownerUserId: integer('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdByUserId: integer('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: text('label'),
    isActive: integer('is_active', { mode: 'boolean' })
      .default(true)
      .notNull(),
    uploadCount: integer('upload_count').default(0).notNull(),
    maxUploads: integer('max_uploads'),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex('idx_upload_shares_token_hash').on(t.tokenHash),
    index('idx_upload_shares_owner_user_id').on(t.ownerUserId),
    index('idx_upload_shares_active_expires').on(t.isActive, t.expiresAt),
  ],
)

export const settings = sqliteTable(
  'settings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    namespace: text('namespace').notNull().default('common'),
    key: text('key').notNull(),
    type: text('type', {
      enum: ['string', 'number', 'boolean', 'json'],
    }).notNull(),
    value: text('value'),
    defaultValue: text('default_value'),
    label: text('label'),
    description: text('description'),
    isPublic: integer('is_public', { mode: 'boolean' })
      .default(false)
      .notNull(),
    isReadonly: integer('is_readonly', { mode: 'boolean' })
      .default(false)
      .notNull(),
    isSecret: integer('is_secret', { mode: 'boolean' })
      .default(false)
      .notNull(),
    enum: text('enum', { mode: 'json' }).$type<string[] | null>(),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedBy: integer('updated_by').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [uniqueIndex('idx_namespace_key').on(t.namespace, t.key)],
)

export const settings_storage_providers = sqliteTable(
  'settings_storage_providers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    provider: text('provider', {
      enum: ['s3', 'local', 'openlist'],
    }).notNull(),
    config: text('config', { mode: 'json' }).$type<StorageConfig>().notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
)
