#!/usr/bin/env node
// Timebox device relay — see docs/firmware-v2.md.
// app → POST/DELETE http://127.0.0.1:8787/state → UDP broadcast beacons → ESP32
// app ← GET  http://127.0.0.1:8787/events      ← UDP events ← ESP32
// Zero dependencies: node tools/timebox-relay.mjs   (or: npm run relay)
import http from "node:http";
import dgram from "node:dgram";

const HTTP_PORT = 8787;
const BEACON_PORT = 4242; // relay → device
const EVENT_PORT = 4241; // device → relay
const BEACON_MS = 2000;
const STATE_TTL_MS = 30_000; // app heartbeats every 10s; crash/close stops beacons

let state = null; // { session, id, title, minutes, end }
let lastPostAt = 0;
const events = []; // drained by GET /events

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-allow-private-network": "true", // PNA: https page → 127.0.0.1
};

http
  .createServer((req, res) => {
    for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/state" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          state = JSON.parse(body);
          lastPostAt = Date.now();
        } catch {
          /* keep previous state */
        }
        res.end("ok");
      });
    } else if (path === "/state" && req.method === "DELETE") {
      if (state) { sendBye(state.session); byePending = state.session; }
      state = null;
      res.end("ok");
    } else if (path === "/events" && req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(events.splice(0)));
    } else if (path === "/health") {
      res.end("ok");
    } else {
      res.writeHead(404).end();
    }
  })
  .listen(HTTP_PORT, "127.0.0.1", () =>
    console.log(`[relay] http on 127.0.0.1:${HTTP_PORT}`),
  );

// ponytail: send both limited (255.255.255.255) and directed subnet broadcast.
// On multi-interface/VPN Macs the limited broadcast can be bound to the wrong
// interface; the directed /16 broadcast (from en0's netmask) always lands on
// the LAN. ESP32 answers either.
import os from "node:os";
function subnetBroadcasts() {
  const out = new Set(["255.255.255.255"]);
  for (const addrs of Object.values(os.networkInterfaces()))
    for (const a of addrs ?? [])
      if (a.family === "IPv4" && !a.internal && a.netmask && a.address) {
        const ip = a.address.split(".").map(Number);
        const m = a.netmask.split(".").map(Number);
        out.add(ip.map((o, i) => o | (~m[i] & 255)).join("."));
      }
  return [...out];
}
const BCASTS = subnetBroadcasts();

// Explicit "session over" packet so the device reacts in ms instead of the
// 8s beacon-timeout. DELETE is fire-and-forget from the app and mDNS may not
// have resolved yet, so queue until deviceIP is known (or the device moves on).
let byePending = null;
const sendBye = (session) => {
  const pkt = Buffer.from(`TB1 s=${session} bye=1`);
  if (deviceIP) sock.send(pkt, BEACON_PORT, deviceIP);
  for (const t of BCASTS) sock.send(pkt, BEACON_PORT, t);
};

const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
sock.on("listening", () => {
  sock.setBroadcast(true);
  console.log(`[relay] beacons → ${BCASTS.join(",")}:${BEACON_PORT}, events ← :${EVENT_PORT}`);
});
sock.on("message", (msg) => {
  const s = msg.toString();
  if (!s.startsWith("TB1 ")) return;
  const m = Object.fromEntries(
    [...s.slice(4).matchAll(/(\w+)=(\S+)/g)].map((x) => [x[1], x[2]]),
  );
  if (m.extend != null) {
    events.push({ type: "extend", minutes: Math.round(+m.extend / 60), session: m.s });
    console.log(`[relay] device extend +${Math.round(+m.extend / 60)}m`);
  } else if (m.logstop != null) {
    events.push({ type: "logstop", session: m.s });
    console.log(`[relay] device log & stop`);
  } else if (m.complete != null) {
    events.push({ type: "complete", session: m.s });
    console.log(`[relay] device mark complete`);
  }
});
sock.bind(EVENT_PORT);

// ---- device discovery via mDNS (timebox.local) → unicast beacons ----
// The VPN hijacks the limited broadcast (255.255.255.255 → utun5), but the
// subnet route (172.29 → en0) still wins for outgoing unicast — so once we know
// the device's IP we can unicast beacons straight to it, VPN or not.
// Discovery: the ESP32 advertises "timebox.local" via ESPmDNS. We resolve it
// with the OS resolver (dns.lookup → mDNSResponder), NOT a raw 5353 socket —
// macOS's own mDNSResponder owns that port and would eat a hand-rolled query.
import dns from "node:dns";
let deviceIP = null;
async function rediscover() {
  try {
    const { address } = await dns.promises.lookup("timebox.local", { family: 4 });
    if (address !== deviceIP) {
      deviceIP = address;
      console.log(`[relay] discovered timebox.local → ${address} (unicast beacons)`);
    }
    if (byePending) { sendBye(byePending); byePending = null; console.log(`[relay] bye → ${address}`); }
  } catch {
    if (deviceIP) { console.log(`[relay] lost timebox.local — broadcast only`); deviceIP = null; }
  }
}
setInterval(rediscover, 10_000);
setTimeout(rediscover, 1000);

setInterval(() => {
  if (state && Date.now() - lastPostAt > STATE_TTL_MS) {
    // app died without a DELETE — retire it so the device gets the fast bye
    sendBye(state.session);
    byePending = state.session;
    state = null;
  }
  if (!state) return;
  const title = String(state.title ?? "").replace(/\s+/g, " ").slice(0, 60);
  const pkt = Buffer.from(
    `TB1 s=${state.session} id=${state.id} end=${Math.floor(state.end / 1000)} min=${state.minutes} t=${title}`,
  );
  if (deviceIP) sock.send(pkt, BEACON_PORT, deviceIP); // unicast once discovered
  for (const t of BCASTS) sock.send(pkt, BEACON_PORT, t); // always broadcast too (cold start)
}, BEACON_MS);
