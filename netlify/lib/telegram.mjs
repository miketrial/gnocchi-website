/* ===== QUICK SWING FEATURE =====
   Telegram delivery for real-time BUY/SELL alerts. Self-contained and
   independently removable — see the removal checklist in
   netlify/lib/quickswing-pipeline.mjs (this file + the alert-cron/alert-
   background functions are the notification layer added on top of it).

   One helper: sendTelegram(text). Posts to the Bot API sendMessage endpoint
   using two env vars set in Netlify (never committed):
     TELEGRAM_BOT_TOKEN  — from @BotFather
     TELEGRAM_CHAT_ID    — the user's numeric chat id (from getUpdates)

   Deliberately a quiet no-op when either var is missing, so local dev and
   Deploy Previews never throw just because the secrets aren't wired up. */

export async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn("[telegram] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — skipping send");
    return { ok: false, skipped: true };
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      console.error(`[telegram] sendMessage → ${r.status}: ${body}`);
      return { ok: false, status: r.status };
    }
    return { ok: true };
  } catch (e) {
    console.error("[telegram] send error:", e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  }
}
