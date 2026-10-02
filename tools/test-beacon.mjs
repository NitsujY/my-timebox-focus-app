#!/usr/bin/env node
// Beacon tester — mimics the relay (tools/timebox-relay.mjs) so you can test
// the ESP32 without the app or relay running. See docs/firmware-v2.md.
//
//   node tools/test-beacon.mjs 25 "Fix VPN"   # broadcast a 25-min timer every 2s
//   node tools/test-beacon.mjs 0 "Fix VPN"    # end=now → device shows overtime +0:00
//
// While running it also listens on the event port (4241) and prints anything
// the device sends back (extend / logstop), like the relay would.
// Ctrl+C stops — the device returns to idle ~8s after the last beacon.
import dgram from "node:dgram";

const minutes = parseFloat(process.argv[2] ?? "25");
const title = process.argv[3] ?? "Test task";
const session = `test-${Date.now()}`;
const end = Math.floor(Date.now() / 1000) + Math.round(minutes * 60);

const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
sock.on("listening", () => {
  sock.setBroadcast(true);
  console.log(
    `beaconing "${title}" s=${session} end=${end} (${minutes}m) → 255.255.255.255:4242 every 2s`,
  );
  console.log(`listening for device events on :4241 — Ctrl+C to stop`);
});
sock.on("message", (msg, rinfo) => {
  const s = msg.toString();
  if (s.startsWith("TB1 ")) console.log(`[device ${rinfo.address}] ${s}`);
});
sock.bind(4241, () => {
  // DEVICE=<ip> → unicast straight at the device (for networks that block
  // broadcast). Otherwise subnet/global broadcast.
  const targets = process.env.DEVICE
    ? [process.env.DEVICE]
    : [process.env.BCAST, "255.255.255.255"].filter(Boolean);
  const send = () => {
    const pkt = Buffer.from(
      `TB1 s=${session} id=demo-test end=${end} min=${minutes} t=${title}`,
    );
    for (const t of targets) {
      sock.send(pkt, 4242, t, (err) => {
        if (err) console.log(`[send ${t}] ${err.message}`);
      });
    }
    console.log(`[tx] ${pkt.toString()} → ${targets.join(", ")}`);
  };
  send();
  setInterval(send, 2000);
});
