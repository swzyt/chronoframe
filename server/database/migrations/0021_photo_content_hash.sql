ALTER TABLE `photos` ADD `content_hash` text;
CREATE INDEX `idx_photos_owner_content_hash` ON `photos` (`owner_user_id`,`content_hash`);
