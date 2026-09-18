# Host a Linger server

This is for the person running the server. Joining somebody else's server?
Use the [user guide](user-guide.md).

The server runs without a desktop. You control it through a terminal, usually
over SSH. You will install the desktop app on **your own computer** to make your
host account. Nothing on the [Releases page](https://github.com/itsMattGuenther/Linger/releases)
is a server installer.

## Before you start

- **A Linux computer reachable from the internet.** For a first try, follow
  [Create an Ubuntu VPS](vps-setup.md): choosing a server, SSH keys, connecting,
  and firewall rules. Already have a server? Start at step 1 below. At home,
  you must also [set up your router](#hosting-at-home).
- **A domain name** you control, or [two free dynamic-DNS names](#using-free-names).
  You need two names because uploaded files must use a different address from
  the app. A bare IP address will not work in the installed app.

## 1. Install Docker on the server

Connect from **your own computer** with `ssh root@YOUR_VPS_IP`, replacing
`YOUR_VPS_IP` with the VPS's public IP. Use your provider's username if it is
not `root`. Commands below run **in that SSH terminal, on the server**, not on
your own computer.

For a **fresh Ubuntu 24.04 VPS**, install Ubuntu's Docker and Compose packages:

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-v2 curl nano
sudo systemctl enable --now docker
sudo docker compose version
sudo docker info
```

**Continue only when both checks work:** Compose prints a version and
`docker info` includes a **Server** section without a connection error.
Use `docker.io` and `docker-compose-v2`, not `podman-docker` or the older
`docker-compose` command. [Ubuntu packages Compose v2 with Docker](https://packages.ubuntu.com/noble/docker-compose-v2).

Already have working Docker? Skip the install commands and run the two checks.
Do not mix these packages with an existing Docker CE installation. For other
Linux distributions, use [Docker's installation guide](https://docs.docker.com/engine/install/).
The remaining examples assume a root SSH session. If you use another account,
put `sudo` before each `docker` command.

Before continuing, apply the [firewall rules](vps-setup.md#4-set-the-cloud-firewall):
TCP **22** for SSH and **80/443** for the app, plus the voice ports if you want
voice. DNS alone does not open these ports.

## 2. Point two names at the server

Find your VPS's **public IPv4 address** in its control panel. At your domain
registrar, add two A records. For `example.com`, Namecheap's **Advanced DNS →
Host Records** screen would look like this:

| Type | Host | Value | TTL |
|---|---|---|---|
| A Record | `linger` | your server's public IPv4 | Automatic |
| A Record | `cdn.linger` | the same public IPv4 | Automatic |

Those become `linger.example.com` and `cdn.linger.example.com`. Do not replace
your existing `@` or `www` records. Give DNS a few minutes to catch up. If
you're hosting at home, use your [home connection's public IPv4](#hosting-at-home)
instead.

## 3. Get the server files

Run these commands **on the server**, in a terminal. They make a `linger`
folder in your current directory and put two setup files inside it:

```bash
mkdir linger
cd linger
curl -fLO https://raw.githubusercontent.com/itsMattGuenther/Linger/main/deploy/compose.yaml
curl -fLO https://raw.githubusercontent.com/itsMattGuenther/Linger/main/deploy/Caddyfile
```

The Docker images download automatically later. The app on the Releases page
is only for people's computers.

## 4. Edit each file once

Open `nano compose.yaml` and make these changes together:

- Set `LINGER_DOMAIN` to your main name, such as `linger.example.com`, without
  `https://`.
- **On a 50 GiB disk**, remove the `#` before `LINGER_POOL_BYTES` and change
  its value to `10GB`. Keep it aligned with the other environment settings.
  The default 50 GB file pool leaves too little room for Ubuntu and Docker.
- **If you want voice**, also change `--realm=linger.example.com` to that
  same main name. The remaining [voice steps](#voice-between-different-networks)
  add a secret and start the relay.

Save with **Ctrl+O**, Enter, then **Ctrl+X**.

Next, open `nano Caddyfile`. Replace both example names: the first block uses
your main name, and the `cdn.` block uses your file name, such as
`cdn.linger.example.com`. Keep them as **different names**. Save and exit.

## 5. Start the server

Still inside the `linger` folder, run:

```bash
docker compose run --rm --user root --entrypoint chown linger linger:linger /data
docker compose up -d
docker compose logs --tail=60 linger
```

The first command gives Linger permission to write its database in the `data`
folder. It also prevents the `unable to open database file` error seen on some
hosts. In the log, look for a **one-time setup link** like:

```text
https://linger.example.com/setup?token=…
```

Keep the entire link, including `?token=…`, private. Paste it into the Linger
desktop app in step 6, **not a browser**. Restarting Linger before you use the
link creates a new one and invalidates the old one. If you accidentally share
the link, restart Linger to replace it.

You may also see a warning that `LINGER_TURN_SECRET` is not set. That is about
the optional voice relay; it does not stop the server or text chat.

From **your own computer**, check the address before opening the app:
`curl -f https://linger.example.com/health` (replace the example name with
yours). If it does not return a short JSON response, use
[the connection checklist](#the-app-cannot-reach-the-server) first.

## 6. Make your host account

[Install and open the app](user-guide.md#installing-linger) on your own computer.
Paste the **whole setup link** into the *server or link* box and press
**continue**. Choose a server name, username, display name and password (at
least eight characters). The new account is the host account.

If the app says it cannot reach the server, check
[the connection steps below](#the-app-cannot-reach-the-server) before asking
for a new token. The desktop app does not start when you run Docker commands;
open it again the same way you installed it.

## 7. Invite people

In the left panel, press **⋯** beside the selected server, then **Invite people →
make a link**. Only the host sees this server menu. You choose how many people the invite
is good for and when it expires; the link
is copied for you the moment it is made. Send it however you normally talk to
your friends.

Before that, make a room: use **make the first room** on the empty screen, or
the **+** beside *Rooms* in the left rail. A room needs a short name for after the `#` and, if you
like, a topic.

An invite link is the only way to get an account. There is no public sign-up.
Text chat is ready. For voice with friends on other networks, also complete
[the voice setup](#voice-between-different-networks) below.

---

## Hosting at home

You can use a home computer instead of a VPS. It needs to stay on. From that
computer, `curl -4 https://api.ipify.org` shows the **public IPv4 address** for
your DNS records. Check that your router's WAN address matches it. If it does
not, you may be behind another router or carrier-grade NAT, and ordinary port
forwarding may not work.

In the router, reserve a **local IP address** for the computer and forward
**TCP 80 and 443** to that address. Allow those ports in the computer's firewall
too. This is the extra step a VPS avoids. DNS alone does not make a home server
reachable.

Anyone on the internet can then reach Linger through those ports. That does
not mean your computer will be instantly compromised, but keep the operating
system and Docker updated, and do not forward Docker's control port or Linger's
internal port 8420. After a short test, remove the router forwards and stop the
containers with `docker compose down`. Change or remove the two DNS records so
they no longer point to your home connection.

## Using free names

You do not have to buy a domain, but you still need **two names**. A free
dynamic-DNS provider such as DuckDNS can give you two, for example
`yourgroup.duckdns.org` and `yourgroupfiles.duckdns.org`. Set both to your
server's public IP on the provider's site (or use its IP updater).

In `compose.yaml`, set `LINGER_DOMAIN` to the first name and uncomment
`LINGER_MEDIA_DOMAIN` for the second. Put the same names in the two Caddyfile
blocks. Do not assume the provider lets you add `cdn.` in front of a free name.

---

## Running it day to day

Almost everything is done inside the app, not in a config file. The host
controls are in the **⋯** menu beside the selected server in the left panel.

- **Rooms** — **⋯ → Manage rooms**. Create, rename, set a topic, reorder,
  archive.
- **The server's name and accent color** — **⋯ → Server settings**. The name is
  what the rail shows and what an invite link tells a stranger.
- **Removing someone** — **⋯ → Manage members**. Choose the member, then
  confirm removal. They disappear from the roster and lose access; messages stay.
- **Letting them back in** — **⋯ → Manage members**. Removals are reversible;
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
| `LINGER_TURN_SECRET` | Shared key for Linger and the relay. Goes in `.env`, not here; you must also start the relay below. | unset — no relay |
| `LINGER_TURN_URLS` | Where the relay is, if not `turn:<your address>:3478`. Comma-separated `turn:`/`stun:` addresses. | derived from your address |

One file can be up to 500 MB.

**Using a cloud bucket instead of the machine's disk.** Set `LINGER_STORAGE: s3`
and fill in the five `LINGER_S3_*` lines already written in `compose.yaml` as
comments. Cloudflare R2 is the one to pick, because it does not charge for data
going out. The server refuses to start if any of them are missing, so you will
know straight away.

## Voice between different networks

Two people on the same wifi can talk without any of this. Two people in two
houses usually cannot: home routers
hide the computers behind them, and somebody has to introduce the two — that is
a *relay*, and it is the third container in `compose.yaml`. It is yours, on your
machine; what passes through it is scrambled sound it cannot listen to.

Run these steps **on the server**, inside the `linger` folder containing
`compose.yaml`.

1. Download the secret template and make your `.env` file. If you already have
   a `.env`, keep it; do not run the copy command again.

   ```bash
   curl -fLO https://raw.githubusercontent.com/itsMattGuenther/Linger/main/deploy/.env.example
   cp .env.example .env
   ```
2. Run `openssl rand -hex 32`, then open `nano .env`. Paste the generated value
   after `LINGER_TURN_SECRET=`. Save with **Ctrl+O**, Enter, then **Ctrl+X**.
   Keep it private. Compose gives the same secret to Linger and coturn.
3. If you did not already set the realm in step 4 of the host setup, change
   `--realm=linger.example.com` in `compose.yaml` to your server's name,
   without `https://` (for example, `--realm=linger.example.org`).
4. Allow inbound port **3478**, both TCP and UDP, and UDP ports **49160 to
   49200** in the provider's firewall and any firewall on the server. Keep
   TCP **80 and 443** open too. (If the machine is behind a home
   router rather than on a public address, also uncomment `--external-ip` and
   put your public IP there.)
5. Start Linger and the relay together so both read the secret:
   ```bash
   docker compose --profile voice up -d
   ```
   Without `--profile voice` the relay does not start, which is fine for a
   server that does not want one.
6. Check that it **stays running**, not just that Docker printed `Started`:

   ```bash
   docker compose --profile voice ps -a
   ```

   The `coturn` row should say **Up**, not `Restarting` or `Exited`. Wait
   about 30 seconds and run the command again. An empty `PORTS` column for
   coturn is normal: it uses the server's network directly.

   If coturn is missing or not staying Up, use [the relay checks below](#voice-cannot-connect).
   Then check `docker compose logs --tail=30 linger`: the latest startup
   should no longer warn that `LINGER_TURN_SECRET` is missing.

Finally, have two people on different networks leave and rejoin voice and
check that each can hear the other. **Up only proves the relay process is
running**; it does not prove that the firewall or voice connection works.

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

If you use voice, include the profile in both commands so the relay updates too:

```bash
docker compose --profile voice pull
docker compose --profile voice up -d
```

Repeat the [relay check](#voice-between-different-networks) after updating.

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

### The app cannot reach the server

Check that both DNS records point to the server's *current* public IP, then
try `curl -f https://linger.example.com/health` with your own name substituted.
If that fails, check `docker compose ps` and `docker compose logs caddy`.
Caddy needs inbound access for its certificate checks, and the app needs HTTPS
on TCP 443. Allow TCP 80 and 443. On a VPS check the provider and machine
firewalls; at home check router forwarding too. A valid setup token cannot fix
a connection failure.

### Voice cannot connect

Run `docker compose --profile voice ps -a` and find `coturn`:

- **No coturn row:** finish [the voice setup](#voice-between-different-networks)
  and start with `docker compose --profile voice up -d`.
- **Restarting or Exited:** read the first error with
  `docker compose --profile voice logs coturn | head -n 35`. A missing-secret
  error means `.env` needs a value after `LINGER_TURN_SECRET=`. If an older
  `compose.yaml` produces `unrecognized option '--no-dtls'`, remove only the
  `--no-dtls` line from that file. Current coturn leaves DTLS listeners off
  by default. Run `docker compose --profile voice up -d` after either fix
  and check that coturn stays Up.
- **Stays Up, but voice says `can't reach`:** check inbound TCP/UDP 3478 and
  UDP 49160–49200 in both firewalls (and router forwarding at home). After
  changing `.env`, run `docker compose --profile voice up -d` to apply the
  same secret to both containers; restarting only coturn is not enough.

Do not share your `.env` or setup token when asking for help.

### Other problems

- **`unable to open database file` repeats in Linger's log.** The `data`
  folder is not writable by the container. Run the permission command in
  step 5, then `docker compose up -d` again. It does not delete the database.
- **Chat works but uploads fail.** The `cdn.` record is missing, or the second
  block of the Caddyfile still says `linger.example.com`.
- **`docker compose pull` says `unauthorized`.** The prebuilt image is not
  available to you. Clone the repository and build it yourself:
  `docker build -f deploy/Dockerfile -t ghcr.io/matthewguenther/linger:latest .`
- **The setup link does not work.** It works once. If you already made an
  account, it is gone for good — that is deliberate. If no account was made
  but the link was exposed or lost, `docker compose restart linger` prints a
  new one and invalidates the old one.
- **The startup log warns that `LINGER_DOMAIN` is not set.** Then your friends
  cannot connect, whatever else looks fine. The app only talks to `https`
  addresses. Go back to [Before you start](#before-you-start).

---

## What you are taking on

Say this out loud to the people you invite, because it is true:

> **Whoever runs the server can read everything on it.** Messages and files are
> encrypted while they travel and sit on an encrypted disk if you set one up,
> but there is no end-to-end encryption. Your friends are trusting you, not the
> software.

Linger has no telemetry, analytics, or crash reporting. Nobody is counting
your users.
