// BLE bridge to the ESP32 companion display — see docs/firmware-v2.md.
// The app drives the device over Web Bluetooth (no relay, no HTTP server, no
// LAN dependency). BLE is a permissioned browser API, NOT a network fetch, so
// it works fine from the HTTPS deploy (todolist-md.com) — unlike the old
// http://timebox.local fetch, which mixed-content blocked. Chrome/Edge only
// (Safari/Firefox have no Web Bluetooth).
//
// Fire-and-forget: if the device is off, out of range, or the user never picks
// it in the pairing dialog, the timer behaves exactly as before and the display
// just stays idle. The whole bridge is inert while disabled
// (Settings → ESP32 companion display).

const SVC = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const CHAR_STATE = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"; // write=state, notify=events
const CHAR_CONFIG = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"; // write={screenOffMin}

export type DeviceEvent = { type: "extend" | "logstop" | "complete"; minutes?: number; session?: string };

// Minimal Web Bluetooth typings (TS dom lib doesn't ship them all).
interface BLEChar {
  writeValue(v: Uint8Array): Promise<void>;
  startNotifications(): Promise<BLEChar>;
  addEventListener(t: string, cb: (e: Event) => void): void;
}
interface BLEServer2 { connect(): Promise<unknown>; getPrimaryService(u: string): Promise<{ getCharacteristic(u: string): Promise<BLEChar> }>; }
interface BLEDevice2 { name?: string; gatt?: BLEServer2; addEventListener(t: string, cb: () => void): void; }

const nav2 = navigator as Navigator & {
  bluetooth?: {
    requestDevice(o: object): Promise<BLEDevice2>;
  };
};

let enabled = false;
let session = "";
let current: { id: string; title: string; minutes: number } | null = null;

let dev: BLEDevice2 | null = null;
let stateChar: BLEChar | null = null;
let configChar: BLEChar | null = null;
let connecting: Promise<void> | null = null;
const eventQueue: DeviceEvent[] = []; // drained by deviceEvents()

const enc = new TextEncoder();

export function deviceBleSupported(): boolean {
  return !!nav2.bluetooth;
}

// Connect (and subscribe to event notifications). Retries are cheap; failures
// are swallowed so the timer never breaks over a missing/unpaired device.
async function ensure(): Promise<boolean> {
  if (!enabled || !deviceBleSupported()) return false;
  if (stateChar && configChar) return true;
  if (connecting) return connecting.then(() => !!(stateChar && configChar));
  connecting = (async () => {
    try {
      if (!dev) {
        dev = await nav2.bluetooth!.requestDevice({
          filters: [{ name: "Timebox" }, { services: [SVC] }],
          optionalServices: [SVC],
        });
        dev.addEventListener("gattserverdisconnected", () => {
          stateChar = null; configChar = null; // force reconnect next write
        });
      }
      const server = (await dev.gatt!.connect()) as BLEServer2;
      const svc = await server.getPrimaryService(SVC);
      stateChar = await svc.getCharacteristic(CHAR_STATE);
      configChar = await svc.getCharacteristic(CHAR_CONFIG);
      await stateChar.startNotifications();
      stateChar.addEventListener("characteristicvaluechanged", (e) => {
        const v = (e.target as unknown as { value?: DataView }).value;
        if (!v) return;
        const t = new TextDecoder().decode(v.buffer).trim();
        if (t === "extend") eventQueue.push({ type: "extend", minutes: 5, session });
        else if (t === "logstop") eventQueue.push({ type: "logstop", session });
        else if (t === "complete") eventQueue.push({ type: "complete", session });
      });
    } catch {
      // user cancelled the picker, device out of range, etc. — fine
      dev = null; stateChar = null; configChar = null;
    } finally {
      connecting = null;
    }
  })();
  return connecting.then(() => !!(stateChar && configChar));
}

async function writeState(body: object): Promise<void> {
  if (!(await ensure()) || !stateChar) return;
  try {
    await stateChar.writeValue(enc.encode(JSON.stringify(body)));
  } catch {
    stateChar = null; configChar = null; // dropped mid-write; reconnect next time
  }
}

export function deviceSetEnabled(on: boolean) {
  enabled = on;
  if (!on) deviceStop();
}

export function deviceStart(task: { id: string; content: string }, minutes: number, endMs: number) {
  if (!enabled) return;
  session = `${Date.now()}`;
  current = { id: task.id, title: task.content, minutes };
  void writeState({ session, ...current, end: endMs });
}

// heartbeat + extend share this: re-post the current wall-clock end
export function deviceUpdate(endMs: number) {
  if (!enabled || !session || !current) return;
  void writeState({ session, ...current, end: endMs });
}

export function deviceStop() {
  if (!session) return;
  session = "";
  current = null;
  void writeState({}); // {} = session over
}

// push device-config prefs (screen-off timeout etc.) — the device applies +
// persists them (docs/firmware-v2.md)
export function deviceConfig(screenOffMin: number) {
  if (!enabled) return;
  void (async () => {
    if (!(await ensure()) || !configChar) return;
    try {
      await configChar.writeValue(enc.encode(JSON.stringify({ screenOffMin })));
    } catch {
      stateChar = null; configChar = null;
    }
  })();
}

// Events arrive via BLE notifications into eventQueue; deviceEvents() drains it
// (keeps the Timer's existing 5s poll shape — no App.tsx changes needed).
export async function deviceEvents(): Promise<DeviceEvent[]> {
  if (!enabled || !session) return [];
  return eventQueue.splice(0).filter((e) => !e.session || e.session === session);
}
