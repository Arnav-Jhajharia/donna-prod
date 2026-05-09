import "../src/donna/env.js";
const u = process.env.DATABASE_URL ?? "";
const m = u.match(/@([^:/]+)/);
const userMatch = u.match(/postgresql:\/\/([^:]+):/);
console.log("Loaded DATABASE_URL host:", m ? m[1] : "(unparseable)");
console.log("Loaded DATABASE_URL user:", userMatch ? userMatch[1] : "(unparseable)");
