#!/usr/bin/env python3
"""Exercise real Linux desktops against a disposable server (HC-4/5/7).

Uses the W3C WebDriver HTTP interface, not mocked Tauri commands. Requires
the debug binaries, pnpm dependencies, Xvfb, dbus-run-session, tauri-driver,
WebKitWebDriver and Chromium. See docs/desktop-checks.md. No third-party
Python packages are needed. All processes and browser profiles are isolated.
"""

import argparse
import base64
from http.client import HTTPConnection, HTTPSConnection
import json
import os
from pathlib import Path
import re
import secrets
import select
import shlex
import shutil
import signal
import socket
import struct
import subprocess
import tempfile
import time
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import urlopen
import zipfile


ROOT = Path(__file__).resolve().parent.parent
ELEMENT = "element-6066-11e4-a52e-4f735466cecf"


def http(method, url, data=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    target = urlsplit(url)
    path = target.path or "/"
    if target.query:
        path += "?" + target.query
    connection_type = HTTPSConnection if target.scheme == "https" else HTTPConnection
    connection = connection_type(target.hostname, target.port, timeout=30)
    try:
        # urllib adds Connection: close, which tauri-driver forwards to its
        # pooled native connection. Avoid racing reuse of that closing socket.
        connection.request(method, path, headers=headers,
                           body=None if data is None else json.dumps(data).encode())
        response = connection.getresponse()
        body = response.read()
        if response.status >= 400:
            # Request bodies contain credentials and must not enter the report.
            raise RuntimeError(f"{method} {path}: HTTP {response.status}: " + body.decode()[:500])
    finally:
        connection.close()
    return json.loads(body) if body else None


def until(check, description, timeout=20):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        result = check()
        if result:
            return result
        time.sleep(0.2)
    raise AssertionError("Timed out: " + description)


def available_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Desktop:
    def __init__(self, run, name):
        self.run = run
        self.area = run.output / name
        self.area.mkdir(mode=0o700)
        env = dict(os.environ, GDK_BACKEND="x11", LIBGL_ALWAYS_SOFTWARE="1",
                   XDG_CURRENT_DESKTOP="GNOME", GTK_USE_PORTAL="0", NO_AT_BRIDGE="1")
        for key in ("WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "AT_SPI_BUS_ADDRESS"):
            env.pop(key, None)
        for kind in ("config", "data", "cache", "runtime"):
            directory = self.area / kind
            directory.mkdir(mode=0o700)
            key = f"XDG_{kind.upper()}_HOME" if kind != "runtime" else "XDG_RUNTIME_DIR"
            env[key] = str(directory)
        self.browser_profile()
        readfd, writefd = os.pipe()
        try:
            run.launch([run.commands["Xvfb"], "-displayfd", str(writefd),
                        "-screen", "0", "1100x720x24", "-nolisten", "tcp"],
                       self.area / "display.log", env, pass_fds=(writefd,))
        finally:
            os.close(writefd)
        with os.fdopen(readfd) as pipe:
            if not select.select([pipe], [], [], 10)[0]:
                raise RuntimeError("Xvfb did not supply an isolated display")
            number = pipe.readline().strip()
            if not number.isdigit():
                raise RuntimeError("Xvfb exited before creating its display")
        env["DISPLAY"] = ":" + number
        self.env = env
        port, native_port = available_port(), available_port()
        while native_port == port:
            native_port = available_port()
        driver = run.launch(
            ["dbus-run-session", "--", run.commands["tauri-driver"], "--port", str(port),
             "--native-port", str(native_port), "--native-driver", run.commands["WebKitWebDriver"]],
            self.area / "driver.log", env,
        )
        self.base = f"http://127.0.0.1:{port}"
        run.wait_http(self.base + "/status", driver)
        session = http("POST", self.base + "/session", {"capabilities": {"alwaysMatch": {
            "tauri:options": {"application": str(ROOT / "client/src-tauri/target/debug/linger-client")},
        }}})["value"]
        self.base += "/session/" + session["sessionId"]
        run.desktops.append(self)
        self.wait_text("continue")
        assert self.js("return typeof window.__TAURI_INTERNALS__") == "object"

    def browser_profile(self):
        """Register a real browser only in this test desktop's XDG directories."""
        applications = self.area / "data/applications"
        applications.mkdir()
        downloads = self.area / "downloads"
        downloads.mkdir()
        profile = self.area / "chromium/Default"
        profile.mkdir(parents=True)
        (profile / "Preferences").write_text(json.dumps({
            "download": {"default_directory": str(downloads), "prompt_for_download": False},
            "browser": {"check_default_browser": False},
        }))
        # This empty browser profile has no saved credentials. The basic store
        # avoids trying to unlock a real wallet in a disposable D-Bus session.
        args = [self.run.commands["chromium"], "--user-data-dir=" + str(profile.parent),
                "--ozone-platform=x11", "--disable-gpu", "--password-store=basic",
                "--no-proxy-server", "--no-first-run", "--no-default-browser-check",
                "--disable-background-networking", "--disable-component-update", "--disable-sync"]
        launcher = self.area / "browser"
        launcher.write_text("#!/bin/sh\nexec " + shlex.join(args) + ' "$@" >> '
                            + shlex.quote(str(self.area / "browser.log")) + " 2>&1\n")
        launcher.chmod(0o700)
        escaped = str(launcher).replace("\\", "\\\\").replace('"', '\\"')
        (applications / "linger-check-browser.desktop").write_text(
            '[Desktop Entry]\nType=Application\nName=Test browser\n'
            f'Exec="{escaped}" %u\nTerminal=false\n'
            'MimeType=x-scheme-handler/http;x-scheme-handler/https;\n'
        )
        (self.area / "config/mimeapps.list").write_text(
            "[Default Applications]\n"
            "x-scheme-handler/http=linger-check-browser.desktop;\n"
            "x-scheme-handler/https=linger-check-browser.desktop;\n"
        )

    def call(self, method, path, data=None):
        return http(method, self.base + path, data)["value"]

    def js(self, script, *args):
        return self.call("POST", "/execute/sync", {"script": script, "args": list(args)})

    def element(self, selector, using="css selector"):
        found = self.call("POST", "/elements", {"using": using, "value": selector})
        return found[0][ELEMENT] if found else None

    def click(self, selector, using="css selector"):
        def enabled():
            element = self.element(selector, using)
            return element if element and self.call("GET", f"/element/{element}/enabled") else None
        element = until(enabled, "enabled control " + selector)
        self.call("POST", f"/element/{element}/click", {})

    def button(self, label):
        self.click(f"//button[normalize-space(.)={json.dumps(label)}]", "xpath")

    def fill(self, selector, text):
        element = until(lambda: self.element(selector), "field " + selector)
        self.call("POST", f"/element/{element}/clear", {})
        self.call("POST", f"/element/{element}/value", {"text": text})

    def upload(self, path):
        element = self.element('input[type="file"]')
        self.call("POST", f"/element/{element}/value", {"text": str(path)})

    def text(self):
        return self.js("return document.body.innerText")

    def wait_text(self, text):
        until(lambda: text in self.text(), "visible text " + text)

    def image_loaded(self, selector):
        until(lambda: self.js(
            "const e=document.querySelector(arguments[0]);return e && e.naturalWidth>0", selector),
            "loaded image " + selector)

    def shot(self, filename):
        (self.run.output / filename).write_bytes(base64.b64decode(self.call("GET", "/screenshot")))

    def stop_browser(self):
        lock = self.area / "chromium/SingletonLock"
        if lock.is_symlink():
            pid = int(os.readlink(lock).rsplit("-", 1)[1])
            command = Path(f"/proc/{pid}/cmdline")
            try:
                # A stale lock must never cause us to stop an unrelated process.
                if str(self.area / "chromium").encode() in command.read_bytes():
                    os.kill(pid, signal.SIGTERM)
                    until(lambda: not command.exists(), "disposable browser exit", timeout=5)
            except ProcessLookupError:
                pass
            except FileNotFoundError:
                pass


class Run:
    def __init__(self, output):
        self.output = output
        self.children = []
        self.desktops = []
        self.results = {"completed": False}
        self.commands = {}
        for name in ("Xvfb", "tauri-driver", "WebKitWebDriver", "chromium", "dbus-run-session", "pnpm"):
            self.commands[name] = shutil.which(name)
            if not self.commands[name]:
                raise SystemExit("Missing test tool: " + name)

    def launch(self, args, logfile, env=None, cwd=ROOT, **kwargs):
        with logfile.open("w") as log:
            process = subprocess.Popen(args, cwd=cwd, env=env, stdout=log, stderr=log,
                                       start_new_session=True, **kwargs)
        self.children.append(process)
        return process

    def wait_http(self, url, process):
        def ready():
            if process.poll() is not None:
                raise RuntimeError("Test process exited; see logs in " + str(self.output))
            try:
                with urlopen(url, timeout=1):
                    return True
            except (URLError, TimeoutError):
                return False
        until(ready, url)

    def start(self):
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", 1420))
            except OSError as error:
                raise SystemExit("Port 1420 is occupied. Stop the dev server before this check.") from error
        for binary in (ROOT / "target/debug/linger-server",
                       ROOT / "client/src-tauri/target/debug/linger-client"):
            if not binary.is_file():
                raise SystemExit("Build the debug binary first: " + str(binary))
        env = {key: value for key, value in os.environ.items() if not key.startswith("LINGER_")}
        self.origin = f"http://127.0.0.1:{available_port()}"
        env.update(LINGER_BIND=self.origin.removeprefix("http://"),
                   LINGER_DATA_DIR=str(self.output / "server"))
        server = self.launch([str(ROOT / "target/debug/linger-server")], self.output / "server.log", env)
        self.wait_http(self.origin + "/api/v1/health", server)
        # Corepack selects the pinned pnpm from the working directory.
        vite = self.launch([self.commands["pnpm"], "dev", "--host", "127.0.0.1"],
                           self.output / "vite.log", cwd=ROOT / "client")
        self.wait_http("http://127.0.0.1:1420", vite)
        self.alice = Desktop(self, "alice")
        password = secrets.token_urlsafe(24)
        token = re.search(r"/setup\?token=([^\s\x1b]+)", (self.output / "server.log").read_text()).group(1)
        self.alice.fill(".auth-form input", self.origin + "/setup?token=" + token)
        self.alice.button("continue")
        self.alice.wait_text("set up this server")
        for i, value in enumerate(("Porch Check", "alice", "Alice", password), 1):
            self.alice.fill(f".auth-form label:nth-of-type({i}) input", value)
        self.alice.button("set up this server")
        self.alice.wait_text("settings")
        auth = http("POST", self.origin + "/api/v1/auth/login", {"username": "alice", "password": password})
        for name in ("bob", "carol"):
            invite = http("POST", self.origin + "/api/v1/invites", {}, auth["access_token"])
            desktop = Desktop(self, name)
            desktop.fill(".auth-form input", self.origin + "/invite/" + invite["code"])
            desktop.button("continue")
            desktop.wait_text("join")
            for i, value in enumerate((name, name.title(), password), 1):
                desktop.fill(f".auth-form label:nth-of-type({i}) input", value)
            desktop.button("join")
            desktop.wait_text("settings")
            setattr(self, name, desktop)
        self.alice.button("make the first room")
        self.alice.fill(".host-input", "porch")
        self.alice.button("make the room")
        until(lambda: self.alice.element(".room-item"), "new room in the rail")
        self.alice.button("close")
        print("Three real desktop clients registered and connected.", flush=True)

    def export(self, desktop, private):
        desktop.button("settings")
        desktop.button("this computer")
        desktop.button("export everything")
        desktop.wait_text("Your archive is ready.")
        desktop.shot(desktop.area.name + "-export.png")
        before = desktop.js("return location.href")
        desktop.button("download it")
        archive = until(lambda: next((desktop.area / "downloads").glob("*.zip"), None),
                        "native browser archive download", timeout=30)
        assert desktop.js("return location.href") == before
        with zipfile.ZipFile(archive) as zipped:
            assert zipped.testzip() is None
            names = zipped.namelist()
            room = next(name for name in names if name.endswith("/rooms/porch.md"))
            assert "Welcome to the porch." in zipped.read(room).decode()
            direct = [name for name in names if "/direct/" in name]
            assert bool(direct) == private
            if private:
                assert "Lanternsecret:" in zipped.read(direct[0]).decode()
                assert any("lanternsecret.png" in name for name in names)
            else:
                assert not any("lanternsecret" in name.lower() for name in names)
                assert all(b"Lanternsecret:" not in zipped.read(name)
                           for name in names if name.endswith(".md"))
            image_name = next(name for name in names if "/media/" in name and "porch-lamp.png" in name)
            data = zipped.read(image_name)
            assert data[:8] == b"\x89PNG\r\n\x1a\n"
            assert struct.unpack(">II", data[16:24]) == (128, 128)
            (self.output / "exported-image.png").write_bytes(data)
            (self.output / (desktop.area.name + "-room.md")).write_bytes(zipped.read(room))
        desktop.stop_browser()
        desktop.button("export everything")
        desktop.wait_text("You already asked for one recently.")
        desktop.shot(desktop.area.name + "-export-cooldown.png")
        self.results[desktop.area.name + "_export"] = {"downloaded": True, "entries": names,
                                                        "private_conversation": private, "cooldown": True}
        print(desktop.area.name + ": browser download, archive contents and cooldown passed.", flush=True)

    def check(self):
        a, b, c = self.alice, self.bob, self.carol
        public = self.output / "porch-lamp.png"
        shutil.copyfile(ROOT / "client/src-tauri/icons/128x128.png", public)
        a.fill(".composer-input", "Welcome to the porch. This public message belongs in the archive.")
        a.button("send")
        b.wait_text("Welcome to the porch.")
        a.upload(public)
        a.button("send")
        b.image_loaded('.att-image img[alt="porch-lamp.png"]')
        a.button("settings")
        a.button("you")
        a.button("two, blended")
        a.click('[aria-label="from color"] [aria-label="amber"]')
        a.click('[aria-label="to color"] [aria-label="violet"]')
        a.click('//div[contains(@class,"style-row")][span[normalize-space(.)="face"]]'
                '//button[normalize-space(.)="Newsreader"]', "xpath")
        a.button("shimmer")
        a.click(".settings-section:has(.style-preview) .settings-save")
        a.wait_text("saved")
        a.button("close")
        a.fill(".composer-input", "A little color for the porch.")
        a.button("send")
        b.wait_text("A little color for the porch.")
        style = """const e=document.querySelector(arguments[0]);const s=getComputedStyle(e);
          return {font:s.fontFamily,paint:s.backgroundImage,animation:s.animationName};"""
        drawn = b.js(style, ".msg-author")
        assert "Newsreader" in drawn["font"] and drawn["animation"] == "name-shimmer"
        self.results["styled_name"] = drawn
        for theme in ("light", "dark"):
            b.button("settings"); b.button("reading"); b.button(theme); b.button("close")
            b.shot("styled-" + theme + ".png")
        b.button("settings"); b.button("reading"); b.button("normalize everyone"); b.button("close")
        normalized = b.js(style, ".msg-author")
        assert normalized["animation"] == "none" and normalized["paint"] == "none"
        assert "Newsreader" not in normalized["font"]
        b.shot("normalized-dark.png")
        b.button("settings"); b.button("reading"); b.button("names normalized")
        for density, selector in (("compact", ".msg-author"), ("irc", ".irc-name")):
            b.button(density); b.button("close")
            assert b.js(style, selector)["animation"] == "none"
            b.shot(density + "-dark.png")
            b.button("settings"); b.button("reading")
        b.button("comfortable")
        # Only the test WebView's hour changes. No system clock or server time changes.
        b.js("window.checkHours=Date.prototype.getHours;Date.prototype.getHours=function(){return 20;}")
        try:
            b.button("evening warmth on"); b.button("evening warmth off"); b.button("close")
            assert b.js("return document.documentElement.dataset.warmth") == "warm"
            b.shot("evening-dark.png")
        finally:
            b.js("Date.prototype.getHours=window.checkHours;delete window.checkHours")
        self.results["reading"] = {"normalized": True, "compact": True, "irc": True, "controlled_evening": True}
        print("Live styling, themes, normalization, densities and evening warmth passed.", flush=True)

        a.click('//button[contains(@class,"person-head")][.//span[normalize-space(.)="Bob"]]', "xpath")
        a.button("message")
        a.fill(".composer-input", "Lanternsecret: this conversation is just for us.")
        a.button("send")
        b.click('//button[contains(@class,"room-item")][.//span[normalize-space(.)="Alice"]]', "xpath")
        b.wait_text("Lanternsecret:")
        b.fill(".composer-input", "Just us. The message arrived."); b.button("send")
        a.wait_text("Just us. The message arrived.")
        private = self.output / "lanternsecret.png"
        shutil.copyfile(public, private)
        a.upload(private); a.button("send")
        b.image_loaded('.att-image img[alt="lanternsecret.png"]')
        b.shot("private-conversation.png")
        assert "Lanternsecret:" not in c.text()
        assert not c.js('return [...document.querySelectorAll(".room-item")].some(e=>e.innerText.trim()==="Alice" || e.innerText.trim()==="Bob")')
        presence = c.js('return [...document.querySelectorAll(".person")].find(e=>e.innerText.includes("Alice")).innerText')
        assert "in a message with" not in presence
        # Keep the remaining HC-7 presentation mismatch visible in the evidence.
        self.results["outsider_presence"] = presence.strip()
        c.button("media"); c.wait_text("porch-lamp.png")
        assert "lanternsecret.png" not in c.text()
        c.image_loaded(".media-face img"); c.shot("outsider-media.png")
        b.button("media"); b.wait_text("lanternsecret.png")
        b.image_loaded(".media-face img"); b.shot("member-media.png")
        c.button("search"); c.fill('input[type="search"]', "lanternsecret")
        c.wait_text("Nothing here matches that."); c.shot("outsider-search.png")
        self.results["dm"] = {"live_exchange": True, "private_image": True,
                              "outsider_room_list": "absent", "outsider_media": "absent", "outsider_search": "absent"}
        self.export(b, private=True)
        self.export(c, private=False)

    def close(self):
        for desktop in reversed(self.desktops):
            desktop.stop_browser()
            try:
                desktop.call("DELETE", "")
            except (OSError, RuntimeError):
                pass
        for process in reversed(self.children):
            # The process group also owns D-Bus-activated helpers and webviews.
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        for process in reversed(self.children):
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="new directory for screenshots, logs and disposable data")
    args = parser.parse_args()
    if args.output:
        output = args.output.resolve()
        output.mkdir(mode=0o700, parents=True, exist_ok=False)
    else:
        output = Path(tempfile.mkdtemp(prefix="linger-desktop-"))
    run = Run(output)
    print("Evidence directory: " + str(output), flush=True)
    try:
        run.start()
        run.check()
        run.results["completed"] = True
    finally:
        (output / "results.json").write_text(json.dumps(run.results, indent=2) + "\n")
        run.close()


if __name__ == "__main__":
    main()
