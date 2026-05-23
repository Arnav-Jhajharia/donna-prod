// verifies the db connection. runs `select 1`, prints the row, exits.
// used by `npm run db:ping` after any environment / credential change.
import { sql } from "../src/donna/db.js";

const rows = await sql`select 1 as ok`;
console.log("db ok:", rows[0]);
await sql.end();
