PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
	`available_at` integer DEFAULT (unixepoch()) NOT NULL,
	`claimed_by` text,
	`claim_token` text,
	`claim_expires_at` integer,
	`completed_at` integer,
	`owner_user_id` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);--> statement-breakpoint
INSERT INTO `__new_pipeline_queue` (
	`id`,
	`payload`,
	`priority`,
	`attempts`,
	`max_attempts`,
	`status`,
	`status_stage`,
	`error_message`,
	`created_at`,
	`available_at`,
	`claimed_by`,
	`claim_token`,
	`claim_expires_at`,
	`completed_at`,
	`owner_user_id`
) SELECT
	`id`,
	`payload`,
	`priority`,
	`attempts`,
	`max_attempts`,
	`status`,
	`status_stage`,
	`error_message`,
	`created_at`,
	`created_at`,
	NULL,
	NULL,
	NULL,
	`completed_at`,
	`owner_user_id`
FROM `pipeline_queue`;--> statement-breakpoint
DROP TABLE `pipeline_queue`;--> statement-breakpoint
ALTER TABLE `__new_pipeline_queue` RENAME TO `pipeline_queue`;--> statement-breakpoint
CREATE INDEX `idx_pipeline_queue_ready` ON `pipeline_queue` (`status`,`available_at`,`priority`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_pipeline_queue_claim_expires` ON `pipeline_queue` (`status`,`claim_expires_at`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
