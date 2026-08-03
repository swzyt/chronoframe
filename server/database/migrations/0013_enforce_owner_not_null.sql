PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_photos` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`description` text,
	`width` integer,
	`height` integer,
	`aspect_ratio` real,
	`date_taken` text,
	`storage_key` text,
	`thumbnail_key` text,
	`file_size` integer,
	`last_modified` text,
	`original_url` text,
	`thumbnail_url` text,
	`thumbnail_hash` text,
	`tags` text,
	`exif` text,
	`latitude` real,
	`longitude` real,
	`country` text,
	`city` text,
	`location_name` text,
	`is_live_photo` integer DEFAULT 0 NOT NULL,
	`live_photo_video_url` text,
	`live_photo_video_key` text,
	`owner_user_id` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);--> statement-breakpoint
INSERT INTO `__new_photos` SELECT `id`, `title`, `description`, `width`, `height`, `aspect_ratio`, `date_taken`, `storage_key`, `thumbnail_key`, `file_size`, `last_modified`, `original_url`, `thumbnail_url`, `thumbnail_hash`, `tags`, `exif`, `latitude`, `longitude`, `country`, `city`, `location_name`, `is_live_photo`, `live_photo_video_url`, `live_photo_video_key`, `owner_user_id` FROM `photos`;--> statement-breakpoint
DROP TABLE `photos`;--> statement-breakpoint
ALTER TABLE `__new_photos` RENAME TO `photos`;--> statement-breakpoint
CREATE UNIQUE INDEX `photos_id_unique` ON `photos` (`id`);--> statement-breakpoint
CREATE TABLE `__new_albums` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`cover_photo_id` text,
	`is_hidden` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`owner_user_id` integer NOT NULL,
	FOREIGN KEY (`cover_photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);--> statement-breakpoint
INSERT INTO `__new_albums` SELECT `id`, `title`, `description`, `cover_photo_id`, `is_hidden`, `created_at`, `updated_at`, `owner_user_id` FROM `albums`;--> statement-breakpoint
DROP TABLE `albums`;--> statement-breakpoint
ALTER TABLE `__new_albums` RENAME TO `albums`;--> statement-breakpoint
CREATE TABLE `__new_pipeline_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`payload` text DEFAULT '{"type":"photo","storageKey":""}' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`status_stage` text,
	`error_message` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`completed_at` integer,
	`owner_user_id` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);--> statement-breakpoint
INSERT INTO `__new_pipeline_queue` SELECT `id`, `payload`, `priority`, `attempts`, `max_attempts`, `status`, `status_stage`, `error_message`, `created_at`, `completed_at`, `owner_user_id` FROM `pipeline_queue`;--> statement-breakpoint
DROP TABLE `pipeline_queue`;--> statement-breakpoint
ALTER TABLE `__new_pipeline_queue` RENAME TO `pipeline_queue`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
