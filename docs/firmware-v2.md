# Firmware v2 — LAN-Triggered Countdown Display

Design contract shared by the web app (`src/`) and the ESP32 firmware
(`firmware/`). Both sides implement this doc; change one side and the other
follows. The laptop running the app and the device are on the same LAN.

## Concept

The device is no longer a standalone Todoist client with a task list. It is a
**triggered countdown display**: idle clock until the app starts a timer,
then big digits. Same hardware (Waveshare ESP32-S3-Touch-LCD-3.5 class board,
480×320, FT6336 touch).

## Trigger channel — BLE (Web Bluetooth), app talks straight to the device

The ESP32 is a **BLE peripheral**; the web app connects with **Web Bluetooth**
and drives it directly. No relay, no HTTP server, no LAN — and because BLE is a
permissioned browser API (not a network fetch), it **works from the
HTTPS-deployed app** (`todolist-md.com`), which the old plain-HTTP design could
not. Chrome/Edge only (Safari/Firefox have no Web Bluetooth).

```
app ──BLE GATT──▶ ESP32 "Timebox"
  STATE  char  write {session, id, title, minutes, end}   start / heartbeat (end = unix ms)
                write {}                                     session over
                notify "extend" | "logstop" | "complete"      touchscreen events → app
  CONFIG char write {screenOffMin}                            screen-off timeout (min, 0 = never)
```

- **Service** `6e400001-b5a3-f393-e0a9-e50e24dcca9e` (Nordic-UART-style);
  **STATE** `6e400002-…` (write + notify), **CONFIG** `6e400003-…` (write).
- The device advertises the name **`Timebox`**. The app calls
  `navigator.bluetooth.requestDevice({filters:[{name:"Timebox"}]})`, so the user
  picks it once in the browser's pairing dialog; after that it reconnects
  automatically.
- No pairing/bonding, no PIN — just the Web Bluetooth device picker.

### App side (`src/deviceBle.ts`, wired into `Timer` in `src/App.tsx`)

The bridge is gated behind **Settings → ESP32 companion display → Trigger
device** (`prefs.deviceOn`, default **off**). While off, every call is a no-op
and the app behaves exactly as before. Toggling it off mid-timer stops the
heartbeats (device returns to idle within ~25 s).

| Moment | Action |
|---|---|
| Timer mounts | write STATE `{session, id, title, minutes, end}` — device shows the countdown |
| Every 10 s while running | re-write STATE (heartbeat + carries current `end`) |
| `extend(m)` | re-write STATE with the new `end` |
| Timer unmounts (complete / log & stop / ✕) | write STATE `{}` — device returns to idle |
| Every 5 s while running | drain the event queue — `extend` → `extend(5)`, `logstop` → log & exit, `complete` → log as completed + close task (same as the app's own buttons). Events arrive as BLE notifications into a queue, so this poll just drains it. |
| Enabling the bridge, or changing the screen-off pref | write CONFIG `{screenOffMin}` |

Everything is fire-and-forget: if the device is off, out of range, or never
paired, the timer works exactly as before (the display just stays idle).

### Device behavior

1. **Idle**: clock only. Advertise BLE as `Timebox`; the app connects and
   writes STATE.
2. STATE write with a new `session` → countdown screen (`left = end − now`).
3. Re-write STATE (heartbeat) refreshes `lastSeen`; if none for **25 s** →
   back to idle (covers app stop, tab close, BLE drop). Heartbeats are every
   10 s, so 25 s = 2 misses + slack.
4. STATE write of `{}` → back to idle immediately.
5. After a device-side **log & stop**, ignore that `session` until a new one
   appears (the app may keep heartbeating briefly before it processes the
   event).
6. CONFIG write is applied live and persisted to flash (NVS); `screenOffMin`
   sets the idle screen-off timeout (`0` = never).
7. Touchscreen gestures (extend / log & stop / complete) send a BLE
   notification on the STATE characteristic; the app's listener pushes them
   onto a queue.

### Why not the alternatives (kept for the record)

| Option | Verdict |
|---|---|
| Todoist task `description` as message bus | Works anywhere, but 0–10 s latency and abuses a user-visible field |
| Todoist `due.datetime` as the timer | Semantically honest, but same latency and changes real task data (Todoist fires its own reminders) |
| Localhost relay | Worked from the HTTPS deploy via `127.0.0.1`, but required a Node process always running on the laptop — removed |
| Direct HTTP to the device | No relay, but plain HTTP to `timebox.local` is mixed-content-blocked from the HTTPS deploy — removed |
| **Web Bluetooth LE (chosen)** | Works from the HTTPS deploy, no LAN/relay; Chrome/Edge only, one-time pairing dialog |
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
