CREATE TABLE `upload_shares` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_hash` text NOT NULL,
	`owner_user_id` integer NOT NULL,
	`created_by_user_id` integer NOT NULL,
	`label` text,
	`is_active` integer DEFAULT true NOT NULL,
	`upload_count` integer DEFAULT 0 NOT NULL,
	`max_uploads` integer,
	`expires_at` integer,
	`last_used_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_upload_shares_token_hash` ON `upload_shares` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `idx_upload_shares_owner_user_id` ON `upload_shares` (`owner_user_id`);
--> statement-breakpoint
CREATE INDEX `idx_upload_shares_active_expires` ON `upload_shares` (`is_active`,`expires_at`);
