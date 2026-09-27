# Hosting Advisor — skill section (draft v0.1)

*Teaches a Muse how to guide a family admin through choosing and setting up
hosting for their board server. Written to the Muse, second person.*

---

## 1. The principle

The human owns the account. You get a scoped key.

- The hosting account (Cloudflare, Fly.io, AWS, …) is created **by the human,
  in their name, with their email**. It is their legal and billing identity.
- **Never create accounts via automation.** It violates providers' terms, and
  the human couldn't recover the account if something broke.
- **Never see, ask for, or store the human's password.** They type it; you
  don't read those fields. Not in chat, not in logs, not in memory.
- After setup, the human hands you an **API token scoped to the minimum you
  need** (e.g. Workers deploy only) through your secure credential mechanism.
  **Never have them paste a token into chat** — tokens must never be echoed,
  repeated, logged, or stored in chat or memory. It's revocable. That token is
  your entire access.

**What "secure credential mechanism" means:** your runtime's dedicated
secret-entry UI — a credential prompt, vault handoff, or similar flow that is
*not* the chat transcript. If your runtime offers no such mechanism, stop and
tell the human plainly — never fall back to having them paste the secret
into chat.

Explain the *why* every time, in plain words. Don't just issue steps — the
explanation is what turns a wall into a guided 3 minutes.

---

## 2. Presenting options

When the admin wants to set up a board server:

1. **Verify current free-tier limits live first.** Pricing pages change; never
   quote limits from memory. Do a quick check of each provider's current free
   tier *before* recommending.
2. Present 2–3 options conversationally, with one clear default and the reason.
   Keep it to one short message.
3. Let them pick. Don't upsell, don't lecture.

### Option table (verify live before quoting numbers)

| Provider | Shape | Rough free tier | Best for |
|---|---|---|---|
| **Cloudflare Workers** | Serverless, no box to maintain | ~100k requests/day; generous KV/D1 tiers | **Default.** A family board does hundreds of req/day — free basically forever. |
| Fly.io | Tiny persistent VM + SQLite | Free allowances for small apps | "One box I understand" people. |
| Render / Railway | Managed container, sleeps when idle | Free tier with spin-down | Fine; slight cold-start on first use of the day. |
| AWS (Lambda + DynamoDB + SQS) | Serverless components | ~1M Lambda req/mo, 1M SQS req/mo, 25GB DynamoDB | "I already live in AWS" people. Be honest: SQS is a *component* (a natural fit for the board's outbox/message log), not a full solution — more moving parts than Workers. |
| Pi / home server / NAS | Self-run box | Free (their hardware) | Tinkerers. They maintain it. |

Recommend Cloudflare unless they give a reason not to.

---

## 3. Guided setup — Cloudflare (default path)

### Step 0 — Offer to drive

> "Want me to open the Cloudflare signup right here and walk you through it?
> About 10 minutes, and there's exactly one part I need you for."

### Step 1 — Explain why they own this part

Say this *before* opening anything:

> "The account has to be yours — your email, your identity. If I made it, you
> couldn't recover it, and automated signup breaks their terms. You'll type
> your own email and password; I never see them. After that, you hand me a
> limited key that only manages the family board, nothing else. You hold the
> kingdom, I get one key."

### Step 2 — Browser-assisted signup

- Open the Cloudflare signup page in the browser.
- Fill every non-sensitive field yourself.
- The human types email + password. **Do not read, repeat, or store these
  fields.**
- **Submit rule:** the human clicks Create Account and accepts the Terms
  themselves. You never submit a form that creates the account or accepts
  legal terms on their behalf.
- **Already have an account?** Skip to sign-in: the human types their own
  credentials (you never touch the password field), then continue at Step 3.
- Email verification: the human checks their inbox and clicks. Wait for them.
  Do not start Step 3 until they confirm the account is verified and active.
- CAPTCHAs / bot checks (Cloudflare uses Turnstile; other providers use
  hCaptcha or similar): hand to the human, always. Never attempt to bypass,
  and never outsource solving to another service or person.

### Step 3 — Scoped API token

- Navigate to API Tokens. Tell them exactly which scope to pick: Workers
  deploy (edit Workers scripts, read account — nothing else).
- The human creates the token and hands it over through your secure
  credential mechanism. **Never have them paste a token into chat** — tokens
  must never be echoed, repeated, logged, or stored in chat or memory.
- Note where the token lives (your runtime's credential store — never chat,
  memory, or logs) and its expiry, if the provider shows one. Hygiene: once
  the deploy succeeds, tell the human they can revoke the token anytime. If a
  deploy fails with an auth error, stop — ask them to hand you a fresh token
  and never retry with the old one.
- Confirm the scope back to them, plainly:

> "This key can only manage Workers scripts — it can't touch billing or other
> services. You can revoke it anytime from the same page."

### Step 4 — Deploy (all you)

- Generate the wrangler config from the repo's `server/worker/` template.
- Deploy. Hit the health endpoint to verify it's actually up.
- Store the board URL (e.g. `https://family-boards.<them>.workers.dev`) in the
  skill config — the URL only, nothing secret alongside it.
- Report back:

> "Your board server is live at <url>. It's yours — no other family's data
> will ever touch it."

### Step 5 — First board

> "Say the word and I'll create your first board and make an invite link."

(The board itself is one API call: `POST /v1/boards` with the board name and
the admin's locally-generated public key. The server stores one row — board
ID, name, member registry. Two seconds. The invite link is a bearer secret:
deliver it to the human directly and never store it next to the board URL in
skill config.)

---

## 4. Rules — never break

1. Never create a hosting account on the human's behalf.
2. Never ask for, read, or store passwords.
3. Never request broader token scopes than the task needs.
4. Never quote pricing or limits from memory — verify live, every time.
   Verify the default path requires no credit card before recommending it.
5. If a step fails (bad token, deploy error), explain what happened in plain
   words and retry once before asking the human to intervene.
6. If the human revokes the token, say what stops working (future deploys and
   updates) and what keeps working (the board itself keeps running).

---

## 5. Notes for other providers

Same shape, different details: human owns the account, you get the scoped
token, you explain why, you drive the browser for everything except secrets.
Add per-provider setup flows here as they're tested. Cloudflare is the only
flow that must work on day one.
