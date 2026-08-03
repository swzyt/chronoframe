ALTER TABLE `photos` ADD `media_type` text DEFAULT 'image' NOT NULL;--> statement-breakpoint
ALTER TABLE `photos` ADD `duration` real;--> statement-breakpoint
ALTER TABLE `photos` ADD `video_codec` text;--> statement-breakpoint
ALTER TABLE `photos` ADD `audio_codec` text;