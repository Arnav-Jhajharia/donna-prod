// supabase storage uploads for meal media (photos, voice notes) and weekly
// charts. uses the rest endpoint so we don't add the supabase-js dep.
//
// buckets must be created out-of-band in the supabase dashboard:
//   meal_media   (private)
//   meal_charts  (private)

const DEFAULT_MEDIA = "meal_media";
const DEFAULT_CHARTS = "meal_charts";
const SIGNED_TTL_SECONDS = 60 * 60 * 24; // 24h

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`storage: ${name} not set`);
  return v;
}

async function uploadBytes(
  bucket: string,
  path: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  const url = `${need("SUPABASE_URL")}/storage/v1/object/${bucket}/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${need("SUPABASE_SERVICE_ROLE_KEY")}`,
      "content-type": contentType,
      "x-upsert": "true",
    },
    body: bytes as BlobPart,
  });
  if (!res.ok) {
    throw new Error(
      `storage upload ${bucket}/${path}: ${res.status} ${await res.text()}`,
    );
  }
}

async function signedUrl(bucket: string, path: string): Promise<string> {
  const url = `${need("SUPABASE_URL")}/storage/v1/object/sign/${bucket}/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${need("SUPABASE_SERVICE_ROLE_KEY")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ expiresIn: SIGNED_TTL_SECONDS }),
  });
  if (!res.ok) {
    throw new Error(
      `storage sign ${bucket}/${path}: ${res.status} ${await res.text()}`,
    );
  }
  const json = (await res.json()) as { signedURL?: string };
  if (!json.signedURL) throw new Error("storage: no signedURL in response");
  return `${need("SUPABASE_URL")}/storage/v1${json.signedURL}`;
}

export async function uploadMealMedia(args: {
  userId: string;
  messageId: string;
  bytes: Uint8Array;
  mimeType: string;
}): Promise<{ path: string; signedUrl: string }> {
  const bucket = process.env.SUPABASE_STORAGE_BUCKET_MEDIA ?? DEFAULT_MEDIA;
  const ext = args.mimeType.split("/")[1]?.split(";")[0] || "bin";
  const path = `${args.userId}/${args.messageId}.${ext}`;
  await uploadBytes(bucket, path, args.bytes, args.mimeType);
  return { path, signedUrl: await signedUrl(bucket, path) };
}

export async function uploadChartPng(args: {
  userId: string;
  isoWeek: string;
  bytes: Uint8Array;
}): Promise<{ path: string; signedUrl: string }> {
  const bucket = process.env.SUPABASE_STORAGE_BUCKET_CHARTS ?? DEFAULT_CHARTS;
  const path = `${args.userId}/${args.isoWeek}.png`;
  await uploadBytes(bucket, path, args.bytes, "image/png");
  return { path, signedUrl: await signedUrl(bucket, path) };
}
