/* Real-code tests for the Telegram delivery guarantee (bug #1) and chunk().
   Mocks global.fetch to exercise the ACTUAL sendTelegram retry / backoff /
   permanent-vs-transient logic end to end — not a mirror.
   Run: node tests/qs-telegram.test.mjs */
import assert from "node:assert/strict";

// sendTelegram no-ops unless both env vars are set — set dummies so it runs.
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "123";

const { sendTelegram, chunk } = await import("../netlify/lib/telegram.mjs");

let ok = 0, fail = 0;
const T = async (name, fn) => { try { await fn(); ok++; } catch (e) { fail++; console.log("❌", name, "\n   ", e.message); } };

// Install a scripted fetch: each call shifts the next response from `queue`.
let queue = [], calls = 0;
const reply = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});
global.fetch = async () => {
  calls++;
  const r = queue.length ? queue.shift() : reply(200, { result: { message_id: 99 } }); // default success
  if (r instanceof Error) throw r;
  return r;
};
const setup = (responses) => { queue = responses; calls = 0; };

/* 429 with retry_after:0 then 200 → retried, ultimately delivered. */
await T("429 → retry → success", async () => {
  setup([reply(429, { parameters: { retry_after: 0 } }), reply(200, { result: { message_id: 42 } })]);
  const res = await sendTelegram("hi");
  assert.equal(res.ok, true);
  assert.equal(res.messageId, 42);
  assert.equal(calls, 2);          // it actually retried once
});

/* 403 (bot blocked) → permanent, no retry, flagged permanent. */
await T("403 → permanent, not retried", async () => {
  setup([reply(403, { description: "bot blocked" }), reply(200, { result: { message_id: 1 } })]);
  const res = await sendTelegram("hi");
  assert.equal(res.ok, false);
  assert.equal(res.permanent, true);   // callers advance state (no wedge)
  assert.equal(calls, 1);              // did NOT retry a permanent failure
});

/* Transient network error, exhausted → not permanent → caller holds back. */
await T("network error exhausted → transient (not permanent)", async () => {
  setup([new Error("ECONNRESET"), new Error("ECONNRESET"), new Error("ECONNRESET"), new Error("ECONNRESET")]);
  const res = await sendTelegram("hi");
  assert.equal(res.ok, false);
  assert.equal(!!res.permanent, false);   // transient → dedup should NOT advance
  assert.ok(calls >= 2);                  // retried
});

/* Multi-chunk: a >3800-char message is split and each part posted. */
await T("multi-chunk send posts every part", async () => {
  const big = Array.from({ length: 900 }, (_, i) => "line-" + i).join("\n");
  const parts = chunk(big);
  assert.ok(parts.length >= 2);
  setup(parts.map((_, i) => reply(200, { result: { message_id: 100 + i } })));
  const res = await sendTelegram(big);
  assert.equal(res.ok, true);
  assert.equal(res.messageId, 100);       // FIRST chunk's id (for threading)
  assert.equal(calls, parts.length);      // every part posted
});

/* silent option sets disable_notification (inspect the payload fetch receives). */
await T("silent flag sets disable_notification", async () => {
  let seen = null;
  global.fetch = async (url, opts) => { seen = JSON.parse(opts.body); return reply(200, { result: { message_id: 1 } }); };
  await sendTelegram("hi", { silent: true });
  assert.equal(seen.disable_notification, true);
  const seen2 = await (async () => { let s; global.fetch = async (u, o) => { s = JSON.parse(o.body); return reply(200, { result: {} }); }; await sendTelegram("hi"); return s; })();
  assert.equal(seen2.disable_notification, undefined);   // loud by default
});

/* chunk() fuzz — random inputs never lose data or exceed the limit. */
await T("chunk() fuzz: 200 random inputs preserve data & bound size", async () => {
  // deterministic PRNG so failures reproduce
  let s = 12345; const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 200; i++) {
    const len = Math.floor(rnd() * 9000);
    const nlEvery = 1 + Math.floor(rnd() * 200);
    let str = "";
    for (let j = 0; j < len; j++) str += (j % nlEvery === 0 && j > 0) ? "\n" : "abcdefg "[Math.floor(rnd() * 8)];
    const parts = chunk(str, 3800);
    assert.ok(parts.every((p) => p.length <= 3800), `chunk exceeded limit at i=${i}`);
    assert.equal(parts.join("").replace(/\n/g, ""), str.replace(/\n/g, ""), `data loss at i=${i}`);
  }
});

console.log(`\n${ok} telegram/chunk real-code tests passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
