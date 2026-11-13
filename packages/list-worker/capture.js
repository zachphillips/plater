// capture — the part of plater-list that decides whether a sign-up or inquiry
// is safe, kept free of Cloudflare imports so the guard test can run it in Node.
//
// The rule this file exists for: a submission is never only in one place that
// can refuse. Every accepted submission goes to the list database (D1) AND to a
// second place that reaches the owner and does not depend on D1 (an email,
// through the Worker's send_email binding). The answer to the visitor is "ok"
// only when at least one of the two took it and any unfinished delivery is
// repairable. The full submission is journaled in KV BEFORE either delivery:
// a Worker restart between D1 and mail must not strand it in one place. The
// journal is removed only after both deliveries finish. Repair is at least
// once: an interrupted or timed-out send can be delivered again.
//
// Places are injected so this module never imports cloudflare:* and a test can
// make either place fail on purpose.

// No silent cuts. A note is stored whole up to NOTE_MAX characters; past that
// the request is refused with a plain message instead of being shortened. The
// bound exists only so one request cannot carry megabytes: a long inquiry is a
// few thousand characters, this is 50,000.
export const NOTE_MAX = 50_000;
// Bytes of request body accepted before parsing (the note, as UTF-8 JSON, plus
// the other fields). Comfortably above NOTE_MAX characters of any script.
export const BODY_MAX = 256 * 1024;

export const TOO_LONG = 'That message is longer than this form can carry. Please email it instead, and nothing will be cut.';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Validate a parsed request body. Returns { sub } or { error, status }.
export function readSubmission(body, sites) {
  if (typeof body.site !== 'string' || typeof body.email !== 'string' || (body.note != null && typeof body.note !== 'string')) {
    return { error: 'site and email must be strings, and note must be text', status: 400 };
  }
  const site = String(body.site || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const note = String(body.note ?? '');
  if (!Object.hasOwn(sites, site)) return { error: 'unknown site', status: 400 };
  if (!EMAIL_RE.test(email) || email.length > 254) return { error: 'that does not look like an email address', status: 400 };
  if ([...note].length > NOTE_MAX) return { error: TOO_LONG, status: 413 };
  return { sub: { site, email, note: note.trim() ? note : null, created_at: new Date().toISOString() } };
}

const errText = (e) => String((e && e.message) || e || 'unknown error').slice(0, 500);

// Put one submission in both places. `places`:
//   saveToDb(sub)              → resolves { fresh } or throws
//   relay(sub, db) | undefined → resolves or throws; db = this call's D1 outcome
//   recordGap(sub, missing, reasons) | undefined → resolves journal key or throws
//   clearGap(key) | undefined   → deletes a fully delivered journal
//   waitUntil(promise) | undefined → keeps bounded-out attempts alive briefly
// Returns { ok, db, relay, missing, gap } where ok is the answer for the visitor.
export async function capture(sub, places) {
  const bounded = async (name, fn) => {
    const work = Promise.resolve().then(fn);
    places.waitUntil?.(work.catch(() => {}));
    let timer;
    try {
      return await Promise.race([work, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} timed out`)), places.timeoutMs ?? 5000);
      })]);
    } finally { clearTimeout(timer); }
  };

  // Immutable until repair, avoiding KV's one-write-per-key-per-second limit.
  // If the process dies, every planned place remains in this journal. Replays
  // are idempotent in D1; mail can be duplicated, but the message is kept.
  let gap = 'none', gapKey, gapError;
  if (places.recordGap) {
    try {
      gapKey = await bounded('journal', () => places.recordGap(sub, ['db', ...(places.relay ? ['relay'] : [])], {}));
      gap = 'recorded';
    } catch (e) { gap = 'unrecorded'; gapError = errText(e); }
  }

  let db;
  try { db = { ok: true, ...(await bounded('database', () => places.saveToDb(sub))) }; }
  catch (e) { db = { ok: false, error: errText(e) }; }
  db.journaled = gap === 'recorded';

  let relay;
  if (!places.relay) relay = { ok: false, configured: false };
  else {
    try { await bounded('mail', () => places.relay(sub, db)); relay = { ok: true, configured: true }; }
    catch (e) { relay = { ok: false, configured: true, error: errText(e) }; }
  }

  const missing = [];
  if (!db.ok) missing.push('db');
  if (relay.configured && !relay.ok) missing.push('relay');

  if (!missing.length && gap === 'recorded' && places.clearGap) {
    try { await bounded('journal cleanup', () => places.clearGap(gapKey)); gap = 'none'; }
    catch (e) { gapError = errText(e); } // safe to replay if cleanup refused
  } else if (missing.length && gap !== 'recorded') {
    gap = 'unrecorded';
  }
  const repairable = !missing.length || gap === 'recorded';
  return { ok: (db.ok || relay.ok) && repairable, db, relay, missing, gap, gapError };
}

// ---- the email that is the second place --------------------------------------

// What the owner reads. Plain words; the visitor's address is the Reply-To so
// answering the email answers them.
export function relayText(sub, db, { delayed = false } = {}) {
  const kind = sub.note ? 'inquiry' : 'sign-up';
  const subject = `${delayed ? '(delayed) ' : ''}New ${kind} on ${sub.site}: ${sub.email}`;
  const saved = db.ok
    ? (db.fresh === false ? 'Yes. This address was already on the list; any new message was added to its note.' : 'Yes.')
    : `No. The list database refused it (${db.error || 'no reason given'}). ${db.journaled === false ? 'Automatic repair could not be recorded. Keep this email as the full copy.' : 'It is held and will be added to the list when the database answers again. This email is the copy you have now.'}`;
  const lines = [
    `Someone sent ${sub.note ? 'an inquiry' : 'a sign-up'} on ${sub.site}.`,
    '',
    `Email: ${sub.email}`,
    `Sent: ${sub.created_at} (UTC)`,
    '',
  ];
  if (sub.note) lines.push('Their message, in full:', '', sub.note, '');
  lines.push(`Saved in the list database: ${saved}`, '', 'Reply to this email to write back to them.');
  return { subject, text: lines.join('\n') };
}

// RFC 5322 message for send_email's EmailMessage. Base64 body and an encoded
// subject so any language and any length survive. Header values come only from
// the site allowlist, the validated address (no whitespace possible) and
// configuration, so nothing a visitor types can add a header.
export function relayMime({ from, to, sub, db, delayed = false, now = new Date(), id = crypto.randomUUID() }) {
  const { subject, text } = relayText(sub, db, { delayed });
  const b64 = (s) => {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  const domain = String(from).split('@')[1] || 'localhost';
  const headers = [
    `From: Sign-up list <${from}>`,
    `To: <${to}>`,
    `Reply-To: <${sub.email}>`,
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${id}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ];
  const body = b64(text).replace(/.{1,76}/g, '$&\r\n');
  return { subject, raw: headers.join('\r\n') + '\r\n\r\n' + body };
}
