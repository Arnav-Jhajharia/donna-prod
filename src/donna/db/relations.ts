import { relations } from "drizzle-orm/relations";
import { users, executionRuns, executionEvents, donnaschedule, foodGoals, meals, mealItems, mealAliases, worldLedger, worldDailyCount } from "./schema";

export const executionRunsRelations = relations(executionRuns, ({one, many}) => ({
	user: one(users, {
		fields: [executionRuns.userId],
		references: [users.id]
	}),
	executionEvents: many(executionEvents),
}));

export const usersRelations = relations(users, ({many}) => ({
	executionRuns: many(executionRuns),
	donnaschedules: many(donnaschedule),
	foodGoals: many(foodGoals),
	meals: many(meals),
	mealAliases: many(mealAliases),
	worldLedgers: many(worldLedger),
	worldDailyCounts: many(worldDailyCount),
}));

export const executionEventsRelations = relations(executionEvents, ({one}) => ({
	executionRun: one(executionRuns, {
		fields: [executionEvents.runId],
		references: [executionRuns.id]
	}),
}));

export const donnascheduleRelations = relations(donnaschedule, ({one}) => ({
	user: one(users, {
		fields: [donnaschedule.userId],
		references: [users.id]
	}),
}));

export const foodGoalsRelations = relations(foodGoals, ({one}) => ({
	user: one(users, {
		fields: [foodGoals.userId],
		references: [users.id]
	}),
}));

export const mealsRelations = relations(meals, ({one, many}) => ({
	user: one(users, {
		fields: [meals.userId],
		references: [users.id]
	}),
	mealItems: many(mealItems),
}));

export const mealItemsRelations = relations(mealItems, ({one}) => ({
	meal: one(meals, {
		fields: [mealItems.mealId],
		references: [meals.id]
	}),
}));

export const mealAliasesRelations = relations(mealAliases, ({one}) => ({
	user: one(users, {
		fields: [mealAliases.userId],
		references: [users.id]
	}),
}));

export const worldLedgerRelations = relations(worldLedger, ({one}) => ({
	user: one(users, {
		fields: [worldLedger.userId],
		references: [users.id]
	}),
}));

export const worldDailyCountRelations = relations(worldDailyCount, ({one}) => ({
	user: one(users, {
		fields: [worldDailyCount.userId],
		references: [users.id]
	}),
}));