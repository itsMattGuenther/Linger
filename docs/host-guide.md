# Host a Linger server

This is for the person running the server. Joining somebody else's server?
Use the [user guide](user-guide.md).

The server runs without a desktop. You control it through a terminal, usually
over SSH. You will install the desktop app on **your own computer** to make your
host account. Nothing on the [Releases page](https://github.com/itsMattGuenther/Linger/releases)
is a server installer.

## Before you start

- **A Linux computer reachable from the internet**, with an Intel or AMD
  processor (x86-64). The server isn't built for ARM, so a Raspberry Pi or an
  ARM cloud server won't run it. For a first try, follow
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
TCP **22** for SSH, **80/443** for the app and UDP **3479** for voice, plus the
relay's ports if you run it. DNS alone does not open these ports.

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

## 3. Run the setup script

Run these commands **on the server**. They make a `linger` folder, fetch the
setup script into it, and run it:

```bash
mkdir linger
cd linger
curl -fLO https://raw.githubusercontent.com/itsMattGuenther/Linger/main/deploy/setup.sh
bash setup.sh
```

It asks two things: your server's main name, such as `linger.example.com`,
and whether to run the [voice relay](#the-voice-relay) for people on networks
that block voice (yes is a good answer). Then it:

- downloads the server's files into the folder: `compose.yaml`, `Caddyfile`,
  `update.sh` and `.env.example`;
- checks that both names point at this machine, and stops if one doesn't yet,
  so you can fix it and run the script again;
- writes `.env`, the one file that holds your settings, with a new secret for
  the relay and a storage limit that fits your disk;
- opens the ports in the server's own firewall (`ufw`), and lists the ports to
  forward when a home router or your cloud's network sits in front of it;
- starts the server and prints a **one-time setup link** like:

```text
https://linger.example.com/setup?token=…
```

Keep the entire link, including `?token=…`, private. Paste it into the Linger
desktop app in step 4, **not a browser**. Restarting Linger before you use the
link creates a new one and invalidates the old one, and
`docker compose logs linger` prints the new one. If you accidentally share the
link, restart Linger to replace it.

The script can't change your provider's own firewall (DigitalOcean's Cloud
Firewalls, say): open the ports there yourself, as in step 1. It sends nothing
anywhere except GitHub for the files and
[api.ipify.org](https://api.ipify.org) to learn the server's public address.
Running it again is safe: it keeps an `.env` that's already there, and it
won't touch a folder that already runs a server.

From **your own computer**, check the address before opening the app:
`curl -f https://linger.example.com/api/v1/health` (replace the example name with
yours). If it does not return a short JSON response, use
[the connection checklist](#the-app-cannot-reach-the-server) first.

### By hand, instead of the script

The same steps, one at a time. Using [two free names](#using-free-names)
rather than `cdn.` in front of yours? This is your way, since the script
checks for `cdn.`.

```bash
mkdir linger
cd linger
for file in compose.yaml Caddyfile update.sh .env.example; do
  curl -fLO "https://raw.githubusercontent.com/itsMattGuenther/Linger/main/deploy/$file"
done
chmod +x update.sh
cp .env.example .env
nano .env
```

In `.env`, put your main name after `LINGER_DOMAIN=`, without `https://`. On a
50 GiB disk, also remove the `#` before `LINGER_POOL_BYTES=10GB`: the default
50 GB file pool leaves too little room for Ubuntu and Docker. For the relay,
follow [its steps](#the-voice-relay) now or later. Save with **Ctrl+O**,
Enter, then **Ctrl+X**. Every setting lives in `.env`: you never edit
`compose.yaml` or the `Caddyfile`.

```bash
docker compose up -d
docker compose logs --tail=60 linger
```

The log prints the setup link. You may also see a warning that
`LINGER_TURN_SECRET` is not set, which is about the optional voice relay. It
doesn't stop the server, text chat or voice.

A server image from before 0.4.9 needs two more things, once: run
`docker compose run --rm --user root --entrypoint chown linger linger:linger /data`
before `docker compose up -d`, so it can write its database, and put the
server's public IP (`curl -4 https://api.ipify.org`) after
`LINGER_VOICE_ADDRESS=` in `.env` for voice. The script does both by itself.

## 4. Make your host account

[Install and open the app](user-guide.md#installing-linger) on your own computer.
Paste the **whole setup link** into the **Server or link** box and press
**Continue**. Choose a server name, username, display name and password (at
least eight characters). The new account is the host account.

If the app says it cannot reach the server, check
[the connection steps below](#the-app-cannot-reach-the-server) before asking
for a new token. The desktop app does not start when you run Docker commands;
open it from your application menu, or the same way you installed it.

## 5. Invite people

Open Settings (the gear at the top of your list, or **Ctrl+,**). As the host
you have a **Hosting** group there that nobody else sees, unless you make them
a [co-host](#running-it-day-to-day).

First make a room: **Hosting → Rooms → New Room**. Give it a name, and a topic
if you like. The slug, the short form people type after the `#`, fills itself
in from the name (`Front Porch` becomes `front-porch`); type your own there to
change it.

Then **Hosting → Invites → New Invite**. You choose how many people the invite
is good for and when it expires; the link is copied for you the moment it is
made. Send it however you normally talk to your friends.

**Hosting → Server** shows which version your server runs, and says when a
newer one is out, with a link to [updating the server](#updating-the-server).
Only you see it.

An invite link is the only way to get an account. There is no public sign-up.
Text chat is ready, and so is voice once UDP 3479 is open ([Voice](#voice)). For
friends on networks that block voice (some offices, some public wifi), also set
up [the voice relay](#the-voice-relay) below.

---

## Hosting at home

You can use a home computer instead of a VPS. It needs to stay on. From that
computer, `curl -4 https://api.ipify.org` shows the **public IPv4 address** for
your DNS records. Check that your router's WAN address matches it. If it does
not, you may be behind another router or carrier-grade NAT, and ordinary port
forwarding may not work.

In the router, reserve a **local IP address** for the computer and forward
these ports to that address:

- **TCP 80 and 443**, for the app;
- **UDP 3479**, for voice. Without it text chat works and nobody hears anybody;
- if you run [the relay](#the-voice-relay), **TCP and UDP 3478** and **UDP
  49160 to 49200** too.

Allow the same ports in the computer's firewall (the setup script does this
when `ufw` is on, and lists them for you). This is the extra step a VPS avoids.
DNS alone does not make a home server reachable.

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

Set up [by hand](#by-hand-instead-of-the-script): in `.env`, set
`LINGER_DOMAIN` to the first name, and remove the `#` before
`LINGER_MEDIA_DOMAIN` and put the second name after it. In the `Caddyfile`,
replace `cdn.{$LINGER_DOMAIN}` with the second name. Do not assume the provider
lets you add `cdn.` in front of a free name.

---

## Running it day to day

Almost everything is done inside the app, not in a config file. The host
controls are in Settings, under **Hosting**:

- **Rooms**: create, rename, set a topic, reorder, archive.
- **Invites**: make a link, and see or **Revoke** the ones still open.
- **People**: remove someone (it asks first; they lose access, and their
  messages stay), and let them back in. Removals are reversible; that is the
  point.
- **Server**: its name and color. The name is what everybody's list shows and
  what an invite link tells a stranger; the color is the server's stripe in
  everybody's list.

Newcomers start on the name color the fewest people on the server wear, so a
big group isn't a list of gray names. Anyone can change theirs in **Settings →
Profile**.

**Going away? Make somebody a co-host.** Open their card (click their name),
then **···** and **Make Jules a co-host**. A co-host gets the same **Hosting**
sections and can do everything above, handle reports, and take somebody out
of voice. They can't make other co-hosts, and they can't act on you: remove
you, take you out of voice, delete your messages or revoke your invites. Their
card says "co-host". To stop it, choose **Jules stops being a co-host** on the
same menu. Only you see the server's version, since updating the server is
still yours to do.

Two things worth knowing. There is **no way to hand the host role itself to
somebody else**, on purpose. And there are no permissions to configure beyond
that one switch. If a group needs more, it has outgrown what this app is for.

---

## Your server's own emoji

Pictures everyone on your server can put in a message, like Discord's server
emoji. In the app: **Settings → Emoji**, under Hosting (you or a co-host).

- **Choose pictures**, or drop them on the box. Each becomes an emoji at once,
  named from its file: `party-parrot.gif` is `:party_parrot:`. Pick several at
  a time if you like.
- PNG, GIF, WebP or JPEG. A big picture is made emoji-sized for you; an
  animated GIF stays animated if it's under 256 KB. A server holds up to 200.
- **Rename** one in place. Names are 2 to 32 lowercase letters, digits or
  underscores.
- **Remove** asks first. Messages that used it show its `:name:` as words from
  then on.

They're in everyone's picker straight away, under your server's name. The
pictures are kept with your server's files and never expire; a backup of
`data` has them. An export doesn't include them.

A server from before 0.4.9 can't hold emoji of its own, and Settings → Emoji
says so: [update the server](#updating-the-server) first. Friends still on an
older app see a server emoji's `:name:` as words until they update.

---

## Settings you might want to change

These go in `.env`, each as `NAME=value` on a line of its own; most are there
already as comments, so remove the `#`. Most people never touch them. After a
change, run `docker compose up -d` again. (A server set up before 0.4.9 may
have them in `compose.yaml` under `environment:` instead, written `NAME: value`.
That keeps working, and [Updating](#updating-the-server) says how to move them.)

| Setting | What it does | Default |
|---|---|---|
| `LINGER_POOL_BYTES` | Total storage the server will use. Write `250GB`, `500MB`, or a plain number. | `50GB` |
| `LINGER_FILE_EXPIRY_DAYS` | How long a file stays before it is deleted. `off` keeps everything forever. Starred files never expire. | `365` |
| `LINGER_MEDIA_DOMAIN` | The name files are served from. Set it if you are using two free names, or want something other than `cdn.` + your domain. It must be different from the main one. | `cdn.<your address>` |
| `LINGER_STORAGE` | `local` keeps files on the machine. `s3` keeps them in a cloud bucket. | `local` |
| `LINGER_VOICE_ADDRESS` | Where voice goes: the server's public IP address, or `off` for no voice. See [Voice](#voice). | the address your name points at |
| `LINGER_TURN_SECRET` | Shared key for Linger and the relay; you must also start the relay below. | unset — no relay |
| `LINGER_TURN_URLS` | Where the relay is, if not `turn:<your address>:3478`. Comma-separated `turn:`/`stun:` addresses. | derived from your address |

One file can be up to 500 MB.

**Using a cloud bucket instead of the machine's disk.** Set `LINGER_STORAGE=s3`
and fill in the five `LINGER_S3_*` lines already written in `.env` as
comments. Cloudflare R2 is the one to pick, because it does not charge for data
going out. The server refuses to start if any of them are missing, so you will
know straight away.

Then give the bucket one cleanup rule. While a file is going up, its pieces sit
in the bucket under `uploads/`, and Linger deletes them once the file is done
or given up. A piece can still arrive after that, though, because the links
Linger hands out for sending pieces last a day, and nothing would ever remove
it. So add a lifecycle rule that deletes anything under the prefix `uploads/`
two days after it was written. On Cloudflare R2 that is the bucket's
**Settings**, then **Object lifecycle rules**. On AWS S3 it is the bucket's
**Management** tab, then **Lifecycle rules** (expire current versions after 2
days). Set the prefix to exactly `uploads/`: everything else in the bucket is
people's files.

## Voice

Voice goes through your server: everybody sends their voice to it once, and
it passes it on to everyone else in the room, up to 60 at a time. Apps send
voice only while somebody is talking, so a big room costs the server what its
talkers do: upload for each talker to each listener. A room of up to twenty
sounds its best, at about 150 kbit/s for each of those on the wire; from
twenty-one it steps down to about 120 kbit/s, so fifty people with three
talking take about 17 Mbps of upload. A room passes on at most six voices at
once, the loudest, so however many people shout at the same moment, fifty
people never take more than about 35 Mbps. A three-hour evening of fifty is
about 23 GB of data out, which matters if your provider counts it. It needs one open port, and
nothing else: the server sends voice through the address your name points at,
the one from [step 2](#2-point-two-names-at-the-server). Without a way to work
that out the server carries no voice at all, and the app tells people voice
isn't set up rather than offering a call nobody could hear. (Servers used to
fall back to an older way, voice straight between people's computers. That's
gone.)

1. Allow **UDP 3479** in the cloud firewall, and in the machine's own (the
   setup script does that one; by hand it's `sudo ufw allow 3479/udp`). At
   home, forward it in the router too.
2. `docker compose logs linger` says `voice goes to the address LINGER_DOMAIN
   points at` and `voice forwarding is on`.

**Sending voice somewhere else.** If your name doesn't point straight at the
server (behind Cloudflare's proxy, say, it points at Cloudflare, which can't
carry voice), set `LINGER_VOICE_ADDRESS` in `.env` to the server's public IP:
`curl -4 https://api.ipify.org` prints it. To run a server with no voice, set
it to `off`. A server from before 0.4.9 can't work the address out, and needs
it set either way.

A `compose.yaml` from before 0.4.1 has no voice port. Add it to the `linger`
service, then `docker compose up -d`:

```yaml
    ports:
      - "3479:3479/udp"
```

Your server passes voice along. It keeps none of it and plays none of it,
but it is on your machine, so you *could* listen, the same way you could read
messages. Anybody still on Linger 0.4.0 or older can't join voice until they
update.

## The voice relay

Voice goes straight to your server on UDP 3479, which works from behind almost
any home router. Some networks block it: some offices, some public wifi. The
*relay* lets people on those through, over the ports it uses. It is the third
container in `compose.yaml`. It is yours, on your machine; what passes through
it is scrambled sound it cannot listen to.

Said yes to the relay in the setup script? It's set up and running: skip to
step 4 to check it. Otherwise, run these steps **on the server**, inside the
`linger` folder containing `compose.yaml`.

1. Run `openssl rand -hex 32` to make a secret, then open `nano .env`. Paste
   the secret after `LINGER_TURN_SECRET=`, and remove the `#` before
   `COMPOSE_PROFILES=voice`, which tells Docker to start the relay with
   everything else. Save with **Ctrl+O**, Enter, then **Ctrl+X**. Keep the
   secret private. Compose gives it to Linger and coturn alike. (No `.env`
   yet, on a server set up before 0.4.9? Download `.env.example` from the
   [server files](#by-hand-instead-of-the-script), `cp .env.example .env`, and
   fill in just those two lines.)
2. Allow inbound port **3478**, both TCP and UDP, and UDP ports **49160 to
   49200** in the provider's firewall and any firewall on the server. Keep
   TCP **80 and 443** open too. If the machine is behind a home router rather
   than on a public address, forward them as well, and remove the `#` before
   `LINGER_RELAY_EXTERNAL_IP` in `.env` with your public IP after it, so the
   relay tells people where it really is.
3. Start Linger and the relay together so both read the secret:
   ```bash
   docker compose up -d
   ```
   A `.env` made before 0.4.5 doesn't have `COMPOSE_PROFILES=voice`: add it
   once with `echo COMPOSE_PROFILES=voice >> .env`, or type `--profile voice`
   after `docker compose` every time.
4. Check that it **stays running**, not just that Docker printed `Started`:

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
`linger.db` (every message) and `objects/` (every uploaded file). Keep a copy
of `.env` somewhere safe too: it holds your settings and the relay's secret.

Copy it while the server is stopped, so you never catch the database mid-write:

```bash
docker compose stop linger
tar czf linger-backup-$(date +%F).tar.gz data
docker compose start linger
```

That is a few seconds of downtime. Put it in a scheduled job and keep the copies
somewhere that is not this machine.

`update.sh` also saves the database into `backups/` whenever it updates the
server. That copy is for going back after an update: it has the messages but
not the uploaded files, and it's on the same machine. It doesn't replace this.

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
member, and in practice far less. And only **one archive is built at a time**
across the whole server. If several people ask at once, the others wait their
turn, so building never needs room for more than one archive at once.

Those archives live alongside your uploaded files and are not counted in the
storage figure members see. If disk space is tight, that is worth knowing.

Where the space goes depends on your storage backend:

- **`local` (the default):** an archive is built in `data/staging` and then
  moved in with your uploads. While it builds, it needs about the size of the
  finished zip in free space.
- **`s3`:** the finished archive goes to your bucket, but building it does
  not. The server has to download every file the member can see into
  `data/staging` before it can zip them, so one export briefly needs about
  **twice** that member's files in free space on the server's own disk, and
  downloads all of them from your bucket. That download is free on Cloudflare
  R2 and billed on plain AWS S3. Using S3 keeps uploads off your server's disk;
  it does not do that for exports, so leave room for them.

**An export is not your backup.** It is a readable copy for a person. Your
backup is the `data` folder, above.

## Updating the server

Inside the `linger` folder:

```bash
./update.sh
```

It downloads the new version while the server keeps running, then stops it
for a few seconds to save the database into `backups/` (it keeps the last
five). It starts everything again, the relay too if you run one, and prints
the version before and after. If the new version doesn't start, it prints the
commands that put the old one back. When there's nothing new, it says so and
changes nothing.

Nothing updates itself. You decide when. If you type `sudo` before `docker`
commands, run `sudo ./update.sh`.

**No `update.sh` in your folder?** Servers set up before 0.4.5 get it once:

```bash
curl -fLO https://raw.githubusercontent.com/itsMattGuenther/Linger/main/deploy/update.sh
chmod +x update.sh
```

**By hand**, the update is:

```bash
docker compose pull
docker compose up -d
```

Without `update.sh` nothing makes a backup first; see [Backups](#backups).
These commands use the image name already in your `compose.yaml`. If that line
still says `ghcr.io/matthewguenther/linger`, change it to
`ghcr.io/itsmattguenther/linger:latest` (all lowercase) before pulling.
`update.sh` stops and says so. GitHub pages follow the username change; the
container registry does not.

If you run the relay and your `.env` has no `COMPOSE_PROFILES=voice` line, add
`--profile voice` after `docker compose` in both commands, or the relay stays
on its old version.

**A newer `compose.yaml` or `Caddyfile`.** A server set up with the setup
script, or by hand from 0.4.9, keeps every setting in `.env`, so a newer copy
of either file can replace the old one as it is:
`curl -fLO https://raw.githubusercontent.com/itsMattGuenther/Linger/main/deploy/compose.yaml`
(and the same for `Caddyfile`), then `./update.sh`.

**Moving an older server's settings into `.env`.** A server set up before
0.4.9 has its settings written into `compose.yaml` and its name into the
`Caddyfile`. That keeps working, and nothing makes you move. To move, so
newer files can simply replace the old ones:

1. Keep the old files: `cp compose.yaml compose.yaml.old` and
   `cp Caddyfile Caddyfile.old`.
2. Download the new `compose.yaml`, `Caddyfile` and `.env.example` (the
   commands are in [By hand](#by-hand-instead-of-the-script)).
3. No `.env` yet? `cp .env.example .env`. Then copy each setting from the
   `environment:` part of `compose.yaml.old` into `.env`, as `NAME=value`:
   `LINGER_DOMAIN` always, and any others you changed. A relay's
   `LINGER_TURN_SECRET` is in `.env` already. If the old file's coturn
   `command:` had an `--external-ip`, that address goes in
   `LINGER_RELAY_EXTERNAL_IP`.
4. `docker compose up -d`, then check the app still connects.

Repeat the [relay check](#the-voice-relay) after updating.

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
try `curl -f https://linger.example.com/api/v1/health` with your own name substituted.
If that fails, check `docker compose ps` and `docker compose logs caddy`.
Caddy needs inbound access for its certificate checks, and the app needs HTTPS
on TCP 443. Allow TCP 80 and 443. On a VPS check the provider and machine
firewalls; at home check router forwarding too. A valid setup token cannot fix
a connection failure.

### Voice cannot connect

- **The voice line says `Voice isn't set up on this server`:** the server
  couldn't work out where voice goes. `docker compose logs linger` says why
  near the top: `LINGER_VOICE_ADDRESS` is `off`, or the name doesn't point at
  a public address (yet). Follow [Voice](#voice).
- **It says the server needs an update:** the app is newer than the server.
  Run the update steps above.
- **Nobody hears anybody:** check that inbound UDP 3479 is open in both
  firewalls (and forwarded, if the server is at home), and that
  `docker compose logs linger` says `voice forwarding is on`.

For people on a network that blocks voice, the relay has to be running. Run
`docker compose --profile voice ps -a` and find `coturn`:

- **No coturn row:** finish [the voice setup](#the-voice-relay)
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
  folder is not writable by the container, on a server from before 0.4.9
  (from 0.4.9 it fixes that itself). Run
  `docker compose run --rm --user root --entrypoint chown linger linger:linger /data`,
  then `docker compose up -d` again. It does not delete the database.
- **Chat works but uploads fail.** The `cdn.` record is missing, or the second
  block of an older Caddyfile still says `linger.example.com`.
- **`docker compose pull` says `unauthorized`, or the image line still names
  `matthewguenther`.** The published image is
  `ghcr.io/itsmattguenther/linger` (all lowercase). GitHub Container Registry
  does not follow a GitHub username change, so an old compose file pulls a
  name that does not exist. Fix the `image:` line, then pull again. If it is
  still unauthorized after that, the prebuilt image is not available to you;
  clone the repository and build it yourself:
  `docker build -f deploy/Dockerfile -t ghcr.io/itsmattguenther/linger:latest .`
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
