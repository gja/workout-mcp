-- Delete an account and everything hung on it. Replace every :user_id with the id, then:
--   npx wrangler d1 execute <workout-mcp --remote --file scripts/delete-user.sql
-- Rows linked to the account (users.alias_of_user_id) go too; they own nothing else.

DELETE FROM sessions             WHERE user_id = ':user_id';
DELETE FROM tokens               WHERE user_id = ':user_id';
DELETE FROM login_states         WHERE user_id = ':user_id';
DELETE FROM workouts             WHERE user_id = ':user_id';
DELETE FROM platform_links       WHERE user_id = ':user_id';
DELETE FROM platform_connections WHERE user_id = ':user_id';
DELETE FROM drive_copies         WHERE user_id = ':user_id';
DELETE FROM drive_connections    WHERE user_id = ':user_id';
DELETE FROM contexts             WHERE user_id = ':user_id';
DELETE FROM users                WHERE alias_of_user_id = ':user_id';
DELETE FROM users                WHERE id = ':user_id';
