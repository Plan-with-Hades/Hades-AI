/**
 * ElevenLabs voice for Hades: spoken impact summaries in the console and voice notes for teammates on Telegram.
 * Without ELEVENLABS_API_KEY the console hides the play button and chats stay text-only.
 */
const KEY = process.env.ELEVENLABS_API_KEY ?? "";
/** "George", a premade ElevenLabs voice. Any voice id from the account works. */
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";
const MODEL = process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5";
const MAX_CHARS = 900;

export const voiceEnabled = () => KEY.length > 0;

const cache = new Map<string, Buffer>();

/** Text to MP3. Results are cached in memory so replaying a summary costs no extra credits. */
export async function speak(text: string): Promise<Buffer> {
  const clean = text.replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_CHARS);
  const hit = cache.get(clean);
  if (hit) return hit;
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": KEY, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text: clean, model_id: MODEL, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const audio = Buffer.from(await res.arrayBuffer());
  if (cache.size > 200) cache.delete(cache.keys().next().value as string);
  cache.set(clean, audio);
  return audio;
}
