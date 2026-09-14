ALTER TABLE `users` ADD `auth_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE TRIGGER `users_security_fields_bump_auth_version`
AFTER UPDATE OF `password`, `is_admin`, `is_active` ON `users`
FOR EACH ROW
WHEN NEW.`auth_version` = OLD.`auth_version`
  AND (
    NEW.`password` IS NOT OLD.`password`
    OR NEW.`is_admin` IS NOT OLD.`is_admin`
    OR NEW.`is_active` IS NOT OLD.`is_active`
  )
BEGIN
  UPDATE `users`
  SET `auth_version` = OLD.`auth_version` + 1
  WHERE `id` = OLD.`id`;
END;
