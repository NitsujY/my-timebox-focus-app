# Firmware v2 — LAN-Triggered Countdown Display

Design contract shared by the web app (`src/`) and the ESP32 firmware
(`firmware/`). Both sides implement this doc; change one side and the other
follows. The laptop running the app and the device are on the same LAN.

## Concept

The device is no longer a standalone Todoist client with a task list. It is a
**triggered countdown display**: idle clock until the app starts a timer,
then big digits. Same hardware (Waveshare ESP32-S3-Touch-LCD-3.5 class board,
480×320, FT6336 touch).

## Trigger channel — USB serial (Web Serial), app talks straight to the device

The ESP32 is a **USB-serial peripheral**; the web app connects with **Web
Serial** and drives it directly — one JSON object per line at 115200 baud. No
relay, no HTTP server, no LAN, and **no BLE**: the BLE stack on top of WiFi
starved IRAM/heap and made the 480×320 flush flicker, so the cable replaced it.
WiFi stays on for **NTP** (and mDNS, `timebox.local`) so the device works as a
normal clock with the app closed — but there are no on-device TLS calls anymore
(the log-&-stop comment moved to the app). Like BLE, Web Serial is a
permissioned browser API, so it **works from the HTTPS-deployed app**
(`todolist-md.com`). Chrome/Edge only (Safari/Firefox have no Web Serial).

```
app ──USB CDC @115200, one JSON object per line──▶ ESP32
  write {session, id, title, minutes, end, time}   start / heartbeat (end = unix ms, time = unix s)
  write {}                                          session over
  write {screenOffMin}                              screen-off timeout (min, 0 = never)
  read  "EVT extend" | "EVT logstop" | "EVT complete"   touchscreen events → app
```

- The app calls `navigator.serial.requestPort()` on first use (the user picks
  the device's USB serial port once); afterwards `getPorts()` returns the
  granted port and reconnects without a dialog.
- The device gets its clock from **NTP over WiFi** (`configTzTime`,
  `TZ_POSIX` in `firmware/src/config.h`), so it's a normal clock on every boot.
  If WiFi is down, the `time` field (unix seconds) riding on state lines is the
  backup — the device `settimeofday()`s from it.
- Device→app events are plain `EVT <name>` lines amid the device's log output —
  the app ignores everything else.

### App side (`src/deviceSerial.ts`, wired into `Timer` in `src/App.tsx`)

The bridge is gated behind **Settings → ESP32 companion display → Trigger
device** (`prefs.deviceOn`, default **off**). While off, every call is a no-op
and the app behaves exactly as before. Toggling it off mid-timer stops the
heartbeats (device returns to idle within ~25 s).

| Moment | Action |
|---|---|
| Timer mounts | send `{session, id, title, minutes, end, time}` — device shows the countdown |
| Every 10 s while running | re-send state (heartbeat + carries current `end` and `time`) |
| `extend(m)` | re-send state with the new `end` |
| Timer unmounts (complete / log & stop / ✕) | send `{}` — device returns to idle |
| Every 5 s while running | drain the event queue — `extend` → `extend(5)`, `logstop` → log & exit, `complete` → log as completed + close task (same as the app's own buttons). Events arrive as `EVT` serial lines into a queue, so this poll just drains it. |
| Enabling the bridge, or changing the screen-off pref | send `{screenOffMin}` |

Everything is fire-and-forget: if the device is off, out of range, or never
paired, the timer works exactly as before (the display just stays idle).

### Device behavior

1. **Idle**: clock only. The app opens the serial port and sends state lines.
2. A state line with a new `session` → countdown screen (`left = end − now`).
3. A re-sent state line (heartbeat) refreshes `lastSeen`; if none for **25 s** →
   back to idle (covers app stop, tab close, cable pull). Heartbeats are every
   10 s, so 25 s = 2 misses + slack.
4. A state line of `{}` → back to idle immediately.
5. After a device-side **log & stop**, ignore that `session` until a new one
   appears (the app may keep heartbeating briefly before it processes the
   event).
6. A `{screenOffMin}` line is applied live and persisted to flash (NVS);
   `screenOffMin` sets the idle screen-off timeout (`0` = never).
7. Touchscreen gestures (extend / log & stop / complete) print an `EVT <name>`
   serial line; the app's read loop pushes them onto a queue.

### Why not the alternatives (kept for the record)

| Option | Verdict |
|---|---|
| Todoist task `description` as message bus | Works anywhere, but 0–10 s latency and abuses a user-visible field |
| Todoist `due.datetime` as the timer | Semantically honest, but same latency and changes real task data (Todoist fires its own reminders) |
| Localhost relay | Worked from the HTTPS deploy via `127.0.0.1`, but required a Node process always running on the laptop — removed |
| Direct HTTP to the device | No relay, but plain HTTP to `timebox.local` is mixed-content-blocked from the HTTPS deploy — removed |
| Web Bluetooth LE | Worked from the HTTPS deploy, but BLE on top of WiFi starved IRAM/heap → display flicker — removed |
| **USB serial (chosen)** | No BLE stack at all (flicker gone), works from the HTTPS deploy; WiFi stays for NTP. Needs the cable, Chrome/Edge only |
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
| Left half (x < 240) | **tap-and-hold 1 s** | Send `logstop` event, back to idle (the app posts the session comment) | `Not done — log & stop` → `logAndExit(false)` |
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

Posted by the app to `POST /api/v1/comments` with the task id from the session
state (`sessionComment()` in `src/App.tsx`). The device has no network access
(no WiFi), so all Todoist API calls — including this comment — are app-side.
The device never completes tasks in v2 — completing stays in the app.

## v2 scope cuts

- No task list, no project picker, no duration chips on device
- No pause on device (pause is app-only; the device keeps counting to the
  wall-clock `end` — accepted divergence, same as the app showing real time)
- Still no TLS CA pinning, alarm sound, or battery icon

## Keep from v1

- Display / FT6336 touch / TCA9554 init sequence and touch-orientation defines
- PSRAM canvas flush, theme palette
- NTP via `configTzTime`; the app's `{time}` serial lines are the fallback when
  WiFi is down
