#!/usr/bin/env node
// Device tester — drives the ESP32 over HTTP exactly like the app
// (src/deviceBeacon.ts), so you can test without the app running.
// See docs/firmware-v2.md.
//
//   node tools/test-beacon.mjs 25 "Fix VPN"   # start a 25-min timer, heartbeat every 10s
//   node tools/test-beacon.mjs 0 "Fix VPN"    # end=now → device shows overtime +0:00
//
// While running it also polls the device's GET /events and prints anything the
// touchscreen sends back (extend / logstop / complete), like the app would.
// Ctrl+C stops — the device returns to idle ~25s after the last heartbeat.
const DEVICE = process.env.TIMEBOX_URL ?? "http://timebox.local:4242";

const minutes = parseFloat(process.argv[2] ?? "25");
const title = process.argv[3] ?? "Test task";
const session = `test-${Date.now()}`;
const endMs = Date.now() + Math.round(minutes * 60 * 1000);

const post = (path, body) =>
  fetch(DEVICE + path, {
    method: body ? "POST" : "DELETE",
    ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  }).then((r) => r.text()).catch((e) => `(unreachable: ${e.cause?.code ?? e.message})`);

console.log(`driving ${DEVICE} — "${title}" s=${session} (${minutes}m), Ctrl+C to stop`);
console.log(await post("/state", { session, id: "test", title, minutes, end: endMs }));

const hb = setInterval(async () => {
  console.log("hb:", await post("/state", { session, id: "test", title, minutes, end: endMs }));
  const evs = await fetch(DEVICE + "/events").then((r) => r.json()).catch(() => []);
  for (const e of evs) console.log("[device]", e);
}, 10_000);

process.on("SIGINT", async () => {
  clearInterval(hb);
  console.log("bye:", await post("/state"));
  process.exit(0);
});
