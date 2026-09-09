# ESP32 Timebox Companion — firmware

Desk companion for the Timebox Focus web app: clock + Todoist `Focus` section,
tap a task, run a countdown. Design: `DESIGN.md`, hardware: `SPEC.md`,
UI reference: `esp-preview.html`.

## Setup

1. Install [PlatformIO](https://platformio.org/) (`brew install platformio` or the VS Code extension).
2. `cp src/secrets.example.h src/secrets.h` and fill in:
   - `WIFI_SSID` / `WIFI_PASS`
   - `TODOIST_TOKEN` — Todoist → Settings → Integrations → Developer
   - `TODOIST_PROJECT_ID` — from the project URL (`todoist.com/app/project/<name>-<id>`)
3. Set your timezone in `src/config.h` (`TZ_POSIX`, e.g. `"CST-8"`).

## Build, flash, monitor

```sh
cd firmware
pio run                # build
pio run -t upload      # flash (auto-detects the serial port)
pio device monitor     # serial logs, 115200 baud
```

Pin map is already set from the vendor demo (SPI 1/5/2, DC 3, CS tied low,
reset via TCA9554 pin 1, backlight GPIO 6, I2C SDA 8 / SCL 7). Only revisit it
if you have a different board revision.

## Switching projects

Tap the date (top-right) on the list screen → pick a project. The choice is
saved to flash and survives reboots; `TODOIST_PROJECT_ID` in `secrets.h` is
just the first-boot default.

## After first boot

- If touch taps land mirrored/rotated, flip `TOUCH_SWAP_XY` / `TOUCH_INV_X` /
  `TOUCH_INV_Y` in `src/config.h` and reflash.
- If sync fails, the screen shows `sync failed` — check token, project ID,
  and that a section named `Focus` exists in the project.

## v1 scope cuts (per DESIGN.md)

No Bluetooth/pairing, no RTC persist, no alarm sound, no battery icon,
no TLS CA pinning (`setInsecure()` — pin the api.todoist.com root CA before
the device leaves your desk).
