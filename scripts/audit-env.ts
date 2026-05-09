import { readFileSync } from "node:fs";
console.log("--- BEFORE dotenv ---");
const beforeUrl = process.env.DATABASE_URL ?? "(unset)";
const m1 = beforeUrl.match(/@([^:/?]+)/);
console.log("process.env.DATABASE_URL host:", m1 ? m1[1] : beforeUrl);

await import("dotenv/config");
console.log("\n--- AFTER dotenv ---");
const afterUrl = process.env.DATABASE_URL ?? "(unset)";
const m2 = afterUrl.match(/@([^:/?]+)/);
console.log("process.env.DATABASE_URL host:", m2 ? m2[1] : afterUrl);

console.log("\n--- .env file contents (DATABASE_URL only, masked) ---");
const lines = readFileSync(".env", "utf8").split("\n");
lines.forEach((l, i) => {
  if (/^DATABASE_URL=/i.test(l)) {
    const m = l.match(/@([^:/?]+)/);
    console.log(`  line ${i + 1}: host=${m ? m[1] : "(none)"}`);
  }
});
