CREATE TABLE `aggregate_revisions` (
	`user_id` text NOT NULL,
	`revision` integer NOT NULL,
	`published_at` integer NOT NULL,
	`mutation_id` text NOT NULL,
	`counts` text NOT NULL,
	PRIMARY KEY(`user_id`, `revision`),
	FOREIGN KEY (`user_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `aggregate_revision_time_idx` ON `aggregate_revisions` (`user_id`,`published_at`);--> statement-breakpoint
CREATE TABLE `aggregate_revocations` (
	`user_id` text NOT NULL,
	`week` integer NOT NULL,
	PRIMARY KEY(`user_id`, `week`)
);
--> statement-breakpoint
CREATE TABLE `aggregate_snapshots` (
	`user_id` text NOT NULL,
	`week` integer NOT NULL,
	`status` text NOT NULL,
	`total` integer,
	`cohort` text NOT NULL,
	`invalidated` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `week`),
	FOREIGN KEY (`user_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `aliases` (
	`owner_id` text NOT NULL,
	`friend_id` text NOT NULL,
	`alias` text NOT NULL,
	`alias_key` text NOT NULL,
	PRIMARY KEY(`owner_id`, `friend_id`),
	FOREIGN KEY (`owner_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`friend_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `aliases_owner_key_idx` ON `aliases` (`owner_id`,`alias_key`);--> statement-breakpoint
CREATE TABLE `audit_grudges` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`target_id` text NOT NULL,
	`kind` text NOT NULL,
	`severity` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `auth_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`answer_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer
);
--> statement-breakpoint
CREATE INDEX `auth_challenges_expiry_idx` ON `auth_challenges` (`expires_at`);--> statement-breakpoint
CREATE TABLE `auth_failures` (
	`username` text PRIMARY KEY NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `entry_origins` (
	`user_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`target_user_id` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `entry_id`),
	FOREIGN KEY (`user_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `friendships` (
	`low_id` text NOT NULL,
	`high_id` text NOT NULL,
	`requester_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`accepted_at` integer,
	PRIMARY KEY(`low_id`, `high_id`),
	FOREIGN KEY (`low_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`high_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `friendships_high_idx` ON `friendships` (`high_id`);--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`is_system` integer DEFAULT 0 NOT NULL,
	`platform_subject` text,
	`username` text,
	`password_hash` text,
	`display_name` text NOT NULL,
	`friend_code` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `members_platform_unique` ON `members` (`platform_subject`);--> statement-breakpoint
CREATE UNIQUE INDEX `members_username_unique` ON `members` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `members_code_unique` ON `members` (`friend_code`);--> statement-breakpoint
CREATE TABLE `notebooks` (
	`user_id` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `privacy_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`bucket` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rate_limits_expiry_idx` ON `rate_limits` (`expires_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_expiry_idx` ON `sessions` (`expires_at`);