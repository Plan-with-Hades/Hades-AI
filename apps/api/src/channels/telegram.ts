import { createHash } from "node:crypto";
/**
 * Telegram adapter for member agents.
 * - Production: Telegram calls POST /api/channels/telegram/webhook (verified with a secret token).
 * - Local dev: long-polls getUpdates, so no public URL is needed.
 * Teammates link by opening t.me/<bot>?start=<join code>.
 */
const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
/** Telegram only accepts A-Z a-z 0-9 _ - in a secret token, and Render's generated values contain other characters. */
export const TELEGRAM_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ? createHash("sha256").update(process.env.TELEGRAM_WEBHOOK_SECRET).digest("hex") : "";
const api = (method: string) => `https://api.telegram.org/bot${TOKEN}/${method}`;

export const telegramEnabled = () => TOKEN.length > 0;
let botUsername: string | null = null;

export interface TelegramInbound {
  chatId: string;
  text: string;
  displayName?: string;
}
export type InboundHandler = (msg: TelegramInbound) => Promise<string | null>;

async function call<T>(method: string, body: unknown): Promise<T> {
  const res = await fetch(api(method), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const json = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.description}`);
  return json.result;
}

export async function telegramBotUsername(): Promise<string | null> {
  if (!telegramEnabled()) return null;
  if (botUsername) return botUsername;
  try {
    const me = await call<{ username: string }>("getMe", {});
    botUsername = me.username;
  } catch (e) {
    console.error(e);
  }
  return botUsername;
}

export async function sendTelegram(chatId: string, text: string): Promise<void> {
  console.log(`Telegram: replying to ${chatId}`);
  if (!telegramEnabled()) return;
  // Telegram caps messages at 4096 characters.
  await call("sendMessage", { chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true });
}

/** Sends an MP3 as a Telegram voice note. */
export async function sendTelegramVoice(chatId: string, audio: Buffer, caption?: string): Promise<void> {
  const form = new FormData();
  form.append("chat_id", chatId);
  if (caption) form.append("caption", caption.slice(0, 1000));
  form.append("voice", new Blob([new Uint8Array(audio)], { type: "audio/mpeg" }), "hades.mp3");
  const res = await fetch(api("sendVoice"), { method: "POST", body: form });
  const json = (await res.json()) as { ok: boolean; description?: string };
  if (!json.ok) throw new Error(`Telegram sendVoice failed: ${json.description}`);
}

/** Normalises an update from either the webhook or getUpdates. */
export function parseUpdate(update: any): TelegramInbound | null {
  const m = update?.message ?? update?.edited_message;
  if (!m?.text || !m.chat?.id) return null;
  const name = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ") || m.from?.username;
  return { chatId: String(m.chat.id), text: String(m.text), displayName: name };
}

/**
 * Registers the webhook when PUBLIC_API_URL is set, otherwise starts long polling.
 */
async function setupTelegram(handler: InboundHandler) {
  if (!telegramEnabled()) {
    console.log("Telegram: TELEGRAM_BOT_TOKEN not set, channel disabled.");
    return;
  }
  const rawUrl = process.env.PUBLIC_API_URL ?? process.env.RENDER_EXTERNAL_URL;
  const publicUrl = rawUrl ? (/^https?:\/\//.test(rawUrl) ? rawUrl : `https://${rawUrl}`) : undefined;
  const username = await telegramBotUsername();
  if (publicUrl) {
    await call("setWebhook", {
      url: `${publicUrl.replace(/\/$/, "")}/api/channels/telegram/webhook`,
      secret_token: TELEGRAM_SECRET || undefined,
      allowed_updates: ["message", "edited_message"],
    });
    console.log(`Telegram: webhook set for @${username}`);
    // Telegram forgets nothing, but a failed or replaced webhook would silence the bot: re-check every 10 minutes.
    const expected = `${publicUrl.replace(/\/$/, "")}/api/channels/telegram/webhook`;
    setInterval(async () => {
      try {
        const info = await call<{ url?: string }>("getWebhookInfo", {});
        if (info.url !== expected) {
          await call("setWebhook", { url: expected, secret_token: TELEGRAM_SECRET || undefined, allowed_updates: ["message", "edited_message"] });
          console.log("Telegram: webhook restored");
        }
      } catch (e) {
        console.error("Telegram webhook check failed:", (e as Error).message);
      }
    }, 10 * 60_000);
    return;
  }
  await call("deleteWebhook", { drop_pending_updates: false });
  console.log(`Telegram: polling as @${username}`);
  let offset = 0;
  const loop = async () => {
    try {
      const updates = await call<any[]>("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "edited_message"] });
      for (const u of updates) {
        offset = u.update_id + 1;
        const msg = parseUpdate(u);
        if (!msg) continue;
        const reply = await handler(msg).catch((e) => `Something went wrong: ${(e as Error).message}`);
        if (reply) await sendTelegram(msg.chatId, reply);
      }
    } catch (e) {
      console.error("Telegram polling error:", (e as Error).message);
      await new Promise((r) => setTimeout(r, 3000));
    }
    setImmediate(loop);
  };
  loop();
}

/** Starts the bot, retrying while the network is not ready (Render's first seconds after boot often time out). */
export async function startTelegram(handler: InboundHandler) {
  if (!telegramEnabled()) {
    console.log("Telegram: TELEGRAM_BOT_TOKEN not set, channel disabled.");
    return;
  }
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      await setupTelegram(handler);
      return;
    } catch (e) {
      console.error(`Telegram start attempt ${attempt} failed:`, (e as Error).message);
      await new Promise((r) => setTimeout(r, Math.min(attempt * 3000, 30_000)));
    }
  }
  console.error("Telegram could not start after 30 attempts.");
}

export async function telegramWebhookInfo() {
  if (!telegramEnabled()) return { enabled: false };
  return call<Record<string, unknown>>("getWebhookInfo", {});
}
