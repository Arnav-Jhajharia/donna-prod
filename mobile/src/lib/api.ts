// thin fetch wrapper that injects the clerk session jwt on every request.
// the caller provides `getToken` (from clerk's useAuth) so this stays decoupled
// from react — easy to use inside hooks, easy to test.

const BASE_URL = process.env.EXPO_PUBLIC_DONNA_API_URL ?? "http://localhost:3000";

export type ApiOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  getToken: () => Promise<string | null>;
};

export async function api<T = unknown>(
  path: string,
  options: ApiOptions,
): Promise<T> {
  const token = await options.getToken();
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`api ${path} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}
