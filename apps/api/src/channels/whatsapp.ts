import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * WhatsApp adapter through Twilio (the sandbox works for the hackathon: teammates text
 * "join <sandbox-word>" to the Twilio number, then "hades <join code>" to link).
 * Inbound: POST /api/channels/whatsapp/twilio (form-encoded), verified with X-Twilio-Signature.
 */
const SID = process.env.TWILIO_ACCOUNT_SID ?? "";
const AUTH = process.env.TWILIO_AUTH_TOKEN ?? "";
export const WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM ?? ""; // e.g. whatsapp:+14155238886

export const whatsappEnabled = () => !!(SID && AUTH && WHATSAPP_FROM);

export async function sendWhatsApp(to: string, body: string): Promise<void> {
  if (!whatsappEnabled()) return;
  const form = new URLSearchParams({ From: WHATSAPP_FROM, To: to.startsWith("whatsapp:") ? to : `whatsapp:${to}`, Body: body.slice(0, 1500) });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${SID}:${AUTH}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!res.ok) throw new Error(`Twilio send failed: ${res.status} ${await res.text()}`);
}

/** Twilio's request signature: HMAC-SHA1 over the full URL plus sorted POST params, base64. */
export function verifyTwilioSignature(url: string, params: Record<string, string>, signature: string | undefined): boolean {
  if (!AUTH) return false;
  if (!signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = createHmac("sha1", AUTH).update(data).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** TwiML reply body for the inbound webhook. */
export function twiml(message: string | null): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${message ? `<Message>${esc(message.slice(0, 1500))}</Message>` : ""}</Response>`;
}
