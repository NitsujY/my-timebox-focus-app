# Firmware v2 — LAN-Triggered Countdown Display

Design contract shared by the web app (`src/`) and the ESP32 firmware
(`firmware/`). Both sides implement this doc; change one side and the other
follows. The laptop running the app and the device are on the same LAN.

## Concept

The device is no longer a standalone Todoist client with a task list. It is a
**triggered countdown display**: idle clock until the app starts a timer,
then big digits. Same hardware (Waveshare ESP32-S3-Touch-LCD-3.5 class board,
480×320, FT6336 touch).

## Trigger channel — UDP broadcast beacons via a local relay

Browsers can't send raw UDP, so a tiny zero-dependency Node relay runs on the
laptop (`tools/timebox-relay.mjs`, started with `npm run relay`):

```
app ──HTTP──▶ relay (127.0.0.1:8787) ──UDP broadcast──▶ ESP32 (port 4242)
app ◀──HTTP──┘        ◀──UDP events─── ESP32 (port 4241)
```

- `http://127.0.0.1` avoids mixed-content problems (the relay answers CORS +
  Private-Network-Access preflights, so it works whether the app is served
  from `http://localhost:5173`, a LAN IP, or a public HTTPS deploy).
- Broadcast needs **no device IP configuration** — any laptop on the LAN can
  drive the device.
- The device learns the relay's IP from the beacon packets and unicasts its
  own events back (extend / log & stop), so the touchscreen can drive the app.

### Wire formats (one line, space-separated key=value)

Beacon, relay → device, UDP port 4242, every 2 s while a timer runs:

```
TB1 s=<sessionId> id=<todoistTaskId> end=<unixSeconds> min=<plannedMin> t=<title>
```

- `end` is absolute wall-clock UTC seconds; the device renders `end − now`, so
  both sides always agree to the second with zero drift.
- `t=` is always last (title may contain spaces), title truncated to 60 chars.

Event, device → relay, UDP port 4241:

```
TB1 s=<sessionId> extend=300
TB1 s=<sessionId> logstop=1
```

### App side (`src/deviceBeacon.ts`, wired into `Timer` in `src/App.tsx`)

The bridge is gated behind **Settings → ESP32 companion display → Trigger
device over LAN** (`prefs.deviceOn`, default **off**). While off, every
`deviceBeacon` call is a no-op and the app behaves exactly as before. Toggling
it off mid-timer stops the beacons (device returns to idle within 8 s).

| Moment | Action |
|---|---|
| Timer mounts | `POST /state {session, id, title, minutes, end}` — relay starts beacons |
| Every 10 s while running | re-`POST /state` (heartbeat + carries current `end`) |
| `extend(m)` | re-`POST /state` with the new `end` |
| Timer unmounts (complete / log & stop / ✕) | `DELETE /state` — beacons stop |
| Every 5 s while running | `GET /events` — `extend` → `extend(5)`, `logstop` → log & exit, same as the app's own buttons |

Everything is fire-and-forget: if the relay isn't running, the timer works
exactly as before (device just stays idle).

### Relay behavior

- Beacons every 2 s while state exists and the last `POST /state` is < 30 s
  old (app crash / closed tab stops the beacons on its own).
- Device events are queued and drained by `GET /events`.

### Device behavior

1. **Idle**: clock only. Listen on UDP 4242.
2. Beacon with a new `s=` → countdown screen (`left = end − now`).
3. Same `s=` → refresh `lastSeen`; if no beacon for **8 s** → back to idle
   (covers app stop, tab close, network blip).
4. After a device-side **log & stop**, ignore that `s=` until a new session
   id appears (the app may keep beaconing briefly before it processes the
   event).

### Why not the alternatives (kept for the record)

| Option | Verdict |
|---|---|
| Todoist task `description` as message bus | Works anywhere, but 0–10 s latency and abuses a user-visible field |
| Todoist `due.datetime` as the timer | Semantically honest, but same latency and changes real task data (Todoist fires its own reminders) |
| Web Bluetooth LE | Instant, no LAN needed; Chrome/Edge only, pairing UX, large BLE firmware surface |
| Cloud relay (MQTT/Firebase) | Real-time anywhere; new backend + on-device secrets, overkill for one desk |
| App as server | Browsers can't accept connections — a closed tab is unreachable |

## UI — big digits only

480×320 landscape. No progress ring (renders poorly), no cards, no chips.

- **Idle**: `HH:MM` centered (Adafruit size 8), date below (size 2, muted),
  tiny `waiting for timer…` hint. Nothing else.
- **Countdown**:
  - Task title: one line, top center, size 2, muted, truncated to fit.
  - `MM:SS` centered, Adafruit **size 12** (5 chars ≈ 360×96 px).
  - Overtime: digits turn accent orange and show `+MM:SS`.
  - Bottom hints, size 1, dim: left half `hold = log & stop`, right half
    `tap = +5 min`.

## Touch — two zones (mirrors the app)

Screen split vertically at x = 240:

| Zone | Gesture | Device action | App equivalent |
|---|---|---|---|
| Left half (x < 240) | **tap-and-hold 1 s** | Post session comment to Todoist, send `logstop` event, back to idle | `Not done — log & stop` → `logAndExit(false)` |
| Right half (x ≥ 240) | **single tap** | `end += 300`, send `extend=300` event, keep counting | `+5 min` → `extend(5)` |

Hold-to-confirm on the left because it terminates the session; extend is
harmless so it gets the cheap gesture. The app processes both events through
the same `extend()` / `logAndExit(false)` paths as its own buttons, so the
behavior is identical no matter which side you touch.

### Session comment (must match the app exactly)

```
⏱ M/D · planned Xm · actual Ym · abandoned
```

Posted to `POST /api/v1/comments` with the task id from the beacon
(`sessionComment()` in `src/App.tsx`). The device never completes tasks in
v2 — completing stays in the app.

## v2 scope cuts

- No task list, no project picker, no duration chips on device
- No pause on device (pause is app-only; the device keeps counting to the
  wall-clock `end` — accepted divergence, same as the app showing real time)
- No `Mark complete` on device — the app owns task completion
- Still no TLS CA pinning, alarm sound, or battery icon

## Keep from v1

- Display / FT6336 touch / TCA9554 init sequence and touch-orientation defines
- TLS retry + reconnect strategy, background-task HTTP POST pattern, PSRAM
  canvas flush
- NTP via `configTzTime`, theme palette
