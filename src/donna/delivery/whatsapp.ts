// minimal whatsapp cloud api client. one verb today: sendText.
//
// the brain emits an OutboundMessage union (text, buttons, list, cta_url,
// image, document, video, audio, delay). this file only renders `text` for
// now — enough to test the end-to-end echo loop. buttons/list/cta_url etc.
// port from `_archive/delivery-dir/whatsapp.ts` when the text loop is solid
// and we want richer interactions.

const GRAPH_VERSION = "v18.0";

function endpoint(phoneNumberId: string): string {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
}

// `to` accepts e.164 with or without leading `+`; meta wants it without.
function normalize(phone: string): string {
  return phone.startsWith("+") ? phone.slice(1) : phone;
}

export async function sendText(toPhone: string, body: string): Promise<void> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  if (!phoneNumberId || !token) {
    throw new Error(
      "WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_TOKEN required to send",
    );
  }

  const res = await fetch(endpoint(phoneNumberId), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: normalize(toPhone),
      type: "text",
      text: { body },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`whatsapp send failed: ${res.status} ${errBody}`);
  }
}
