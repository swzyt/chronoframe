ALTER TABLE `albums` ADD `owner_user_id` integer REFERENCES users(id);--> statement-breakpoint
UPDATE `albums` SET `owner_user_id` = (SELECT `id` FROM `users` WHERE `is_admin` = 1 ORDER BY `created_at`, `id` LIMIT 1) WHERE `owner_user_id` IS NULL;--> statement-breakpoint
ALTER TABLE `photos` ADD `owner_user_id` integer REFERENCES users(id);--> statement-breakpoint
UPDATE `photos` SET `owner_user_id` = (SELECT `id` FROM `users` WHERE `is_admin` = 1 ORDER BY `created_at`, `id` LIMIT 1) WHERE `owner_user_id` IS NULL;--> statement-breakpoint
ALTER TABLE `pipeline_queue` ADD `owner_user_id` integer REFERENCES users(id);--> statement-breakpoint
UPDATE `pipeline_queue` SET `owner_user_id` = (SELECT `id` FROM `users` WHERE `is_admin` = 1 ORDER BY `created_at`, `id` LIMIT 1) WHERE `owner_user_id` IS NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `is_active` integer DEFAULT true NOT NULL;
