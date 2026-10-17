// USB-serial bridge to the ESP32 companion display — see docs/firmware-v2.md.
// The app drives the device over Web Serial (one JSON object per line,
// 115200 baud). No relay, no LAN, and no radios on the device — BLE + WiFi
// starved IRAM/heap and made the display flicker; the cable replaced them.
// Web Serial is a permissioned browser API, so it works from the HTTPS deploy
// (todolist-md.com). Chrome/Edge only (Safari/Firefox have no Web Serial).
//
// Fire-and-forget: if the device is unplugged or the user never picks its
// port in the browser dialog, the timer behaves exactly as before and the
// display just stays idle. The whole bridge is inert while disabled
// (Settings → ESP32 companion display).

export type DeviceEvent = { type: "extend" | "logstop" | "complete"; minutes?: number; session?: string };

// Minimal Web Serial typings.
interface SerialPortLike {
  open(o: { baudRate: number }): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}

const nav2 = navigator as Navigator & {
  serial?: {
    requestPort(o?: { filters: { usbVendorId: number }[] }): Promise<SerialPortLike>;
    getPorts(): Promise<SerialPortLike[]>;
    addEventListener(type: "connect", listener: () => void): void;
  };
};

let enabled = false;
let session = "";
let current: { id: string; title: string; minutes: number } | null = null;
let paused = false; // mirrors the app's pause; rides every state line so the 10s heartbeat can't thaw the device

let port: SerialPortLike | null = null;
let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
let connecting: Promise<void> | null = null;
const eventQueue: DeviceEvent[] = []; // drained by deviceEvents()

const enc = new TextEncoder();

export function deviceSerialSupported(): boolean {
  return !!nav2.serial;
}

// After the one-time grant, Chrome fires "connect" for a replugged granted
// port with no gesture needed — reconnect silently in the background.
nav2.serial?.addEventListener("connect", () => { if (enabled) void ensure(false); });

// device → app: the firmware logs freely; only "EVT <name>" lines are events.
async function readLoop(p: SerialPortLike, r: ReadableStreamDefaultReader<Uint8Array>) {
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await r.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line === "EVT extend") eventQueue.push({ type: "extend", minutes: 5, session });
        else if (line === "EVT logstop") eventQueue.push({ type: "logstop", session });
        else if (line === "EVT complete") eventQueue.push({ type: "complete", session });
      }
    }
  } catch {
    // unplugged mid-read — the next write reconnects
  } finally {
    r.releaseLock();
    if (port === p) { port = null; writer = null; }
  }
}

// Open the port and push the time — the device may have no NTP if WiFi is
// down; we are its backup clock. allowPicker: only deviceSetEnabled(true)
// (the Settings toggle's click) may pop the port dialog, and only once per
// origin; every other path silently uses a previously-granted port or fails
// quietly — requestPort() outside a user gesture would throw anyway.
async function ensure(allowPicker: boolean): Promise<boolean> {
  if (!enabled || !deviceSerialSupported()) return false;
  if (port && writer) return true;
  if (connecting) return connecting.then(() => !!(port && writer));
  connecting = (async () => {
    try {
      const granted = await nav2.serial!.getPorts();
      port = granted[0] ?? (allowPicker
        ? await nav2.serial!.requestPort({ filters: [{ usbVendorId: 0x1a86 }] }) // CH343 (WCH)
        : null);
      if (!port) return;
      await port.open({ baudRate: 115200 });
      writer = port.writable!.getWriter();
      void readLoop(port, port.readable!.getReader());
      await write({ time: Math.floor(Date.now() / 1000) });
    } catch {
      // user cancelled the picker, device unplugged, etc. — fine
      port = null; writer = null;
    } finally {
      connecting = null;
    }
  })();
  return connecting.then(() => !!(port && writer));
}

async function write(body: object): Promise<void> {
  if (!writer) return;
  try {
    await writer.write(enc.encode(JSON.stringify(body) + "\n"));
  } catch {
    port = null; writer = null; // dropped mid-write; reconnect next time
  }
}

// State lines carry `time` too — keeps the device clock honest against drift.
// The bare {} stop line is exempt: {} must stay empty so the device reads it
// as "session over" instead of a clock sync.
async function writeState(body: object): Promise<void> {
  if (!(await ensure(false))) return; // never pop the picker from timer paths
  await write(Object.keys(body).length ? { time: Math.floor(Date.now() / 1000), ...body } : body);
}

export function deviceSetEnabled(on: boolean) {
  enabled = on;
  if (!on) { deviceStop(); return; }
  // The one and only picker: App.tsx calls this from an effect, but the
  // Settings toggle's click leaves transient activation active (~5s), so the
  // picker is allowed. On plain page load there is no activation — skip the
  // picker (it would throw) and just reconnect a granted port silently.
  const gestured = !!(navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive;
  void ensure(gestured);
}

export function deviceStart(task: { id: string; content: string }, minutes: number, endMs: number) {
  if (!enabled) return;
  session = `${Date.now()}`;
  paused = false;
  current = { id: task.id, title: task.content, minutes };
  void writeState({ session, ...current, end: endMs });
}

// heartbeat + extend share this: re-post the current wall-clock end
export function deviceUpdate(endMs: number) {
  if (!enabled || !session || !current) return;
  void writeState({ session, ...current, end: endMs, ...(paused ? { paused: true } : {}) });
}

// pause freezes the device's digits at (end − now); resume sends the
// already-shifted end and clears the flag
export function deviceSetPaused(on: boolean, endMs: number) {
  paused = on;
  deviceUpdate(endMs);
}

export function deviceStop() {
  if (!session) return;
  session = "";
  current = null;
  paused = false;
  // reconnect without the picker: if the original connect died (or the user
  // cancelled the picker), a previously-granted port still lets the {} land;
  // nothing granted → fail quietly and the device's heartbeat timeout takes
  // the display back to idle on its own.
  void ensure(false).then(() => write({})); // {} = session over
}

// push device-config prefs (screen-off timeout etc.) — the device applies +
// persists them (docs/firmware-v2.md)
export function deviceConfig(screenOffMin: number) {
  if (!enabled) return;
  void (async () => {
    if (await ensure(false)) await write({ screenOffMin });
  })();
}

// Events arrive as "EVT <name>" serial lines into eventQueue; deviceEvents()
// drains it (keeps the Timer's existing 5s poll shape — no App.tsx changes).
export async function deviceEvents(): Promise<DeviceEvent[]> {
  if (!enabled || !session) return [];
  return eventQueue.splice(0).filter((e) => !e.session || e.session === session);
}
