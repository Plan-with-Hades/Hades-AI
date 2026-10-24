/**
 * Telegram adapter for member agents.
 * - Production: Telegram calls POST /api/channels/telegram/webhook (verified with a secret token).
 * - Local dev: long-polls getUpdates, so no public URL is needed.
 * Teammates link by opening t.me/<bot>?start=<join code>.
 */
const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
export const TELEGRAM_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
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
  const res = await fetch(api(method), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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
export async function startTelegram(handler: InboundHandler) {
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
