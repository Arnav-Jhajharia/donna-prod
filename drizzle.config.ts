import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// drizzle-kit reads this to know where the live db is and where to write
// generated schema files. only used by the cli (npm run db:pull / generate);
// runtime code reads DATABASE_URL directly via src/donna/db.ts.
export default defineConfig({
  schema: "./src/donna/db/schema.ts",
  out:    "./src/donna/db/migrations-staging", // drizzle's own scratch dir for generated sql; we use supabase migrations as truth, not this.
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  // introspect the public schema by default.
  schemaFilter: ["public"],
});
