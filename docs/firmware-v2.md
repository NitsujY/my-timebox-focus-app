# Firmware v2 — LAN-Triggered Countdown Display

Design contract shared by the web app (`src/`) and the ESP32 firmware
(`firmware/`). Both sides implement this doc; change one side and the other
follows. The laptop running the app and the device are on the same LAN.

## Concept

The device is no longer a standalone Todoist client with a task list. It is a
**triggered countdown display**: idle clock until the app starts a timer,
then big digits. Same hardware (Waveshare ESP32-S3-Touch-LCD-3.5 class board,
480×320, FT6336 touch).

## Trigger channel — plain HTTP, app talks straight to the device

The ESP32 runs a tiny HTTP server (raw `WiFiServer`, port **4242**); the web
app fetches it directly. **No relay, no UDP.**

```
app ──HTTP──▶ ESP32  http://timebox.local:4242
  POST   /state   {session, id, title, minutes, end}   start / heartbeat (end = unix ms)
  DELETE /state                                          session over
  POST   /config  {screenOffMin}                        screen-off timeout (min, 0 = never)
  GET    /events  → [{type, minutes?, session}]         touchscreen events, drained
  GET    /logs    → last 24 log lines                   serial-less debugging
  GET    /health  → ok
```

- The device answers CORS + Private-Network-Access preflights, so a browser
  page can call it.
- **mDNS**: the device advertises `timebox.local`, so no IP configuration is
  needed — any machine on the LAN can drive it.
- **Constraint**: this is plain HTTP to `timebox.local`. It works when the app
  is served over HTTP (`http://localhost:5173`, or a LAN IP). The
  HTTPS-deployed app **cannot** fetch it (mixed content) — use the local build
  with a Todoist API token for the device. This is the deliberate trade for
  deleting the relay.

### App side (`src/deviceBeacon.ts`, wired into `Timer` in `src/App.tsx`)

The bridge is gated behind **Settings → ESP32 companion display → Trigger
device over LAN** (`prefs.deviceOn`, default **off**). While off, every
`deviceBeacon` call is a no-op and the app behaves exactly as before. Toggling
it off mid-timer stops the heartbeats (device returns to idle within ~25 s).

| Moment | Action |
|---|---|
| Timer mounts | `POST /state {session, id, title, minutes, end}` — device shows the countdown |
| Every 10 s while running | re-`POST /state` (heartbeat + carries current `end`) |
| `extend(m)` | re-`POST /state` with the new `end` |
| Timer unmounts (complete / log & stop / ✕) | `DELETE /state` — device returns to idle |
| Every 5 s while running | `GET /events` — `extend` → `extend(5)`, `logstop` → log & exit, `complete` → log as completed + close task, same as the app's own buttons |
| Enabling the bridge, or changing the screen-off pref | `POST /config {screenOffMin}` |

Everything is fire-and-forget: if the device is off or unreachable, the timer
works exactly as before (the display just stays idle).

### Device behavior

1. **Idle**: clock only. Serve HTTP on 4242.
2. `POST /state` with a new `session` → countdown screen (`left = end − now`).
3. Re-`POST /state` (heartbeat) refreshes `lastSeen`; if none for **25 s** →
   back to idle (covers app stop, tab close, network blip). Heartbeats are
   every 10 s, so 25 s = 2 misses + slack.
4. `DELETE /state` → back to idle immediately.
5. After a device-side **log & stop**, ignore that `session` until a new one
   appears (the app may keep heartbeating briefly before it processes the
   event).
6. `POST /config` is applied live and persisted to flash (NVS); `screenOffMin`
   sets the idle screen-off timeout (`0` = never).
7. Touchscreen gestures (extend / log & stop / complete) push JSON onto an
   8-slot in-device event queue, drained by the app's `GET /events` poll.

### Why not the alternatives (kept for the record)

| Option | Verdict |
|---|---|
| Todoist task `description` as message bus | Works anywhere, but 0–10 s latency and abuses a user-visible field |
| Todoist `due.datetime` as the timer | Semantically honest, but same latency and changes real task data (Todoist fires its own reminders) |
| Localhost relay (the old design) | Worked from the HTTPS deploy via `127.0.0.1`, but required a Node process always running on the laptop — removed in favor of direct HTTP |
| Web Bluetooth LE | Instant, no LAN, works from HTTPS; Chrome/Edge only, pairing UX, large BLE firmware surface |
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
    `tap = +5 · hold = done`.
  - An accent bar under the pressed half appears while touching — instant
    feedback that the touch registered and which zone (left/right) it mapped to.

## Touch — two zones (mirrors the app)

Screen split vertically at x = 240:

| Zone | Gesture | Device action | App equivalent |
|---|---|---|---|
| Left half (x < 240) | **tap-and-hold 1 s** | Post session comment to Todoist, send `logstop` event, back to idle | `Not done — log & stop` → `logAndExit(false)` |
| Right half (x ≥ 240) | **single tap** | `end += 300`, send `extend=300` event, keep counting | `+5 min` → `extend(5)` |
| Right half (x ≥ 240) | **tap-and-hold 1 s** | Send `complete=1` event, back to idle | `Mark complete` → `logAndExit(true)` + complete task |

Hold-to-confirm on both halves because they terminate the session; extend is
harmless so it gets the cheap gesture. The app processes all events through
the same `extend()` / `logAndExit()` / `onComplete()` paths as its own buttons,
so the behavior is identical no matter which side you touch. On `complete` the
app also closes the task per the user's complete-action pref and posts the
`✓ completed` comment — the device deliberately does neither (no TLS needed).

### Session comment (must match the app exactly)

```
⏱ M/D · planned Xm · actual Ym · abandoned
```

Posted to `POST /api/v1/comments` with the task id from the session state
(`sessionComment()` in `src/App.tsx`). The device never completes tasks in
v2 — completing stays in the app.

## v2 scope cuts

- No task list, no project picker, no duration chips on device
- No pause on device (pause is app-only; the device keeps counting to the
  wall-clock `end` — accepted divergence, same as the app showing real time)
- Still no TLS CA pinning, alarm sound, or battery icon

## Keep from v1

- Display / FT6336 touch / TCA9554 init sequence and touch-orientation defines
- TLS retry + reconnect strategy, background-task HTTP POST pattern, PSRAM
  canvas flush
- NTP via `configTzTime`, theme palette
