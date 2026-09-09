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

Pin map is already set from the working dash_35 firmware (classic ESP32:
SPI 23/18/19, CS 5, DC 27, reset via TCA9554 pin 0, backlight GPIO 25,
I2C SDA 21 / SCL 22). Note: the FT6336 touch chip is held in reset by the
TCA9554 at power-on — `setup()` releases all expander pins high to wake it.

## Switching projects

Tap the top bar (clock/date) on the list screen → pick a project. The choice
is saved to flash and survives reboots; `TODOIST_PROJECT_ID` in `secrets.h`
is just the first-boot default.

## After first boot

- If touch taps land mirrored/rotated, flip `TOUCH_SWAP_XY` / `TOUCH_INV_X` /
  `TOUCH_INV_Y` in `src/config.h` and reflash.
- If sync fails, the screen shows `sync failed` — check token, project ID,
  and that a section named `Focus` exists in the project.

## v1 scope cuts (per DESIGN.md)

No Bluetooth/pairing, no RTC persist, no alarm sound, no battery icon,
no TLS CA pinning (`setInsecure()` — pin the api.todoist.com root CA before
the device leaves your desk).
