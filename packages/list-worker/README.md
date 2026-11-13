# List capture Worker

`POST /subscribe` accepts JSON `{ site, email, note? }`. `site` must be a
configured key, `email` a valid address, and `note` plain text. A note can have
up to 50,000 Unicode code points. The request body has a separate 256 KiB byte
limit, enforced while reading even without Content-Length. Nothing is cut:
oversize requests receive `413 { error }`. Invalid fields receive `400`.
Errors include CORS headers for the configured origins, so a form can read the
error and offer its own email fallback. The Kitchen form in
[thekitchen.co#28](https://github.com/zachphillips/thekitchen.co/pull/28) uses
these same fields and checks `out.error`.

Both write endpoints require `Content-Type: application/json` (`415` otherwise).
If a browser supplies an Origin, it must belong to the submitted site (`403`
otherwise); being an allowed origin for a different site is insufficient.
No-Origin JSON integrations remain supported. CORS alone cannot prevent writes.
`POST /unsubscribe` accepts `{ site, email }` with a separate 4 KiB body limit.
Malformed UTF-8/Unicode and unsafe email header characters receive `400`, so
storage and mail cannot silently change the supplied text. Whitespace in notes
is preserved. Every JSON response, including private exports, is `no-store`.

These checks do not authenticate public submissions or prevent scripted spam:
the honeypot remains the only spam filter, and no rate limiter is configured.
A no-Origin client knowing an address can still unsubscribe it. Signed
unsubscribe links and deployment-level rate limits require a separate decision.

## Where a submission goes

With the bindings in `wrangler.example.jsonc`, the Worker first writes the
whole submission to an independent KV journal. It then attempts D1 and the
owner's email, allowing five seconds for each attempt. `200 { ok: true }`
means at least one delivery finished and any unfinished delivery has a durable
repair journal. If both deliveries fail, or a lone copy cannot be backed by a
journal, the visitor receives readable `503 { error }`. They should use the
form's email fallback or retry. The Worker never claims an unconfirmed
submission was received.

The hourly scheduled handler replays outstanding journal entries. A restart
before D1, between D1 and email, or before the response leaves that journal
available. Only a completely delivered entry is deleted. The journal initially
lists every planned destination, since a process interruption leaves delivery
outcomes uncertain. It is immutable during the request to avoid KV's
one-write-per-key-per-second limit. Consequently email is **at least once**:
after an interrupted request, failed cleanup, or timeout, the owner can receive
a duplicate. D1 updates are atomic and deduplicate whole submitted messages by
hash, so replay cannot append the same note again. A distinct shorter note is
kept even when it occurs inside an earlier message. Older accumulated notes
have no historical hashes; a repeated fragment from before this upgrade can be
appended once during migration rather than risk discarding a new inquiry.

The `submission_notes` table is created automatically alongside `subscribers`
when a write first finds either table missing. Existing subscriber rows and
their original dates are retained. No remote migration command is needed.

Binding outages and exhausted free-plan allowances can affect KV as well as
D1 and email. If all storage is unavailable, no Worker can preserve the input;
the visitor receives 503 and must retain it for retry or email. No journal has
an expiry. `GET /gaps`, `/list`, and `/export` require `LIST_ADMIN_TOKEN`.

For a deliberate database-only installation, omit the email configuration.
Without email configured, a successful D1 write still accepts a sign-up. The
two-copy promise requires both email and the KV journal to be configured.

Per-site `SINKS` are optional extra forwarding after capture. They are not one
of the two primary copies or the journal, and failures do not change the
capture response.

## Local proof

The verification adapter imports the production Worker and wraps only the
local D1, KV and simulated `send_email` bindings. It can refuse or delay them,
and kills and restarts its own Wrangler process while a request is active.
It never sends real email or uses a remote database.

```sh
WRANGLER_BIN=/path/to/wrangler/bin/wrangler.js \
LIST_PROOF_DIR=/path/to/empty/scratch \
  node verify/list-worker.mjs
```

The scratch directory holds the explicit local Wrangler config, persisted
local databases, Worker logs, and `results.json` containing HTTP responses and
D1/KV/mail read-backs. Use a new empty directory for each run. The runner stops
all processes it starts. `verify/list-proof.mjs` is the accompanying `evidence`
journey; it records those service outcomes in the evidence manifest.

No Wrangler configuration, fault adapter, or synthetic credentials from this
bench belong in a real deployment.
