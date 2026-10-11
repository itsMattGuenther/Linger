# Create an Ubuntu VPS

This is the preparation for the [host guide](host-guide.md). A VPS is a Linux
computer rented from a provider. It runs Linger even when your own computer
is off. You do not install the desktop app on it.

## 1. Choose the server

One tested starting point is a DigitalOcean **Basic Droplet**, **Ubuntu 24.04
LTS x64**, **1 vCPU, 2 GiB RAM and 50 GiB disk**. This worked in a two-person
test, not a measured minimum or a capacity guarantee. Choose a region near
your group. Other providers work too; their screens and login names differ.

Choose **SSH key** authentication. Before clicking Create, add your public
key as described below. Keep backups of anything you want to retain: a test
VPS is still a real computer with real data.

## 2. Add your SSH public key

Do this **on your own computer**, not the VPS. If you already use an SSH key,
reuse its public `.pub` file. Otherwise, open a terminal and run:

```bash
ssh-keygen -t ed25519 -C "linger-host"
```

Accept the default file location and choose a passphrase. **If it asks to
overwrite an existing key, answer no** and use that key's `.pub` file instead.
The commands below assume the default `id_ed25519` name.

Copy the **public** key using the command for your computer:

| Your computer | Copy command |
|---|---|
| Omarchy / Linux with Wayland and `wl-copy` | `wl-copy < ~/.ssh/id_ed25519.pub` |
| macOS | `pbcopy < ~/.ssh/id_ed25519.pub` |
| Windows PowerShell | `Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub \| Set-Clipboard` |

No clipboard tool on Linux? Run `cat ~/.ssh/id_ed25519.pub`, select the whole
line, and copy it from your terminal. You do not need to install `pbcopy`.

Paste that line into the provider's **SSH keys** field, select the saved key,
then create the VPS. **Never paste or share `id_ed25519` without `.pub`: that
is your private key.** [DigitalOcean's SSH-key guide](https://docs.digitalocean.com/products/droplets/how-to/add-ssh-keys/)
has the provider-specific screens.

## 3. Connect from your computer

Copy the VPS's **public IPv4 address** from its control panel. In a terminal
on your own computer, replace `YOUR_VPS_IP` below and run:

```bash
ssh root@YOUR_VPS_IP
```

On the first connection, SSH asks whether to trust the server's fingerprint.
In the provider's browser console, run
`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` and compare the SHA256
fingerprint before accepting. A key passphrase prompt unlocks your local key;
it is not asking you to invent a server password.

**Checkpoint:** the prompt now looks like `root@your-server:~#`. Commands in
that terminal run on the VPS. Keep this session open while setting the firewall.

## 4. Set the cloud firewall

In DigitalOcean, open **Networking → Firewalls → Create Firewall**. Add these
inbound rules and **apply the firewall to your Droplet**. Keep the default
outbound allowances for TCP, UDP and ICMP.

| Purpose | Protocol | Port(s) | Source |
|---|---|---|---|
| SSH access | TCP | `22` | Your public IP, or the dynamic-IP option below |
| Website and certificates | TCP | `80` | All IPv4 |
| App connection | TCP | `443` | All IPv4 |
| Voice | UDP | `3479` | All IPv4 |
| Voice relay, only if you run it | TCP | `3478` | All IPv4 |
| Voice relay, only if you run it | UDP | `3478` | All IPv4 |
| Voice relay's audio, only if you run it | UDP | `49160-49200` | All IPv4 |

Without UDP `3479`, text chat works and nobody in voice hears anybody. The
relay is optional, for friends on networks that block it
([host guide: the voice relay](host-guide.md#the-voice-relay)).

If you enable IPv6, add the corresponding IPv6 sources too. Do not open
Linger's internal port `8420` or Docker's control ports.

**Your home IP changes?** An SSH rule limited to that IP must be updated when
it changes. Alternatively, allow **All IPv4** on port 22 with **key-only SSH**.
That avoids lockouts when your IP changes, but lets anyone attempt an SSH
connection. Keep the server updated and the private key private.

Before choosing that option, run this **on the VPS**:

```bash
sudo sshd -T | grep -E '^(pubkeyauthentication|passwordauthentication|kbdinteractiveauthentication) '
```

For key-only access, expect `pubkeyauthentication yes`,
`passwordauthentication no` and `kbdinteractiveauthentication no`. If the
values differ, keep the IP restriction until SSH is configured for key-only
access. This check assumes a fresh server; custom SSH `Match` rules need
their own review.

After applying the firewall, open **a second terminal on your own computer**
and connect again with `ssh root@YOUR_VPS_IP`. Do not close the first session
until the second works. If you blocked yourself, correct the firewall in the
provider's control panel.

“No firewall assigned” means DigitalOcean is not filtering traffic with a
cloud firewall; it does not tell you whether Ubuntu has its own firewall.
An attached cloud firewall blocks traffic except what you allow.
[DigitalOcean explains the two firewall layers here](https://docs.digitalocean.com/products/networking/firewalls/how-to/configure-rules/).
If you already use UFW or another firewall on the VPS, allow the same service
ports there. Do not rely on UFW alone to restrict Docker-published ports;
[Docker handles those separately](https://docs.docker.com/engine/network/packet-filtering-firewalls/).

## 5. Install Docker and continue

Return to [host guide step 1](host-guide.md#1-install-docker-on-the-server).
It installs Docker, then walks through DNS, the server files, and your account.
