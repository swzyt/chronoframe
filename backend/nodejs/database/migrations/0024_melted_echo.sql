ALTER TABLE `albums` ADD `position` real DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `albums` SET `position` = (
  SELECT COUNT(*) FROM `albums` AS a2
  WHERE a2.`created_at` > `albums`.`created_at`
     OR (a2.`created_at` = `albums`.`created_at` AND a2.`id` < `albums`.`id`)
) * 1000;
