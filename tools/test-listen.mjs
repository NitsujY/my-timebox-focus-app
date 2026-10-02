#!/usr/bin/env node
// ESP32 simulator — listens on the beacon port (4242) exactly like the
// firmware does and prints every beacon with computed remaining time.
// Use it to verify the real relay (npm run relay) emits valid beacons,
// without needing the device powered on.
//
//   node tools/test-listen.mjs
import dgram from "node:dgram";

const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
sock.on("listening", () => {
  console.log("listening on :4242 (same as the ESP32) — start a timer in the app");
  console.log("(relay must be running: npm run relay)\n");
});
sock.on("message", (msg, rinfo) => {
  const s = msg.toString();
  if (!s.startsWith("TB1 ")) return;
  const m = Object.fromEntries(
    [...s.slice(4).matchAll(/(\w+)=(\S+)/g)].map((x) => [x[1], x[2]]),
  );
  const t = s.includes(" t=") ? s.slice(s.indexOf(" t=") + 3) : "";
  const left = +m.end - Math.floor(Date.now() / 1000);
  const mmss = `${String(Math.floor(Math.abs(left) / 60)).padStart(2, "0")}:${String(Math.abs(left) % 60).padStart(2, "0")}`;
  console.log(
    `[${rinfo.address}] s=${m.s} id=${m.id} ${left >= 0 ? mmss : "+" + mmss} left (${m.min}m planned) — ${t}`,
  );
});
sock.bind(4242);
