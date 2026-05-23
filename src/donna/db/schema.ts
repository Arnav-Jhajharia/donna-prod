import { pgTable, index, check, uuid, bigserial, text, jsonb, timestamp, unique, foreignKey, boolean, integer, date, numeric, primaryKey } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"



export const chatMessages = pgTable("chat_messages", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	seq: bigserial({ mode: "bigint" }).notNull(),
	userId: uuid("user_id").notNull(),
	role: text().notNull(),
	content: jsonb().notNull(),
	mode: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	metadata: jsonb().default({}).notNull(),
}, (table) => [
	index("idx_chat_messages_user_seq").using("btree", table.userId.asc().nullsLast().op("int8_ops"), table.seq.desc().nullsFirst().op("int8_ops")),
	check("chat_messages_mode_check", sql`mode = ANY (ARRAY['reactive'::text, 'proactive'::text])`),
	check("chat_messages_role_check", sql`role = ANY (ARRAY['user'::text, 'assistant'::text])`),
]);

export const inboundMessages = pgTable("inbound_messages", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	waMessageId: text("wa_message_id").notNull(),
	phone: text().notNull(),
	source: text().default('whatsapp').notNull(),
	body: jsonb().notNull(),
	receivedAt: timestamp("received_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_inbound_messages_phone_received").using("btree", table.phone.asc().nullsLast().op("text_ops"), table.receivedAt.desc().nullsFirst().op("text_ops")),
	unique("inbound_messages_wa_message_id_key").on(table.waMessageId),
]);

export const executionRuns = pgTable("execution_runs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	channel: text().notNull(),
	mode: text().notNull(),
	inboundMessageId: text("inbound_message_id"),
	status: text().notNull(),
	model: text(),
	terminator: text(),
	finalSends: jsonb("final_sends").default([]).notNull(),
	voiceViolations: jsonb("voice_violations").default([]).notNull(),
	metadata: jsonb().default({}).notNull(),
	error: text(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	endedAt: timestamp("ended_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("idx_execution_runs_inbound_message").using("btree", table.inboundMessageId.asc().nullsLast().op("text_ops")),
	index("idx_execution_runs_user_started").using("btree", table.userId.asc().nullsLast().op("timestamptz_ops"), table.startedAt.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "execution_runs_user_id_fkey"
		}).onDelete("cascade"),
	check("execution_runs_status_check", sql`status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text])`),
]);

export const users = pgTable("users", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	phone: text(),
	profileName: text("profile_name"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	clerkId: text("clerk_id"),
}, (table) => [
	index("idx_users_phone").using("btree", table.phone.asc().nullsLast().op("text_ops")),
	unique("users_phone_key").on(table.phone),
	unique("users_clerk_id_key").on(table.clerkId),
]);

export const executionEvents = pgTable("execution_events", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	seq: bigserial({ mode: "bigint" }).notNull(),
	runId: uuid("run_id").notNull(),
	type: text().notNull(),
	name: text(),
	payload: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_execution_events_run_seq").using("btree", table.runId.asc().nullsLast().op("int8_ops"), table.seq.asc().nullsLast().op("int8_ops")),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [executionRuns.id],
			name: "execution_events_run_id_fkey"
		}).onDelete("cascade"),
]);

export const integrationAudit = pgTable("integration_audit", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	provider: text().notNull(),
	action: text().notNull(),
	itemRef: text("item_ref"),
	caller: text(),
	ok: boolean().default(true).notNull(),
	durationMs: integer("duration_ms"),
	meta: jsonb().default({}).notNull(),
	occurredAt: timestamp("occurred_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("integration_audit_action_time_idx").using("btree", table.action.asc().nullsLast().op("text_ops"), table.occurredAt.desc().nullsFirst().op("timestamptz_ops")),
	index("integration_audit_user_provider_time_idx").using("btree", table.userId.asc().nullsLast().op("timestamptz_ops"), table.provider.asc().nullsLast().op("timestamptz_ops"), table.occurredAt.desc().nullsFirst().op("uuid_ops")),
]);

export const donnaStateDrafts = pgTable("donna_state_drafts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	provider: text().notNull(),
	threadRef: text("thread_ref"),
	intent: text(),
	status: text().default('pending_preview').notNull(),
	externalDraftId: text("external_draft_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("donna_state_drafts_user_status_idx").using("btree", table.userId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("text_ops")),
]);

export const donnaschedule = pgTable("donnaschedule", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	fireAt: timestamp("fire_at", { withTimezone: true, mode: 'string' }).notNull(),
	causeKind: text("cause_kind").notNull(),
	causePayload: jsonb("cause_payload").default({}).notNull(),
	instruction: text(),
	status: text().default('pending').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	claimedAt: timestamp("claimed_at", { withTimezone: true, mode: 'string' }),
	firedAt: timestamp("fired_at", { withTimezone: true, mode: 'string' }),
	erroredAt: timestamp("errored_at", { withTimezone: true, mode: 'string' }),
	errorMessage: text("error_message"),
	createdBy: text("created_by").notNull(),
}, (table) => [
	index("donnaschedule_claimed_recovery").using("btree", table.claimedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'claimed'::text)`),
	index("donnaschedule_pending_fire_at").using("btree", table.fireAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'pending'::text)`),
	index("donnaschedule_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "donnaschedule_user_id_fkey"
		}).onDelete("cascade"),
	check("donnaschedule_cause_kind_check", sql`cause_kind = ANY (ARRAY['scheduled'::text, 'scan_gmail'::text, 'watch_fired'::text, 'world_tick'::text])`),
	check("donnaschedule_created_by_check", sql`created_by = ANY (ARRAY['user'::text, 'donna_reactive'::text, 'donna_proactive'::text, 'system'::text])`),
	check("donnaschedule_status_check", sql`status = ANY (ARRAY['pending'::text, 'claimed'::text, 'fired'::text, 'errored'::text, 'cancelled'::text])`),
]);

export const foodGoals = pgTable("food_goals", {
	userId: uuid("user_id").primaryKey().notNull(),
	goalKind: text("goal_kind").notNull(),
	dailyKcal: integer("daily_kcal"),
	dailyProteinG: integer("daily_protein_g"),
	dailyCarbsG: integer("daily_carbs_g"),
	dailyFatG: integer("daily_fat_g"),
	dailyFiberG: integer("daily_fiber_g"),
	notes: text(),
	activeFrom: date("active_from").default(sql`CURRENT_DATE`).notNull(),
	proactiveNudges: boolean("proactive_nudges").default(true).notNull(),
	timezone: text().default('Asia/Singapore').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "food_goals_user_id_fkey"
		}).onDelete("cascade"),
	check("food_goals_goal_kind_check", sql`goal_kind = ANY (ARRAY['cut'::text, 'bulk'::text, 'maintain'::text, 'custom'::text])`),
]);

export const meals = pgTable("meals", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	occurredAt: timestamp("occurred_at", { withTimezone: true, mode: 'string' }).notNull(),
	loggedAt: timestamp("logged_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	mealType: text("meal_type"),
	sourceKind: text("source_kind").notNull(),
	sourceMessageId: text("source_message_id"),
	rawInput: text("raw_input"),
	visionDescription: text("vision_description"),
	totalKcal: numeric("total_kcal").default('0').notNull(),
	totalProteinG: numeric("total_protein_g").default('0').notNull(),
	totalCarbsG: numeric("total_carbs_g").default('0').notNull(),
	totalFatG: numeric("total_fat_g").default('0').notNull(),
	totalFiberG: numeric("total_fiber_g").default('0').notNull(),
	totalSodiumMg: numeric("total_sodium_mg").default('0').notNull(),
	confidence: text(),
	parser: text(),
	isDeleted: boolean("is_deleted").default(false).notNull(),
	notes: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("meals_user_occurred_idx").using("btree", table.userId.asc().nullsLast().op("timestamptz_ops"), table.occurredAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(NOT is_deleted)`),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "meals_user_id_fkey"
		}).onDelete("cascade"),
	check("meals_confidence_check", sql`confidence = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text])`),
	check("meals_meal_type_check", sql`meal_type = ANY (ARRAY['breakfast'::text, 'lunch'::text, 'dinner'::text, 'snack'::text])`),
	check("meals_parser_check", sql`parser = ANY (ARRAY['nutritionix'::text, 'llm'::text, 'mixed'::text])`),
	check("meals_source_kind_check", sql`source_kind = ANY (ARRAY['text'::text, 'photo'::text, 'voice'::text, 'alias'::text, 'edit'::text])`),
]);

export const mealItems = pgTable("meal_items", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	mealId: uuid("meal_id").notNull(),
	position: integer().notNull(),
	name: text().notNull(),
	quantity: numeric(),
	unit: text(),
	servingGrams: numeric("serving_grams"),
	kcal: numeric().default('0').notNull(),
	proteinG: numeric("protein_g").default('0').notNull(),
	carbsG: numeric("carbs_g").default('0').notNull(),
	fatG: numeric("fat_g").default('0').notNull(),
	fiberG: numeric("fiber_g").default('0').notNull(),
	sodiumMg: numeric("sodium_mg").default('0').notNull(),
	nixId: text("nix_id"),
	fdcId: text("fdc_id"),
}, (table) => [
	foreignKey({
			columns: [table.mealId],
			foreignColumns: [meals.id],
			name: "meal_items_meal_id_fkey"
		}).onDelete("cascade"),
	unique("meal_items_meal_id_position_key").on(table.mealId, table.position),
]);

export const mealAliases = pgTable("meal_aliases", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	alias: text().notNull(),
	template: jsonb().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "meal_aliases_user_id_fkey"
		}).onDelete("cascade"),
	unique("meal_aliases_user_id_alias_key").on(table.userId, table.alias),
]);

export const foodCache = pgTable("food_cache", {
	queryNormalized: text("query_normalized").primaryKey().notNull(),
	source: text().notNull(),
	rawResponse: jsonb("raw_response").notNull(),
	ttlUntil: timestamp("ttl_until", { withTimezone: true, mode: 'string' }).notNull(),
	hitCount: integer("hit_count").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("food_cache_ttl_idx").using("btree", table.ttlUntil.asc().nullsLast().op("timestamptz_ops")),
	check("food_cache_source_check", sql`source = 'nutritionix'::text`),
]);

export const worldLedger = pgTable("world_ledger", {
	userId: uuid("user_id").notNull(),
	dedupKey: text("dedup_key").notNull(),
	firedAt: timestamp("fired_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("world_ledger_fired_at").using("btree", table.firedAt.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "world_ledger_user_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.userId, table.dedupKey], name: "world_ledger_pkey"}),
]);

export const worldDailyCount = pgTable("world_daily_count", {
	userId: uuid("user_id").notNull(),
	localDate: date("local_date").notNull(),
	count: integer().default(0).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "world_daily_count_user_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.userId, table.localDate], name: "world_daily_count_pkey"}),
]);

export const integrations = pgTable("integrations", {
	userId: uuid("user_id").notNull(),
	provider: text().notNull(),
	status: text().default('connected').notNull(),
	mode: text().default('smart_index').notNull(),
	exclusions: jsonb().default({"legal":true,"banking":true,"medical":true}).notNull(),
	config: jsonb().default({}).notNull(),
	composioAccountId: text("composio_account_id"),
	lastSyncAt: timestamp("last_sync_at", { withTimezone: true, mode: 'string' }),
	lastError: jsonb("last_error"),
	connectedAt: timestamp("connected_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("integrations_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops"), table.provider.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.userId, table.provider], name: "integrations_pkey"}),
]);
