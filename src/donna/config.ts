// runtime config loaded from process.env. read once, fail fast.

interface WhatsAppConfig {
  token: string;
  phoneNumberId: string;
  verifyToken: string;
  graphVersion: string;
}

interface AppConfig {
  whatsapp: WhatsAppConfig;
  cliUserId: string | null; // CLI-only fallback (src/index.ts). WA path resolves user via phone.
  port: number;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set`);
  return v;
}

let _config: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (_config) return _config;
  _config = {
    whatsapp: {
      token: required("WHATSAPP_TOKEN"),
      phoneNumberId: required("WHATSAPP_PHONE_NUMBER_ID"),
      verifyToken: required("WHATSAPP_VERIFY_TOKEN"),
      graphVersion: process.env.WHATSAPP_GRAPH_VERSION ?? "v19.0",
    },
    cliUserId: process.env.DONNA_USER_ID ?? null,
    port: Number(process.env.PORT ?? 3000),
  };
  return _config;
}
