CREATE INDEX `idx_album_photos_album_position` ON `album_photos` (`album_id`,`position`);--> statement-breakpoint
CREATE INDEX `idx_album_photos_photo_id` ON `album_photos` (`photo_id`);--> statement-breakpoint
CREATE INDEX `idx_albums_is_hidden_created_at` ON `albums` (`is_hidden`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_albums_owner_user_id` ON `albums` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `idx_photos_storage_key` ON `photos` (`storage_key`);--> statement-breakpoint
CREATE INDEX `idx_photos_thumbnail_key` ON `photos` (`thumbnail_key`);--> statement-breakpoint
CREATE INDEX `idx_photos_display_key` ON `photos` (`display_key`);--> statement-breakpoint
CREATE INDEX `idx_photos_video_playback_key` ON `photos` (`video_playback_key`);--> statement-breakpoint
CREATE INDEX `idx_photos_live_photo_video_key` ON `photos` (`live_photo_video_key`);--> statement-breakpoint
CREATE INDEX `idx_photos_owner_user_id` ON `photos` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `idx_photos_last_modified` ON `photos` (`last_modified`,`date_taken`);--> statement-breakpoint
CREATE INDEX `idx_photos_location` ON `photos` (`latitude`,`longitude`);