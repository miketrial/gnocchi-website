/* ===== QUICK SWING FEATURE =====
   Telegram delivery for the Bounce alert layer. Self-contained and independently
   removable — see the removal checklist in netlify/lib/quickswing-pipeline.mjs.

   sendTelegram(text, opts?) posts to the Bot API. Env vars (set in Netlify, never
   committed):
     TELEGRAM_BOT_TOKEN  — from @BotFather
     TELEGRAM_CHAT_ID    — the user's numeric chat id
   Quiet no-op when either is missing, so local dev / Deploy Previews never throw.

   Delivery guarantee (Section A): retries 429 (honoring retry_after) and 5xx with
   backoff, and splits any message over Telegram's 4096-char limit on line
   boundaries. Returns { ok, messageId, skipped } — callers use `ok` to gate their
   dedup state so a DROPPED alert re-fires next tick instead of being lost while
   the state silently advances. opts.silent → disable_notification (loud vs quiet
   tiers). opts.replyTo → reply_to_message_id (threading). */

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Stay safely under Telegram's 4096-char hard limit (HTML entities inflate length).
const MAX_LEN = 3800;
const MAX_ATTEMPTS = 4;

let _ok = 0, _fail = 0;
export function telegramStats() { return { ok: _ok, fail: _fail }; }

// Split on line boundaries; hard-split any single monster line as a last resort.
// Exported for tests.
export function chunk(text, max = MAX_LEN) {
  if (text.length <= max) return [text];
  const out = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (line.length > max) {
      if (cur) { out.push(cur); cur = ""; }
      for (let i = 0; i < line.length; i += max) out.push(line.slice(i, i + max));
      continue;
    }
    if (cur && cur.length + 1 + line.length > max) { out.push(cur); cur = ""; }
    cur = cur ? cur + "\n" + line : line;
  }
  if (cur) out.push(cur);
  return out;
}

async function postChunk(token, payload) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (r.ok) {
        const body = await r.json().catch(() => null);
        return { ok: true, messageId: body?.result?.message_id ?? null };
      }
      if (r.status === 429) {
        // Respect Telegram's requested cool-down, capped so we don't hang the fn.
        const body = await r.json().catch(() => null);
        const wait = Math.min(body?.parameters?.retry_after ?? 2 * (attempt + 1), 30);
        await delay(wait * 1000);
        continue;
      }
      if (r.status >= 500) { await delay(1500 * (attempt + 1)); continue; }
      // Other 4xx (bad HTML, chat blocked, …) won't fix on retry — log and stop.
      const errBody = await r.text().catch(() => "");
      console.error(`[telegram] sendMessage → ${r.status}: ${errBody}`);
      return { ok: false, status: r.status };
    } catch (e) {
      console.error("[telegram] send error:", e?.message || e);
      await delay(1000 * (attempt + 1));
    }
  }
  return { ok: false, status: 0 };
}

export async function sendTelegram(text, opts = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn("[telegram] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — skipping send");
    return { ok: false, skipped: true };
  }

  const parts = chunk(String(text ?? ""));
  let allOk = true, firstMessageId = null;
  for (let i = 0; i < parts.length; i++) {
    const payload = {
      chat_id: chatId,
      text: parts[i],
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(opts.silent ? { disable_notification: true } : {}),
      ...(i === 0 && opts.replyTo ? { reply_to_message_id: opts.replyTo } : {}),
    };
    const res = await postChunk(token, payload);
    if (res.ok) { _ok++; if (i === 0) firstMessageId = res.messageId; }
    else { _fail++; allOk = false; }
  }
  return { ok: allOk, messageId: firstMessageId };
}
