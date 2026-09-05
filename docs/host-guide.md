# Running a Linger server

This is for the one person in a group who runs the server. You do not need to be
a developer. You need a computer that stays on, a domain name, and about half an
hour.

If you are here to *use* Linger, you want the [user guide](user-guide.md)
instead.

---

## What you are actually running

Two small programs in containers: Linger itself, and Caddy, which handles the
web address and the security certificate for you.

Everything the server owns lives in one folder: a database file with all the
messages, and a folder of uploaded files next to it. Copy that folder and you
have copied the whole server.

**You do not download the server.** There is nothing on the Releases page for
you — everything there is the app people install on their own computers. The
server arrives on its own when you run `docker compose up` in step 4, and
updates the same way. The only file you fetch by hand is the setup file in
step 2.

## What you need first

- **A computer that stays on and is reachable from the internet.** A cheap
  virtual server (about $5–10 a month) is the usual answer. An old machine at
  home works if you can forward ports 80 and 443 to it.
- **A web address.** Either a domain you buy (around $12 a year) or a free one
  from a dynamic-DNS service. See *Do I have to buy a domain?* below.
- **Docker.** Install it from [docker.com](https://docs.docker.com/engine/install/).

## Do I have to buy a domain?

**No — but you do need a *name*, and a plain IP address will not work.** Here is
why, in one line each:

- The app only talks to servers over an encrypted connection, and encryption
  needs a name to put on the certificate. An IP address cannot have one.
- Uploaded files are served from a *second* name. That is what stops a file
  somebody uploads from pretending to be the app itself.
- Home internet connections get a new IP address every few weeks. With a name,
  the server can move and nobody has to be told anything.

**The free way.** Dynamic-DNS services — DuckDNS is the usual one — hand out
names for nothing. Register **two** of them, one for the app and one for files:

```yaml
LINGER_DOMAIN: yourgroup.duckdns.org
LINGER_MEDIA_DOMAIN: yourgroupfiles.duckdns.org
```

Put those same two names in the Caddyfile, one per block. Everything else in
this guide works the same, and Caddy still gets a real certificate.

Two separate names, rather than one name with `cdn.` in front of it, because
free providers differ on whether you can put anything in front of your name.
Two names always works.

---

## 1. Point your address at the machine

**Using a free dynamic-DNS name?** You do not add records yourself — you set
your IP on the provider's website, or run their small updater so it keeps up
when your IP changes. Do that for both names and skip to step 2.

**Using a domain you bought?** Add **two** records at your registrar. Both point
at your server's IP address.

| Type | Name                     | Points to      |
|------|--------------------------|----------------|
| A    | `linger.example.com`     | your server IP |
| A    | `cdn.linger.example.com` | your server IP |

(Use `AAAA` instead of `A` if your server has an IPv6 address.)

**Why two.** Uploaded files are served from the `cdn.` name, never from the main
one. That way a file somebody uploads can never pretend to be the app itself. If
you skip the second record, chat works and file uploads break.

DNS changes can take a few minutes to spread. Get this done first and it will be
ready by the time you need it.

## 2. Get the two setup files

```bash
mkdir linger && cd linger
curl -O https://raw.githubusercontent.com/matthewguenther/Linger/main/deploy/compose.yaml
curl -O https://raw.githubusercontent.com/matthewguenther/Linger/main/deploy/Caddyfile
curl -O https://raw.githubusercontent.com/matthewguenther/Linger/main/deploy/.env.example
```

The third file is only needed if you turn on voice between different networks
later (see *Settings you might want to change*); it does nothing until then.

## 3. Put your address in both of them

- In **compose.yaml**, change `LINGER_DOMAIN` to your address. If you are using
  two free names, uncomment `LINGER_MEDIA_DOMAIN` and put the second one there.
- In **Caddyfile**, replace `linger.example.com` everywhere it appears. There
  are two blocks: the first is your main address, the second is the one files
  are served from.

Nothing else has to change to get started.

## 4. Start it

```bash
docker compose up -d
docker compose logs linger
```

In the log you will see a box like this:

```
  ┌─────────────────────────────────────────────────
  │  This server isn't set up yet.
  │  Open:  https://linger.example.com/setup?token=…
  │  (the link works once, then never again)
  └─────────────────────────────────────────────────
```

**Copy that whole link. It goes into the Linger app, not into a web browser** —
there is no website to visit, and a browser will just show an error. The server
says so in the box too.

If the box also says the address is `http` and an installed app cannot reach it,
that means `LINGER_DOMAIN` is not set. Fix that before going further.

## 5. Make your account

[Install the app](user-guide.md#installing-linger), open it, and paste the setup
link into the box that says *server or link*. The form that appears asks for
four things: a **name for the server** (what your friends will see it called),
your **username** (lowercase, cannot change later), your **display name**, and a
**password** (eight characters or more, no silly rules).

That account is the host. There is no separate admin login, and there are no
roles — you are a normal member who also has the host controls.

## 6. Invite people

In the left rail, next to the word *SERVER*, you have two small controls nobody
else sees: **manage** and **+ room**. Press **manage**, then **invites → make a
link**. You choose how many people it is good for and when it expires; the link
is copied for you the moment it is made. Send it however you normally talk to
your friends.

Before that, make a room: the empty screen offers **make the first room**, and
so does **+ room**. A room needs a short name for after the `#` and, if you
like, a topic.

An invite link is the only way to get an account. There is no public sign-up.

---

## Running it day to day

Almost everything is done inside the app, not in a config file. The host
controls are behind **manage**, next to *SERVER* in the left rail.

- **Rooms** — host controls → *rooms*. Create, rename, set a topic, reorder,
  archive.
- **The server's name and accent color** — host controls → *server*. The name is
  what the rail shows and what an invite link tells a stranger.
- **Removing someone** — open their card in the roster and remove them. They
  disappear from everywhere.
- **Letting them back in** — host controls → *people*. Removals are reversible;
  that is the point.

Two things worth knowing. There is **no way to hand the host role to somebody
else**, on purpose. And there are no permissions to configure — if a group needs
that, it has outgrown what this app is for.

---

## Settings you might want to change

These go in `compose.yaml`, under `environment:`. Most people never touch them.
After a change, run `docker compose up -d` again.

| Setting | What it does | Default |
|---|---|---|
| `LINGER_POOL_BYTES` | Total storage the server will use. Write `250GB`, `500MB`, or a plain number. | `50GB` |
| `LINGER_FILE_EXPIRY_DAYS` | How long a file stays before it is deleted. `off` keeps everything forever. Starred files never expire. | `365` |
| `LINGER_MEDIA_DOMAIN` | The name files are served from. Set it if you are using two free names, or want something other than `cdn.` + your domain. It must be different from the main one. | `cdn.<your address>` |
| `LINGER_STORAGE` | `local` keeps files on the machine. `s3` keeps them in a cloud bucket. | `local` |
| `LINGER_DATA_DIR` | Where the database and files live inside the container. | `/data` |
| `LINGER_TURN_SECRET` | Turns on the voice relay (see below). Goes in `.env`, not here. | unset — no relay |
| `LINGER_TURN_URLS` | Where the relay is, if not `turn:<your address>:3478`. Comma-separated `turn:`/`stun:` addresses. | derived from your address |

One file can be up to 500 MB.

**Using a cloud bucket instead of the machine's disk.** Set `LINGER_STORAGE: s3`
and fill in the five `LINGER_S3_*` lines already written in `compose.yaml` as
comments. Cloudflare R2 is the one to pick, because it does not charge for data
going out. The server refuses to start if any of them are missing, so you will
know straight away.

**Voice between different networks.** Two people on the same wifi can talk
without any of this. Two people in two houses usually cannot: home routers
hide the computers behind them, and somebody has to introduce the two — that is
a *relay*, and it is the third container in `compose.yaml`. It is yours, on your
machine; what passes through it is scrambled sound it cannot listen to.

1. Copy `.env.example` to `.env` next to `compose.yaml`.
2. Put a long random secret in it: `openssl rand -hex 32` prints one. This one
   value is shared between Linger and the relay and is the relay's only lock,
   so make it long and do not reuse it anywhere.
3. In `compose.yaml`, change `--realm=linger.example.com` to your address.
4. Open two more things on your router or firewall: port **3478**, both TCP and
   UDP, and UDP ports **49160 to 49200**. (If the machine is behind a home
   router rather than on a public address, also uncomment `--external-ip` and
   put your public IP there.)
5. Start with the relay switched on:
   ```bash
   docker compose --profile voice up -d
   ```
   Without `--profile voice` the relay does not start, which is fine for a
   server that does not want one.

The server tells you at startup if it has no relay. Voice still works then,
between machines on one network.

---

## Backups

The whole server is the `data` folder next to your `compose.yaml`. It holds
`linger.db` (every message) and `objects/` (every uploaded file).

Copy it while the server is stopped, so you never catch the database mid-write:

```bash
docker compose stop linger
tar czf linger-backup-$(date +%F).tar.gz data
docker compose start linger
```

That is a few seconds of downtime. Put it in a scheduled job and keep the copies
somewhere that is not this machine.

To restore: stop everything, put the `data` folder back, start again.

(If you moved files to a cloud bucket, `data/objects/` is empty and the bucket
is the other half of your backup.)

## Exports (and what they do to your disk)

Any member can ask the server for a zip of everything on it — every message and
every file. This is deliberate and you cannot turn it off: it is the promise
that nobody is locked in, including when the person locking them in would be
you.

Two things keep it from being a problem. A member can only ask **once an hour**,
and each member has **one** archive at a time — asking again deletes the
previous one. So the most it can cost you is one extra copy of your server per
member, and in practice far less.

Those archives live alongside your uploaded files and are not counted in the
storage figure members see. If disk space is tight, that is worth knowing.

**An export is not your backup.** It is a readable copy for a person. Your
backup is the `data` folder, above.

## Updating the server

```bash
docker compose pull
docker compose up -d
```

Nothing updates itself. You decide when.

## Somebody forgot their password

The server has one maintenance command. Stop it first — the database allows one
writer at a time.

```bash
docker compose stop linger
docker compose run --rm linger reset-password their-username
docker compose start linger
```

It prints a new password. Send it to them; they can change it in the app under
*settings → password*.

---

## When something is wrong

**Start here:** `docker compose logs linger` and `docker compose logs caddy`.

- **Voice connects on the same wifi but not between houses.** The relay is not
  running, or its ports are not open. `docker compose ps` should list `coturn`;
  if it does not, you started without `--profile voice`. If it is running,
  check port 3478 (TCP and UDP) and UDP 49160–49200 reach the machine, and that
  `.env` holds the same secret Linger was started with.
- **The address does not load at all.** Usually DNS has not caught up, or ports
  80 and 443 are not reaching the machine. Caddy's log will say if it could not
  get a certificate.
- **Chat works but uploads fail.** The `cdn.` record is missing, or the second
  block of the Caddyfile still says `linger.example.com`.
- **`docker compose pull` says `unauthorized`.** The prebuilt image is not
  available to you. Clone the repository and build it yourself:
  `docker build -f deploy/Dockerfile -t ghcr.io/matthewguenther/linger:latest .`
- **The setup link does not work.** It works once. If you already made an
  account, it is gone for good — that is deliberate.
- **The startup log warns that `LINGER_DOMAIN` is not set.** Then your friends
  cannot connect, whatever else looks fine. The app only talks to `https`
  addresses. Go back to *Do I have to buy a domain?*

---

## What you are taking on

Say this out loud to the people you invite, because it is true:

> **Whoever runs the server can read everything on it.** Messages and files are
> encrypted while they travel and sit on an encrypted disk if you set one up,
> but there is no end-to-end encryption. Your friends are trusting you, not the
> software.

What you are *not* taking on: there is no telemetry, no analytics, and no crash
reporting anywhere in Linger. Nothing on your machine phones home, to Matt or to
anyone else. Nobody is counting your users.
