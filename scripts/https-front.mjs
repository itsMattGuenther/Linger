// An https front for a Linger server on this machine, for the iPhone
// Simulator check (.github/workflows/ios-simulator.yml).
//
// The installed app talks to servers over https and wss only: its CSP
// (tauri.conf.json) allows no plain http, and the server says as much when
// it prints a setup link with no domain. A real server has Caddy in front
// for that (deploy/). On a CI Mac this stands in for Caddy: TLS with a
// certificate from scripts/test-certs.sh, every request passed through to
// the server as it came, and a WebSocket upgrade (the gateway) piped through
// both ways once the server has answered it.
//
// Usage: node scripts/https-front.mjs <cert.pem> <key.pem> <listen-port> <server-port>
// It listens on 127.0.0.1 only, and prints "listening <port>" when it does,
// then a line for each connection, handshake and request, each starting with
// the time (#848).
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:https";
import { connect } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";

/** The request's headers as they came, in order, case and repeats kept. */
function headerLines(rawHeaders) {
  const lines = [];
  for (let at = 0; at < rawHeaders.length; at += 2) lines.push(`${rawHeaders[at]}: ${rawHeaders[at + 1]}`);
  return lines;
}

/**
 * Headers as they came, less the ones about this one connection, which each
 * side of the front has its own of (RFC 9110 §7.6.1).
 */
function endToEnd(rawHeaders) {
  const kept = [];
  for (let at = 0; at < rawHeaders.length; at += 2) {
    if (!/^(connection|keep-alive|proxy-connection)$/i.test(rawHeaders[at])) kept.push(rawHeaders[at], rawHeaders[at + 1]);
  }
  return kept;
}

/**
 * A request as the log names it: its method and path, never the query, which
 * can carry a setup token.
 */
export function named(method, url) {
  return `${method} ${String(url ?? "").split("?")[0]}`;
}

/**
 * Starts the front. Resolves with the server once it listens; `address().port`
 * is the port, which is the one asked for unless that was 0.
 *
 * `log` hears each connection, each TLS handshake done or failed, and each
 * request with how it ended and how long it took, each naming the app's end
 * of the connection (`:port`), so a request that never comes back says how
 * far it got (#848).
 */
export function startFront({ cert, key, port, serverPort, log = () => {} }) {
  const front = createServer({ cert, key }, (incoming, outgoing) => {
    const started = Date.now();
    const what = `${named(incoming.method, incoming.url)} from :${incoming.socket.remotePort}`;
    let why = "";
    outgoing.on("close", () => {
      const took = `${Date.now() - started} ms`;
      if (outgoing.writableFinished) log(`${what}: ${outgoing.statusCode}${why} in ${took}`);
      else log(`${what}: the app went away unanswered after ${took}`);
    });
    // A connection of its own for each request (`agent: false`), closed when
    // it's answered: nothing is left open behind a request that's done.
    const upstream = request(
      { host: HOST, port: serverPort, method: incoming.method, path: incoming.url, headers: endToEnd(incoming.rawHeaders), agent: false },
      (answer) => {
        outgoing.writeHead(answer.statusCode ?? 502, endToEnd(answer.rawHeaders));
        answer.pipe(outgoing);
      },
    );
    upstream.on("error", (error) => {
      why = ` (the server didn't answer: ${error.code ?? error.message})`;
      if (!outgoing.headersSent) outgoing.writeHead(502, { "content-type": "text/plain" });
      outgoing.end("the server behind the front didn't answer\n");
    });
    incoming.pipe(upstream);
  });
  // Each connection by the app's end of it, and whether its handshake
  // finished. A failed handshake's socket no longer knows its port, so its
  // connection's closing line says it never finished.
  const handshakes = new Map();
  front.on("connection", (socket) => {
    const from = `:${socket.remotePort}`;
    const opened = Date.now();
    handshakes.set(from, false);
    log(`connection from ${from}`);
    socket.on("close", () => {
      const finished = handshakes.get(from);
      handshakes.delete(from);
      log(`connection from ${from} closed after ${Date.now() - opened} ms${finished ? "" : ", its TLS handshake never finished"}`);
    });
  });
  front.on("secureConnection", (socket) => {
    handshakes.set(`:${socket.remotePort}`, true);
    log(`TLS done with :${socket.remotePort}`);
  });
  front.on("tlsClientError", (error) => log(`a TLS handshake failed: ${error.code ?? error.message}`));

  // A WebSocket: the request goes to the server as it came, and from then on
  // the bytes go both ways untouched, the server's 101 first.
  front.on("upgrade", (incoming, socket, head) => {
    const what = `${named(incoming.method, incoming.url)} from :${socket.remotePort}, an upgrade`;
    log(what);
    const upstream = connect(serverPort, HOST, () => {
      upstream.write([`${incoming.method} ${incoming.url} HTTP/1.1`, ...headerLines(incoming.rawHeaders), "", ""].join("\r\n"));
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", (error) => {
      log(`${what}: the server didn't answer: ${error.code ?? error.message}`);
      socket.destroy();
    });
    socket.on("error", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
  });

  return new Promise((done, fail) => {
    front.once("error", fail);
    front.listen(port, HOST, () => done(front));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [certPath, keyPath, port, serverPort] = process.argv.slice(2);
  if (!certPath || !keyPath || !/^\d+$/.test(port ?? "") || !/^\d+$/.test(serverPort ?? "")) {
    console.error("usage: node scripts/https-front.mjs <cert.pem> <key.pem> <listen-port> <server-port>");
    process.exit(2);
  }
  const front = await startFront({
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
    port: Number(port),
    serverPort: Number(serverPort),
    // The time as the simulator's log writes it (UTC on a CI Mac), to set the two side by side.
    log: (line) => console.log(`${new Date().toISOString()} ${line}`),
  });
  console.log(`listening ${front.address().port}`);
}
