import postgres from "postgres";

let _sql: ReturnType<typeof postgres> | null = null;

function init(): ReturnType<typeof postgres> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL not set");
  }
  // session pooler url; transform: { undefined: null } maps JS undefined to SQL NULL
  return postgres(url, { transform: { undefined: null } });
}

export function getSql(): ReturnType<typeof postgres> {
  if (!_sql) _sql = init();
  return _sql;
}

export async function closeDb(): Promise<void> {
  if (_sql) {
    await _sql.end();
    _sql = null;
  }
}
