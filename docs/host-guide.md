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
  `update.sh` and `.env.example`, from the newest release, so they go with
  the server Docker downloads;
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
desktop app in step 4. Opened in a browser, it shows a page saying where to get the
app and to paste the link there; the account is only made in the app. Restarting
Linger before you use the
link creates a new one and invalidates the old one, and
`docker compose logs linger` prints the new one. If you accidentally share the
link, restart Linger to replace it.

The script can't change your provider's own firewall (DigitalOcean's Cloud
Firewalls, say): open the ports there yourself, as in step 1. It sends nothing
anywhere except GitHub, to ask which release is the newest and fetch its
files, and [api.ipify.org](https://api.ipify.org) to learn the server's public
address. Running it again is safe: it keeps an `.env` that's already there,
and it won't touch a folder that already runs a server.

If GitHub can't say which release is the newest, the script stops and says
so. `LINGER_SETUP_REF=v0.4.10 bash setup.sh` names a release yourself.
`LINGER_SETUP_REF=main` takes files that aren't released yet, for trying
what's next: they can ask for something the released server doesn't have.

From **your own computer**, check the address before opening the app:
`curl -f https://linger.example.com/api/v1/health` (replace the example name with
yours). If it does not return a short JSON response, use
[the connection checklist](#the-app-cannot-reach-the-server) first.

### By hand, instead of the script

The same steps, one at a time. Using [two free names](#using-free-names)
rather than `cdn.` in front of yours? This is your way, since the script
checks for `cdn.`.

The `release=` line asks GitHub for the newest release's name, such as
`v0.4.10`, and `echo` shows it. The files come from that release, so they go
with the server Docker downloads; the ones on `main` can be ahead of it. If
`echo` shows nothing, GitHub didn't answer: type the newest name from
[the releases page](https://github.com/itsMattGuenther/Linger/releases/latest)
yourself, as `release=v0.4.10`, and run the lines after it again.

```bash
mkdir linger
cd linger
release=$(curl -fsSL https://api.github.com/repos/itsMattGuenther/Linger/releases/latest | grep -o '"tag_name": *"[^"]*"' | cut -d'"' -f4)
echo "$release"
for file in compose.yaml Caddyfile update.sh .env.example; do
  curl -fLO "https://raw.githubusercontent.com/itsMattGuenther/Linger/$release/deploy/$file"
done
chmod +x update.sh
cp .env.example .env
chmod 600 .env
nano .env
```

`chmod 600` makes `.env` readable by you alone: it will hold the relay's
secret, and any cloud storage keys. The setup script does the same.

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
made. Send it however you normally talk to your friends. A friend who taps it
before they have Linger gets a page from your server with the server's name,
where to download the app, and the link to paste into it. A friend who already
has Linger can press **Open in Linger** there instead, and the app opens with
the link in its box. Nothing about this needs setting up on the server.

**Hosting → Server** shows which version your server runs, and says when a
newer one is out, with a link to [updating the server](#updating-the-server).
Only you see it.

An invite link is the only way to get an account. There is no public sign-up.
Inviting a big group at once? Read [A big group joining at once](#a-big-group-joining-at-once)
first.
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
  49160 to 49359** too.

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

- **Rooms**: create, rename, set a topic, reorder, archive, and turn
  reactions off or on (below).
- **Invites**: make a link, and see or **Revoke** the ones still open.
- **People**: remove someone (it asks first; they lose access, and their
  messages stay), and let them back in. Removals are reversible; that is the
  point. What they were still uploading, and files they uploaded but never
  sent, are deleted when they're removed, and don't come back with them.
  Somebody removed can also have their account **deleted**, below.
- **Server**: its name and color. The name is what everybody's list shows and
  what an invite link tells a stranger; the color is the server's stripe in
  everybody's list. You also see which version it runs, when it last backed
  itself up, and whether its disk is nearly full ([Backups](#backups)).

Newcomers start on the name color the fewest people on the server wear, so a
big group isn't a list of gray names. Anyone can change theirs in **Settings →
Profile**.

**Reactions in a room.** People can react to a message with any emoji, your
server's own included ([how they work](user-guide.md#saying-things)). They
never notify anybody. To turn them off in one room, open **Hosting → Rooms**,
press **Edit** beside the room, switch off **Reactions**, and **Save**. The
room then shows no reactions to anybody, and offers no way to add one. Nothing
is deleted: switch them back on and they're all there again. A DM has no host,
so it always has reactions. Anybody can also hide reactions just for
themselves, in **Settings → Appearance**; that changes nothing for anyone else.

A server on 0.4.10 or older can't take reactions, so the app offers none
there, and the switch has nothing to turn off: [update the
server](#updating-the-server) first. Friends whose app is 0.4.10 or older see
no reactions until they update it.

**Going away? Make somebody a co-host.** Open their card (click their name),
then **···** and **Make Jules a co-host**. A co-host gets the same **Hosting**
sections and can do everything above, handle reports, and take somebody out
of voice. They can't make other co-hosts or [sign-in
links](#somebody-forgot-their-password), and they can't act on you: remove
you, take you out of voice, delete your messages or revoke your invites. Their
card says "co-host". To stop it, choose **Jules stops being a co-host** on the
same menu. Only you see the server's version, since updating the server is
still yours to do.

**Somebody asks you to delete their account.** Anybody still on the server can
delete their own, in **Settings → Account & App → Delete Your Account**
([how it works](user-guide.md#deleting-your-account)). Somebody you removed
can't sign in to do that, and somebody without the app can't either, so it's
yours: remove them first if they're still a member, then in **Hosting → People
→ Removed** press **Delete account** beside them. Tick **Also delete everything
they wrote** if they asked for that too, then **Yes, delete it**. It can't be
undone: their name, status, sign-ins and settings go at once, and what they
wrote either goes or stays as "Deleted account". Their username stays taken, and
reports about them stay with you. Only you can do this, not a co-host. Your own
account can't be deleted: to close the server, shut it down and delete its data.

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
  then on, and reactions made with it are gone.

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
| `LINGER_FILE_EXPIRY_DAYS` | When old files are deleted. `when-full` keeps them until the server needs the room: past 90% of `LINGER_POOL_BYTES`, the oldest go first until it's under 80%. A number of days deletes each file that long after it was shared, however much room there is. `off` keeps every sent file forever, and uploads are refused once it's full. Starred files, and files on pinned messages, never go. | `when-full` |
| `LINGER_BACKUPS` | `off` stops the server's nightly copy of its database into `data/backups` ([Backups](#backups)). | on |
| `LINGER_SCREENS` | `off` stops screen sharing in voice ([Shared screens](#shared-screens)). Voice carries on. | on |
| `LINGER_BACKUP_S3_*` | A bucket each nightly copy is also sent to, so it survives the machine: `_BUCKET`, `_ACCESS_KEY_ID` and `_SECRET_ACCESS_KEY`, plus `_ENDPOINT`, `_REGION` and `_PATH_STYLE` as for files, and `_PREFIX` for where in the bucket. See [Sending the copies to a bucket](#sending-the-copies-to-a-bucket). | unset — copies stay on the machine |
| `LINGER_MEDIA_DOMAIN` | The name files are served from. Set it if you are using two free names, or want something other than `cdn.` + your domain. It must be different from the main one. | `cdn.<your address>` |
| `LINGER_STORAGE` | `local` keeps files on the machine. `s3` keeps them in a cloud bucket. | `local` |
| `LINGER_VOICE_ADDRESS` | Where voice goes: the server's public IP address, or `off` for no voice. The relay carries voice there and nowhere else. See [Voice](#voice). | the address your name points at |
| `LINGER_TURN_SECRET` | Shared key for Linger and the relay; you must also start the relay below. | unset — no relay |
| `LINGER_TURN_URLS` | Where the relay is, if not `turn:<your address>:3478`. Comma-separated `turn:`/`stun:` addresses. | derived from your address |
| `LINGER_SIGNUPS_PER_HOUR` | How many people may sign up from one network in an hour, all at once if need be. Raise it, or set `off`, when a big group is joining together from one place. See [A big group joining at once](#a-big-group-joining-at-once). | `60` |
| `LINGER_PASSWORD_CHECKS_AT_ONCE` | How many passwords the server checks at the same time, from 1 to 256. Each check holds about 19 MB of memory and a CPU core for a moment, so N at once can take N × 19 MB (4 is 76 MB, 16 is about 300 MB). Raise it only if people are told the server is busy and the machine has the cores and memory. | `4` |
| `LINGER_TRUSTED_PROXIES` | Which proxies the server believes about who's connecting, for the limits on signing in and signing up. Only needed for a proxy that isn't on this machine or a private network, such as Caddy on another machine reaching this one over Tailscale: `private,100.64.0.0/10`. Comma-separated addresses and ranges; `private` is this machine and private networks, and leaving it out stops trusting them. See [Other problems](#other-problems). | `private` |

One file can be up to 500 MB.

**How full it gets.** With `when-full`, the default, the file space is meant
to fill up: nothing is deleted while there's room, so files take up to 90% of
`LINGER_POOL_BYTES` before the oldest start going. Set `LINGER_POOL_BYTES` to
what you're happy to give files, not the whole disk; the setup script picks a
size that fits yours. On a cloud bucket it's the same: the bucket has no limit
of its own, so `LINGER_POOL_BYTES` is the one Linger fills to, and you pay for
what's in the bucket. In the app, Media's **Leaving soon** shows people what
would go next, so they can star what they want kept.

Nobody can fill the storage by themselves. One person can have 1 GB of files
uploading at once; past that, they're told to let those finish first. An upload
that stops, because the app closed or the connection went, gives its space back
after an hour. A file somebody uploads and never sends is deleted after a week,
even with `LINGER_FILE_EXPIRY_DAYS=off`.

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
people's files (and the nightly copies, if you
[send them here](#sending-the-copies-to-a-bucket)).

### A big group joining at once

If you send one invite to a big group, a few limits decide how fast they get in.
Anyone who meets one is told what's happening and when to try again, so nobody is
left with an error and no explanation.

- **Sign-ups from one network: 60 an hour.** Sixty people can join from one place
  in one go; after that the server takes one more a minute from there. People at
  home each have their own address, so this only matters when many people share
  one: a school, an office, a LAN party, or a phone network that puts lots of
  customers behind one address. The person who meets it sees *"Lots of people have
  joined from your network in the last hour, so this server is pausing new sign-ups
  from it. Try again in about a minute. If your group is joining together, the host
  can raise this limit."* Linger's log says it happened, without anybody's address,
  at most once every 5 minutes. **To let more in, set `LINGER_SIGNUPS_PER_HOUR` in
  `.env`**, to 500 say, or `off` for no limit per network, then run
  `docker compose up -d`. The invite still decides who can join: an invite for 50
  people lets in 50, whatever this says. The setting exists so that somebody with
  an invite can't make the server do unlimited work, so put it back afterwards if
  your invite is good for a lot of people or never runs out.
- **Password checks at once: 4.** Checking a password is slow and memory-hungry on
  purpose, which is what makes guessing passwords slow. The server does four at
  once and the rest wait their turn, up to 5 seconds. Four gets through several
  sign-ins a second even on a small machine, so this rarely matters. If people are
  told *"The server is busy letting other people in. Try again in a moment."*,
  and your machine has more cores and memory than Linger is using, **raise
  `LINGER_PASSWORD_CHECKS_AT_ONCE`**: each one can take about 19 MB, so 8 can take
  about 150 MB and 16 about 300 MB. More than the machine's number of cores makes
  nobody faster.
- **Sign-in tries from one network: 5 a minute.** This one isn't a setting: it's
  what stops somebody guessing passwords. It only counts sign-ins, so people who
  joined stay signed in and don't meet it. Somebody who does is told *"Too many
  sign-in tries from your network in the last minute. Try again in 12 seconds."*

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

### Shared screens

Anybody in a room's voice can share their screen (#360), and it goes through
your server the same way: the person sharing sends it once, and your server
sends a copy to each person watching. It needs nothing set up. It travels on
the server's own address, the one the app already uses, so it doesn't need
UDP 3479 and works through the proxy in front of the server.

What it costs is upload: up to about 2.5 Mbps for each person watching a
share at Low quality (720p, 30 frames a second), and 6 Mbps at High quality
(1080p, 60 frames a second), less for a still slide. A share with the
computer's sound (#736) adds about 128 kbps for each person listening; your
server sends it only to people who have their speaker on. Eight people
watching a presentation for an hour is roughly 7 GB of data out; a game shared
at 60 frames a second to eight people is closer to 20 GB an hour, and its
sound about half a gigabyte more. Your server
holds every share to 10 Mbps whatever an app sends, its sound included, and a
room to three shares at once. The server passes the pictures on without opening them and keeps
nothing; like voice, a host who changed the server could see them.

It is light on the server itself. On the smallest DigitalOcean server (one
CPU, 2 GB of memory), eight people watching a busy screen at 60 frames a
second took the Linger server about 4% of the CPU and under 10 MB of memory,
and Caddy about 10% for the HTTPS (2026-10-25, `scripts/screen-loop.mjs`).
Upload is the limit, not the computer.

To turn screen sharing off, put `LINGER_SCREENS=off` in `.env` and run
`docker compose up -d`. Voice carries on as before; the apps stop offering
Share and Watch.

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

**It only carries voice to your server.** A relay passes on whatever it's
asked to, and it sits on your machine's network, so an open one would let any
member reach things only your machine should: your home network's router page
or printer, your cloud provider's private settings service, or the internet
looking like your machine. `compose.yaml` stops that (#501). The relay refuses
every address except your server's voice address, the same one the server
uses: `LINGER_VOICE_ADDRESS` if you set it, or else the address your name
points at, looked up when the relay starts. It also caps each member at ten
relay ports and each port at 3 Mbit/s, which is three times what the busiest
call needs. If it has no address to go on (`LINGER_VOICE_ADDRESS=off`, or a
name that doesn't point at a public address), it carries nothing at all and
says so in `docker compose --profile voice logs coturn`. If DNS doesn't answer
at all for a minute (at boot, say), the relay stops and Docker starts it again
to ask again.

Said yes to the relay in the setup script? It's set up and running: skip to
step 4 to check it. Otherwise, run these steps **on the server**, inside the
`linger` folder containing `compose.yaml`.

1. Run `openssl rand -hex 32` to make a secret, then open `nano .env`. Paste
   the secret after `LINGER_TURN_SECRET=`, and remove the `#` before
   `COMPOSE_PROFILES=voice`, which tells Docker to start the relay with
   everything else. Save with **Ctrl+O**, Enter, then **Ctrl+X**. Keep the
   secret private: `chmod 600 .env` makes the file readable by you alone.
   Compose gives it to Linger and coturn alike. (No `.env` yet, on a server
   set up before 0.4.9? Download `.env.example` from the
   [server files](#by-hand-instead-of-the-script), `cp .env.example .env`,
   `chmod 600 .env`, and fill in just those two lines.)
2. Allow inbound port **3478**, both TCP and UDP, and UDP ports **49160 to
   49359** in the provider's firewall and any firewall on the server. Keep
   TCP **80 and 443** open too. If the machine is behind a home router rather
   than on a public address, forward them as well, and remove the `#` before
   `LINGER_RELAY_EXTERNAL_IP` in `.env` with your public IP after it, so the
   relay tells people where it really is.

   Those 200 ports are room for everybody in voice at once. While the relay
   is on, each person in voice holds one, even when their voice goes straight
   to your server, and somebody whose connection drops can hold a second for
   up to ten minutes. So 200 covers a voice room of 60, the most one room
   holds, with plenty to spare for reconnects. Expecting more than 100 people
   in voice at once, across all your rooms? Raise `--max-port=49359` in
   `compose.yaml`, open the wider range in both firewalls, and run
   `docker compose --profile voice up -d`. A newer `compose.yaml` puts it
   back, so make the change again whenever you replace the file.
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
   should no longer warn that `LINGER_TURN_SECRET` is missing. And check
   `docker compose --profile voice logs coturn | head -n 5`: it should say
   `the relay carries voice to` your server's public address `and nowhere
   else`.

Finally, have two people on different networks leave and rejoin voice and
check that each can hear the other. **Up only proves the relay process is
running**; it does not prove that the firewall or voice connection works.

---

## Backups

The whole server is the `data` folder next to your `compose.yaml`. It holds
`linger.db` (every message) and `objects/` (every uploaded file). Keep a copy
of `.env` somewhere safe too: it holds your settings and the relay's secret.

### What the server does by itself

Every night the server copies its database into `data/backups/` while it keeps
running, so nobody notices, and checks that the copy opens cleanly. It keeps a
week of nightly copies (`linger-daily-2026-10-11.db`) and a month of weekly
ones (`linger-weekly-…`), and deletes older ones itself. The first copy is made
a couple of minutes after the server starts, then one every 24 hours. Each is
about the size of your database. The uploaded files aren't in them.

**These copies are on the same disk as the server.** They save you from a bad
update, a mistaken command or a damaged database file. They don't survive the
disk dying, the machine being deleted, or your hosting account closing. For
that, keep a copy somewhere else too: let the server
[send them to a bucket](#sending-the-copies-to-a-bucket), or copy them
yourself ([below](#a-copy-somewhere-else)).

In the app, **Settings → Hosting → Server** says when the last copy was made.
If the server goes three days without making one, a quiet line at the foot of
your list says so ("Pinecone hasn't been backed up for 3 days."), and the
server's log (`docker compose logs linger`) says why. A full disk is the usual
reason. Only you see that line, not co-hosts or anybody else.

The same place tells you when the disk is nearly full (less than a tenth
free), or when uploaded files have nearly used up `LINGER_POOL_BYTES`. A full
disk stops the server for everybody, so don't wait for it: free some space,
lower `LINGER_POOL_BYTES`, or [move to a bigger machine](#moving-to-a-new-machine).

Already back up the `data` folder another way and don't want the copies? Put
`LINGER_BACKUPS=off` in `.env`, then `docker compose up -d`.

### Sending the copies to a bucket

The server can send each night's copy to a cloud bucket as well, so it
survives this machine. Any S3-compatible storage works; Cloudflare R2 is a
good pick, and a month of copies of a friend group's database costs pennies
or nothing. Make a bucket and a key that can write to it, then fill in these
lines in `.env` (they're there as comments) and run `docker compose up -d`:

```bash
LINGER_BACKUP_S3_BUCKET=linger-backups
LINGER_BACKUP_S3_ENDPOINT=https://ACCOUNT.r2.cloudflarestorage.com
LINGER_BACKUP_S3_REGION=auto
LINGER_BACKUP_S3_ACCESS_KEY_ID=...
LINGER_BACKUP_S3_SECRET_ACCESS_KEY=...
```

They work like the `LINGER_S3_*` lines for files: leave out the endpoint for
AWS itself. They're separate, so your files can stay on this disk while the
copies go away. If your files are already in a bucket you can use the same
one, with the same keys: the copies go under `backups/`, out of the files'
way. `LINGER_BACKUP_S3_PREFIX` puts them somewhere else in the bucket
(`/` for its top level).

A few minutes after the server starts it looks at the bucket and sends the
newest copy if the bucket doesn't have it yet. After that, each night's copy
goes once it has checked out. The bucket keeps the same week of nightly copies
and month of weekly ones as `data/backups`, and the server deletes older ones
there too. It never touches anything else in the bucket. If the bucket can't
be reached, the copy on the disk is still made, and the server tries the
bucket again every hour.

**Settings → Hosting → Server** says when the newest copy got there. If none
has for three days, a quiet line at the foot of your list says so ("Pinecone's
backups haven't reached its bucket for 3 days."), and the server's log says
why: usually a wrong key or bucket name.

If some of the lines are filled in but not the bucket or both keys, the server
won't start, and its log names the missing one.

This sends the database, not the uploaded files. Copy those yourself, as
below.

### A copy somewhere else

Only the server and root can open the `data` folder, so nobody else with an
account on this machine can read it. So the copy is made by a throwaway
Linger container, which can open it; any account that runs `docker` can do
this, no `sudo` needed. Copy it while the server is stopped, so you never
catch the database mid-write:

```bash
docker compose stop linger
(umask 077 && docker compose run --rm --no-deps -T --user root --entrypoint tar linger czf - -C /data . >linger-backup-$(date +%F).tar.gz)
docker compose start linger
```

`umask 077` makes the copy readable by you alone, like the folder. That is a
few seconds of downtime. Then move the file to another machine, or to cloud
storage you trust.

Without stopping anything, you can copy the nightly copies and the uploaded
files off the machine instead. An uploaded file never changes once it's up,
so each run only sends what's new. With `rsync` to another machine you can
SSH into:

```bash
sudo rsync -a data/backups data/objects you@other-machine:linger-backup/
```

or with [`rclone`](https://rclone.org/), to cloud storage you've set up for
root as `remote:` (`sudo rclone config`), the same two folders:
`sudo rclone copy data/backups remote:linger-backup/backups` and
`sudo rclone copy data/objects remote:linger-backup/objects`. Either is a line
to put in a scheduled job (`sudo crontab -e`).

`update.sh` also saves the database into `backups/` (next to `compose.yaml`,
not inside `data`) whenever it updates the server. That copy is for going back
after an update, and it doesn't replace the others.

### Restoring

From one of the nightly copies, with the server stopped (put the copy's name
in place of `linger-daily-2026-10-10.db`):

```bash
docker compose stop linger
docker compose run --rm --no-deps -T --user root --entrypoint sh linger -c 'cd /data && rm -f linger.db-wal linger.db-shm && cp backups/linger-daily-2026-10-10.db linger.db && chmod 600 linger.db'
docker compose start linger
```

Everything written after that copy was made is gone: messages, people who
joined, rooms you made. Uploaded files sent since then stay on the disk but
nothing points at them anymore.

From a full copy you made yourself, unpack it into the `data` folder the same
way (put your copy's name in place of `linger-backup-2026-10-10.tar.gz`):

```bash
docker compose stop linger
docker compose run --rm --no-deps -T --user root --entrypoint sh linger -c 'rm -f /data/linger.db-wal /data/linger.db-shm && tar xzf - -C /data' <linger-backup-2026-10-10.tar.gz
docker compose start linger
```

Both clear the database's two journal files first: left over from another
copy, they would be applied to this one.

From a copy in your bucket, download it first (from the provider's website,
or `rclone copy`), put it in `data/backups/` with the same name, and restore
it as a nightly copy:

```bash
docker compose run --rm --no-deps -T --user root --entrypoint sh linger -c 'cat > /data/backups/linger-daily-2026-10-10.db' <linger-daily-2026-10-10.db
```

then the three lines for a nightly copy above.

(If you moved files to a cloud bucket, `data/objects/` is empty and the bucket
is the other half of your backup.)

## Moving to a new machine

Everything the server is lives in the `linger` folder: `compose.yaml`, the
`Caddyfile`, `.env` and `data`. Moving it is copying that folder and pointing
your names at the new machine. Friends' apps follow the name: they reconnect
once the names point at the new machine, and stay signed in.

1. On the new machine, [install Docker](#1-install-docker-on-the-server) and
   open the same firewall ports as before.
2. On the old machine, stop everything and pack the folder up, keeping who
   owns what:

   ```bash
   cd linger
   docker compose down
   cd ..
   sudo tar --numeric-owner -czpf linger-move.tar.gz linger
   ```

3. Copy `linger-move.tar.gz` to the new machine (with `scp`, say) and unpack
   it there: `sudo tar --numeric-owner -xzpf linger-move.tar.gz`.
4. Point both names (`linger.` and `cdn.linger.`) at the new machine's
   address, as in [step 2](#2-point-two-names-at-the-server). If `.env` has
   `LINGER_VOICE_ADDRESS` or `LINGER_RELAY_EXTERNAL_IP` set to the old
   machine's address, change it to the new one.
5. On the new machine, `cd linger` and `docker compose up -d`. Caddy gets new
   certificates by itself once the names point here.
6. Check the app connects, then delete the old machine.

With `LINGER_STORAGE=s3` the files stay in the bucket and the new machine
reads them there; only the folder moves.

## Exports (and what they do to your disk)

Any member can ask the server for a zip of everything on it — every message and
every file. This is deliberate and you cannot turn it off: it is the promise
that nobody is locked in, including when the person locking them in would be
you.

A few things keep it from being a problem:

- A member can only ask **once an hour**, and each member has **one** archive
  at a time. Asking again deletes the previous one.
- **An archive is deleted a week after it's ready**, and straight away when you
  remove that member. It's something to download, not something the server
  keeps. The app tells the member when their link stops working.
- Only **one archive is built at a time** across the whole server. If several
  people ask at once, the others wait their turn, so building never needs room
  for more than one archive at once.
- **The server won't start an export your disk can't hold.** It checks the free
  space first, and again when a waiting export gets its turn, and tells the
  member in plain words that there isn't room. A full disk would stop the whole
  server, not just the export.

So the most exports can cost you is one copy of your server for each member who
asked in the past week, and in practice far less.

Those archives live alongside your uploaded files and are not counted in the
storage figure members see. If disk space is tight, that is worth knowing. If
the server restarts in the middle of building one, the member sees that it
failed and can ask again, and the half-built scratch in `data/staging` is
cleared out when the server starts.

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
release=$(curl -fsSL https://api.github.com/repos/itsMattGuenther/Linger/releases/latest | grep -o '"tag_name": *"[^"]*"' | cut -d'"' -f4)
curl -fLO "https://raw.githubusercontent.com/itsMattGuenther/Linger/$release/deploy/update.sh"
chmod +x update.sh
```

**By hand**, the update is:

```bash
docker compose pull
docker compose up -d
```

Without `update.sh` nothing makes a backup first, apart from the server's own
nightly copy; see [Backups](#backups).
These commands use the image name already in your `compose.yaml`. If that line
still says `ghcr.io/matthewguenther/linger`, change it to
`ghcr.io/itsmattguenther/linger:latest` (all lowercase) before pulling.
`update.sh` stops and says so. GitHub pages follow the username change; the
container registry does not.

If you run the relay and your `.env` has no `COMPOSE_PROFILES=voice` line, add
`--profile voice` after `docker compose` in both commands, or the relay stays
on its old version.

**Run the voice relay? It needs more ports open after 0.4.10.** From the
release after 0.4.10, the relay uses UDP ports **49160 to 49359**, so it has
room for a 60-person voice room. Before, it was 49160 to 49200. When you
update to that release:

1. Open UDP **49160 to 49359** in your provider's firewall and in any firewall
   on the server (with `ufw`: `sudo ufw allow 49160:49359/udp`). At home,
   forward the same range on your router too.
2. Get the new `compose.yaml` (just below), then run `./update.sh`.

Do them in that order. With the new `compose.yaml` and the old firewall, the
relay hands most of the people who need it a port your firewall drops, and
they can't get into voice (the app says `can't reach`). Everybody whose voice
goes straight to your server is fine either way. Kept the old `compose.yaml`?
Nothing breaks, but the relay stays at 41 ports, and fills up once about 40
people are in voice at once.

**A newer `compose.yaml` or `Caddyfile`.** A server set up with the setup
script, or by hand from 0.4.9, keeps every setting in `.env`, so a newer copy
of either file can replace the old one as it is. Take the newest release's,
which goes with the server `./update.sh` downloads: the `release=` line from
[By hand](#by-hand-instead-of-the-script), then
`curl -fLO "https://raw.githubusercontent.com/itsMattGuenther/Linger/$release/deploy/compose.yaml"`
(and the same for `Caddyfile`), then `./update.sh`.

`update.sh` never replaces either file itself, since `compose.yaml` can hold a
version you chose. But when you run the relay with a `compose.yaml` from before
the relay was kept to voice (#501), it says so at the end and prints the
command that gets the one from the release your server now runs. If you had
changed the `image:` line to stay on a version, change the new file's line the
same way.

**Moving an older server's settings into `.env`.** A server set up before
0.4.9 has its settings written into `compose.yaml` and its name into the
`Caddyfile`. That keeps working, and nothing makes you move. To move, so
newer files can simply replace the old ones:

1. Keep the old files: `cp compose.yaml compose.yaml.old` and
   `cp Caddyfile Caddyfile.old`.
2. Download the new `compose.yaml`, `Caddyfile` and `.env.example` (the
   commands are in [By hand](#by-hand-instead-of-the-script)).
3. No `.env` yet? `cp .env.example .env`, then `chmod 600 .env`. Then copy
   each setting from the `environment:` part of `compose.yaml.old` into
   `.env`, as `NAME=value`: `LINGER_DOMAIN` always, and any others you
   changed. A relay's
   `LINGER_TURN_SECRET` is in `.env` already. If the old file's coturn
   `command:` had an `--external-ip`, that address goes in
   `LINGER_RELAY_EXTERNAL_IP`.
4. `docker compose up -d`, then check the app still connects.

Repeat the [relay check](#the-voice-relay) after updating.

## Somebody forgot their password

In the app: **Settings → Hosting → People**, under **Sign-in Links**, choose them and
press **Make a sign-in link**. It asks first, then copies a link like
`https://linger.example.com/sign-in/…`. Send it to
them the way you'd send an invite. They paste it into **Server or link**, choose a new
password, and they're in. Only you can do this: a co-host doesn't get Sign-in Links,
because whoever holds a link can sign in as that person.

- It works **once**, and for **one day**. Making another cancels the last.
- Using it **signs them out everywhere else**, the same as changing their password.
- Their **Settings → Account & App** says you made them one, and when it was used, so
  a link they didn't ask for doesn't go unnoticed.
- Whoever holds the link can sign in as them. Send it only to them, and only over
  something you trust is them.
- Removing somebody cancels any link made for them.

Nobody can make one for **the host**. If that's you and you're locked out, the server
has one maintenance command. Stop it first — the database allows one writer at a time.

```bash
docker compose stop linger
docker compose run --rm linger reset-password your-username
docker compose start linger
```

It prints a new password. Sign in with it, then change it in the app under
**Settings → Account & App → Password**. The same command works for anybody, if the
app isn't an option.

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
  and check that coturn stays Up. `DNS gave no answer` means the server
  can't look your name up: the relay keeps trying, a minute at a time, and
  `LINGER_VOICE_ADDRESS` in `.env` with your public IP saves it the lookup.
- **Stays Up, but voice says `can't reach`:** check inbound TCP/UDP 3478 and
  UDP 49160–49359 in both firewalls (and router forwarding at home). After
  changing `.env`, run `docker compose --profile voice up -d` to apply the
  same secret to both containers; restarting only coturn is not enough.
- **coturn's log says `the relay carries nothing`:** it couldn't work out
  your server's voice address, usually because your name didn't point at a
  public address when it started (`docker compose logs linger` will say the
  same about voice). Fix where the name points and run
  `docker compose --profile voice restart coturn`, or put your server's public
  IP after `LINGER_VOICE_ADDRESS=` in `.env` and run
  `docker compose --profile voice up -d`.

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
- **People are told to wait when they've barely tried.** Each address gets 5
  sign-in tries a minute and 60 sign-ups an hour (`LINGER_SIGNUPS_PER_HOUR`; see
  [A big group joining at once](#a-big-group-joining-at-once)). The server takes the
  address from the connection. It believes the `X-Forwarded-For` header only
  when the connection comes from a proxy it trusts, and then only the header's
  last entry, the one that proxy wrote. By default it trusts this machine and
  private networks, which is how Caddy from `compose.yaml` connects, so the
  shipped setup needs nothing more. A proxy anywhere else, such as Caddy on a
  VPS reaching a home server over Tailscale, has to be listed in
  `LINGER_TRUSTED_PROXIES` in `.env` (`private,100.64.0.0/10` for
  Tailscale), or everybody counts as the proxy and shares one allowance:
  Linger's log says so once, with the proxy's address, the first time it
  happens. A proxy of your own instead of Caddy has to set that header too
  (nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`).
  Behind a second proxy in front of Caddy, such as Cloudflare's, the address
  the server sees is that proxy's, so people who come through the same one
  share an allowance.
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
