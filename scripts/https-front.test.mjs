// scripts/https-front.mjs and scripts/test-certs.sh, run here: they run for
// real only on a CI Mac, in front of the server the iPhone Simulator signs in
// to (.github/workflows/ios-simulator.yml). A request, a body, the headers
// both ways, a WebSocket upgrade with bytes either way, a server that isn't
// there, and certificates the iPhone and rustls would take.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { connect as connectTls } from "node:tls";
import { fileURLToPath } from "node:url";
import { startFront } from "./https-front.mjs";

const script = fileURLToPath(new URL("./https-front.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "https-front-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
execFileSync("bash", [fileURLToPath(new URL("./test-certs.sh", import.meta.url)), dir], { stdio: "ignore" });
const ca = readFileSync(join(dir, "ca.pem"));
const cert = readFileSync(join(dir, "cert.pem"));
const key = readFileSync(join(dir, "key.pem"));

/** A stand-in Linger server: says what it was asked, and echoes a WebSocket's bytes. */
async function stubServer(t) {
  const seen = [];
  const server = createServer((incoming, outgoing) => {
    let body = "";
    incoming.on("data", (chunk) => (body += chunk));
    incoming.on("end", () => {
      seen.push({ method: incoming.method, url: incoming.url, headers: incoming.headers, body });
      outgoing.writeHead(201, { "content-type": "application/json", etag: '"part-1"' });
      outgoing.end(JSON.stringify({ method: incoming.method, url: incoming.url, body }));
    });
  });
  server.on("upgrade", (incoming, socket, head) => {
    // What arrives after the request, whether Node hands it over with the
    // request (`head`) or after it.
    const upgrade = { upgrade: incoming.url, headers: incoming.headers, received: head.toString() };
    seen.push(upgrade);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (chunk) => {
      upgrade.received += chunk;
      socket.write(`echo:${chunk}`);
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => shut(server));
  return { port: server.address().port, seen };
}

/** Stops a server and drops its connections, upgraded ones too, without waiting on any. */
function shut(server) {
  server.closeAllConnections?.();
  server.close();
  server.unref();
}

/** Every socket a test opens, for the end of the file to close. */
const sockets = [];
process.on("beforeExit", () => sockets.forEach((socket) => socket.destroy()));

async function front(t, serverPort, log) {
  const listening = await startFront({ cert, key, port: 0, serverPort, log });
  listening.on("connection", (socket) => sockets.push(socket));
  listening.on("secureConnection", (socket) => sockets.push(socket));
  t.after(() => {
    sockets.forEach((socket) => socket.destroy());
    shut(listening);
  });
  return listening.address().port;
}

/** One https request through the front, trusting the test authority. */
function ask(port, { method = "GET", path = "/", headers = {}, body, trust = ca } = {}) {
  return new Promise((done, fail) => {
    const outgoing = request({ host: "127.0.0.1", port, method, path, headers, ca: trust ?? undefined, agent: false }, (answer) => {
      let text = "";
      answer.on("data", (chunk) => (text += chunk));
      answer.on("end", () => done({ status: answer.statusCode, headers: answer.headers, text }));
    });
    outgoing.on("error", fail);
    outgoing.end(body);
  });
}

/** The front's log, and a wait (by the clock) for a line in it. */
function logged() {
  const lines = [];
  const log = (line) => lines.push(line);
  const line = async (pattern) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const found = lines.find((each) => pattern.test(each));
      if (found) return found;
      await new Promise((done) => setTimeout(done, 20));
    }
    throw new Error(`no line like ${pattern} in ${JSON.stringify(lines)}`);
  };
  return { lines, log, line };
}

/** Everything that arrives on a socket until `until` matches it. */
function readUntil(socket, until) {
  return new Promise((done, fail) => {
    let got = "";
    const timer = setTimeout(() => fail(new Error(`waited for ${until}, got ${JSON.stringify(got)}`)), 5000);
    socket.on("data", (chunk) => {
      got += chunk;
      if (until.test(got)) {
        clearTimeout(timer);
        done(got);
      }
    });
    socket.on("close", () => {
      clearTimeout(timer);
      done(got);
    });
  });
}

test("the certificate is one the iPhone and rustls take for 127.0.0.1 and localhost", () => {
  const authority = new X509Certificate(ca);
  const server = new X509Certificate(cert);
  assert.equal(authority.ca, true, "the authority is marked as one");
  assert.equal(server.ca, false, "the server's certificate isn't");
  assert.ok(server.checkIssued(authority) && server.verify(authority.publicKey), "signed by the authority");
  assert.match(server.subjectAltName ?? "", /IP Address:127\.0\.0\.1/);
  assert.match(server.subjectAltName ?? "", /DNS:localhost/);
  // id-kp-serverAuth: iOS refuses a server certificate without it.
  assert.ok(server.keyUsage?.includes("1.3.6.1.5.5.7.3.1"), `extended key usage: ${server.keyUsage}`);
  const days = (Date.parse(server.validTo) - Date.parse(server.validFrom)) / 86_400_000;
  assert.ok(days > 0 && days <= 825, `valid for ${days} days; iOS takes at most 825`);
  assert.ok(!readFileSync(join(dir, "ca.pem"), "utf8").includes("PRIVATE KEY"));
});

test("a request and its body reach the server, and its answer and headers come back", async (t) => {
  const server = await stubServer(t);
  const port = await front(t, server.port);
  const answer = await ask(port, {
    method: "POST",
    path: "/api/v1/setup?x=1",
    headers: { "content-type": "application/json", authorization: "Bearer test", origin: "tauri://localhost" },
    body: JSON.stringify({ token: "abc" }),
  });
  assert.equal(answer.status, 201);
  assert.equal(answer.headers.etag, '"part-1"');
  assert.deepEqual(JSON.parse(answer.text), { method: "POST", url: "/api/v1/setup?x=1", body: '{"token":"abc"}' });
  assert.equal(server.seen[0].headers.authorization, "Bearer test");
  assert.equal(server.seen[0].headers.origin, "tauri://localhost");
  assert.equal(server.seen[0].headers.host, `127.0.0.1:${port}`, "the Host the app asked for, as a real proxy keeps it");
});

test("a client that doesn't trust the authority is refused, and the log says the handshake failed", async (t) => {
  const server = await stubServer(t);
  const { log, line } = logged();
  const port = await front(t, server.port, log);
  await assert.rejects(ask(port, { trust: null }), /self[- ]signed|unable to (verify|get)/i);
  assert.deepEqual(server.seen, []);
  await line(/^a TLS handshake failed: \S/);
  await line(/^connection from :\d+ closed after \d+ ms, its TLS handshake never finished$/);
});

test("the log follows a request from its connection to its answer, naming its path but never its query", async (t) => {
  const server = await stubServer(t);
  const { lines, log, line } = logged();
  const port = await front(t, server.port, log);
  await ask(port, { path: "/api/v1/setup?token=0123secret" });
  const answered = await line(/^GET \/api\/v1\/setup from :\d+: 201 in \d+ ms$/);
  const from = /from (:\d+)/.exec(answered)[1];
  assert.ok(lines.includes(`connection from ${from}`), "the connection, by the same port");
  assert.ok(lines.includes(`TLS done with ${from}`), "its handshake, by the same port");
  await line(new RegExp(`^connection from ${from} closed after \\d+ ms$`));
  assert.ok(!lines.some((each) => each.includes("0123secret")), "the query never");
});

test("a request the app gives up on before the server answers is logged as that", async (t) => {
  // A server that takes the request and never answers it.
  const held = createServer(() => {});
  await new Promise((done) => held.listen(0, "127.0.0.1", done));
  t.after(() => shut(held));
  const { log, line } = logged();
  const port = await front(t, held.address().port, log);
  const outgoing = request({ host: "127.0.0.1", port, path: "/api/v1/setup?token=0123", ca, agent: false });
  outgoing.on("error", () => undefined);
  outgoing.end();
  await line(/^TLS done with :\d+$/);
  setTimeout(() => outgoing.destroy(), 200);
  await line(/^GET \/api\/v1\/setup from :\d+: the app went away unanswered after \d+ ms$/);
});

test("a WebSocket upgrade goes through, with bytes either way, the first ones sent with it", async (t) => {
  const server = await stubServer(t);
  const port = await front(t, server.port);
  const socket = connectTls({ host: "127.0.0.1", port, ca });
  t.after(() => socket.destroy());
  await new Promise((done, fail) => socket.once("secureConnect", done).once("error", fail));
  socket.write(
    [`GET /api/v1/gateway HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Version: 13", "", "early"].join("\r\n"),
  );
  const answered = await readUntil(socket, /\r\n\r\n/);
  assert.match(answered, /^HTTP\/1\.1 101 /);
  socket.write("hello");
  assert.match(await readUntil(socket, /echo:hello/), /echo:hello/);
  const upgrade = server.seen.find((seen) => seen.upgrade);
  assert.equal(upgrade.upgrade, "/api/v1/gateway");
  assert.equal(upgrade.headers.upgrade, "websocket");
  // "early" came in the same write as the request, so the front got it as
  // the upgrade's `head`; it reaches the server, before what came after.
  assert.equal(upgrade.received, "earlyhello");
});

test("with no server behind it, a request is a 502 and an upgrade is closed", async (t) => {
  const gone = createServer();
  await new Promise((done) => gone.listen(0, "127.0.0.1", done));
  const deadPort = gone.address().port;
  await new Promise((done) => gone.close(done));
  const { log, line } = logged();
  const port = await front(t, deadPort, log);
  const answer = await ask(port);
  assert.equal(answer.status, 502);
  await line(/^GET \/ from :\d+: 502 \(the server didn't answer: ECONNREFUSED\) in \d+ ms$/);
  const socket = connectTls({ host: "127.0.0.1", port, ca });
  t.after(() => socket.destroy());
  await new Promise((done, fail) => socket.once("secureConnect", done).once("error", fail));
  socket.write(`GET /api/v1/gateway HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
  assert.equal(await readUntil(socket, /HTTP/), "");
  await line(/^GET \/api\/v1\/gateway from :\d+, an upgrade: the server didn't answer: ECONNREFUSED$/);
});

test("it listens on this machine only", async (t) => {
  const server = await stubServer(t);
  const listening = await startFront({ cert, key, port: 0, serverPort: server.port });
  t.after(() => shut(listening));
  assert.equal(listening.address().address, "127.0.0.1");
});

test("run as a script, it says the port it listens on", async (t) => {
  const server = await stubServer(t);
  const child = spawn(process.execPath, [script, join(dir, "cert.pem"), join(dir, "key.pem"), "0", String(server.port)]);
  t.after(() => child.kill());
  let said = "";
  child.stdout.on("data", (chunk) => (said += chunk));
  const deadline = Date.now() + 5000;
  while (!/^listening \d+\n/m.test(said) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
  const port = Number(/^listening (\d+)$/m.exec(said)[1]);
  assert.equal((await ask(port)).status, 201);
  // Each line after it starts with the time, as the simulator's log does.
  while (!/: 201 in /.test(said) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
  const after = said.split("\n").filter((each) => each && !each.startsWith("listening"));
  assert.ok(after.length >= 3, said);
  for (const each of after) assert.match(each, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z (connection|TLS done|GET \/ from)/);
});

test("run as a script with something missing, it says how to run it", () => {
  assert.throws(() => execFileSync(process.execPath, [script, "cert.pem"], { stdio: "pipe" }), (error) => error.status === 2 && /usage:/.test(error.stderr));
});
