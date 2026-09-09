# ESP32 Timebox Companion — Design

A desk companion for the Timebox Focus web app: shows the clock and the
**Focus** section, lets you pick a task and run a countdown on-device.

UI reference / spec: `esp-preview.html` (open in a browser; 480×320 frame is
the exact display resolution). The firmware implements exactly what it shows.

## Architecture

No backend anywhere. The device talks to the Todoist REST API v1 directly over
WiFi/HTTPS, same as the web app. The web app and device never talk to each
other; Todoist is the shared source of truth.

- **Auth**: manual API token (Todoist → Settings → Integrations → Developer),
  stored in flash via `secrets.h`. OAuth is not viable on-device.
- **Sync**: poll every 30–60 s; resolve the `Focus` section ID via
  `GET /api/v1/sections?project_id=…` on boot, then
  `GET /api/v1/tasks?project_id=…` and filter by section.
- **Clock**: NTP via `configTime()`, persisted in the PCF85063 RTC.
- **TLS**: `client.setInsecure()` for v1; pin the api.todoist.com root CA
  before the device leaves your desk.

## Screens / flow

1. **List** — clock (HH:MM) + date on top, up to 3 Focus tasks below.
   Tap a task: it highlights (orange border), others dim, bottom bar shows
   `←` + duration chips (5/10/15/25/50/90, task's planned duration
   pre-selected). `←` deselects.
2. **Timer** — tap the selected task again. Progress ring + MM:SS, task
   title, `+5 min`, `Done` and `Log & exit` buttons. Tap background =
   pause/resume (time turns orange). At 0:00 ring goes solid orange.
3. Back is always an on-screen `←` / button — the device has no keyboard.

Theme mirrors the web app: bg `#09090b`, cards `#18181b`, borders `#27272a`,
accent orange `#f97316`, muted text `#71717a`. Font: Inter-ish sans, sizes
readable at arm's length on a 3.5" panel.

## Shared conventions (keep in sync with the web app)

- Section name `Focus` (case-insensitive) = today's tasks
- Duration chips: 5, 10, 15, 25, 50, 90 minutes
- Task's Todoist `duration` pre-fills the chip selection; default 5 min
- Timer exits mirror the web app: `Done` closes the Todoist task
  (`POST /api/v1/tasks/{id}/close`), `Log & exit` leaves it open.
  No local session log (the web app's Review tab owns stats; add an
  SD/flash log later if wanted).

## v1 scope cuts

- No Bluetooth, no web-app pairing — direct API only
- No timer sync between device and web app — device owns its own countdown;
  don't run both on the same task
- No Buffer/Backlog tabs — Focus section only
- No alarm sound in v1 (ES8311 wired up when "ring solid orange" proves
  insufficient), no battery icon (AXP2101 later)
