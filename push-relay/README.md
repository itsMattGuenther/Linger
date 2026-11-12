# Linger's push relay

The one place Linger's Apple and Google push keys live (#887, SPEC §4.15,
PROTOCOL §5 "Phone notifications"). A closed phone app can only be woken
through Apple's or Google's push service, with keys from Linger's own
accounts, which can't be handed to every host. So every Linger server sends
phone notifications through this, at `https://push.linger.im`, a Cloudflare
Worker.

It does two things, and keeps nothing between them:

- **`POST /seal`**: a phone hands over its push address from Apple or Google
  (`SealRequest`) and gets back a sealed token (`SealResponse`). Only this
  relay can open it; the phone gives its servers the token, never the
  address. Sealing the same address twice gives two different tokens.
- **`POST /send`**: a server hands over a sealed token and a notification it
  encrypted to that phone (`RelaySend`). The relay opens the token and passes
  the notification to Apple or Google as it came. It can't read it: only the
  phone has the key.

**Nothing is logged or stored** (hard rule 4). There's no `console` call in
`src/`, no storage binding, and `wrangler.jsonc` turns off Workers Logs,
traces, Logpush and wrangler's own usage metrics; `test/quiet.test.ts` fails
if any of that changes. The rate limits (60 sends a minute per phone, 30
seals a minute per network address) count hashes, in Cloudflare's memory,
per location. Apple's and Google's short-lived credentials are kept in the
Worker's memory until they're due to be made again.

## Checks

```bash
cd push-relay
pnpm install
pnpm check    # makes the Workers runtime's types, then typechecks
pnpm test     # seal and send against stand-ins for Apple and Google
```

`scripts/check.sh` runs both when the branch changes `push-relay/` or the wire
types; CI's `push relay` job does the same. The tests make fresh keys each run,
so no real key is in the repository.

**Can a Worker reach Apple at all?** Apple's push service takes HTTP/2 only.
Checked on 2026-11-12 (#887), from a Worker on Cloudflare's network
(`wrangler dev --remote`), with Linger's real keys and a made-up phone address:
Apple answered `400 BadDeviceToken`, so the connection, the key, its Key ID and
the Team ID all work, and Google answered `INVALID_ARGUMENT` for the address
after signing in with the service account. A bad key would have been `403
InvalidProviderToken`.

## Deploying

By hand, from Matt's machine, never from CI. Nothing a pull request builds
reaches it until somebody deploys.

```bash
cd push-relay
pnpm exec wrangler login        # once; the Cloudflare account linger.im is on
pnpm exec wrangler deploy       # the Worker, at push.linger.im
```

The first deploy also needs its three secrets, which `wrangler.jsonc` lists
under `secrets.required` and which never go in the repository or GitHub:

```bash
pnpm exec wrangler secret put APNS_KEY < ~/.config/linger-push/AuthKey_FGGDB7SBQQ.p8
pnpm exec wrangler secret put FCM_SERVICE_ACCOUNT < ~/.config/linger-push/linger-4701a-firebase-adminsdk-fbsvc-cd3c06820a.json
openssl rand -base64 32 > ~/.config/linger-push/seal-key && chmod 600 ~/.config/linger-push/seal-key
pnpm exec wrangler secret put SEAL_KEY < ~/.config/linger-push/seal-key
```

Back all three up with the other signing keys. `SEAL_KEY` is the one that's
new here: every sealed address was sealed with it. Lost, the relay can't open
any of them, answers each send "gone", and every phone has to register again
the next time it's opened. Nothing is lost for good, but nobody's phone buzzes
until then.

The APNs key's id, the team and the app's bundle id aren't secret, and are in
`wrangler.jsonc`'s `vars`. A new APNs key means a new `APNS_KEY` and
`APNS_KEY_ID` together.

`compatibility_date` is the newest the pinned wrangler's own runtime knows, so
`wrangler dev` runs what Cloudflare runs; move it when wrangler moves.
