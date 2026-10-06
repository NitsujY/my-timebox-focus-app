// LAN bridge to the ESP32 companion display — see docs/firmware-v2.md.
// The app drives the device directly over HTTP (no relay): the device runs a
// small server on http://timebox.local:4242. Fire-and-forget: if the device is
// off or unreachable, the timer behaves exactly as before and the display just
// stays idle. The whole bridge is inert while disabled
// (Settings → ESP32 companion display).
//
// NOTE: plain HTTP to timebox.local — only reachable when this app is itself
// served over HTTP (localhost / LAN IP). The HTTPS-deployed app cannot fetch
// it (mixed content); use the local build for the device.
const DEVICE = "http://timebox.local:4242";

let enabled = false;
let session = "";
let current: { id: string; title: string; minutes: number } | null = null;

export function deviceSetEnabled(on: boolean) {
  enabled = on;
  if (!on) deviceStop();
}

const call = (path: string, body?: object) =>
  fetch(DEVICE + path, {
    method: body ? "POST" : "DELETE",
    ...(body
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  }).catch(() => {}); // device absent / offline — fine

export function deviceStart(task: { id: string; content: string }, minutes: number, endMs: number) {
  if (!enabled) return;
  session = `${Date.now()}`;
  current = { id: task.id, title: task.content, minutes };
  void call("/state", { session, ...current, end: endMs });
}

// heartbeat + extend share this: re-post the current wall-clock end
export function deviceUpdate(endMs: number) {
  if (!enabled || !session || !current) return;
  void call("/state", { session, ...current, end: endMs });
}

export function deviceStop() {
  if (!session) return;
  session = "";
  current = null;
  void call("/state");
}

// push device-config prefs (screen-off timeout etc.) — the device applies +
// persists them (docs/firmware-v2.md)
export function deviceConfig(screenOffMin: number) {
  if (!enabled) return;
  void call("/config", { screenOffMin });
}

export type DeviceEvent = { type: "extend" | "logstop" | "complete"; minutes?: number; session?: string };

export async function deviceEvents(): Promise<DeviceEvent[]> {
  if (!enabled || !session) return [];
  try {
    const res = await fetch(DEVICE + "/events");
    const evs = (await res.json()) as DeviceEvent[];
    return evs.filter((e) => !e.session || e.session === session);
  } catch {
    return [];
  }
}
