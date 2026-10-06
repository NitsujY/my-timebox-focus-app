# ESP32 Timebox Companion — firmware v2

Triggered countdown display for the Timebox Focus web app: idle clock until
you start a timer in the app, then big digits. Design contract:
[../docs/firmware-v2.md](../docs/firmware-v2.md). Hardware: `SPEC.md`.

The web app drives the device directly over **HTTP** — the device runs a tiny
server on `http://timebox.local:4242`. No relay, no Todoist polling on the
device anymore (Todoist is only used for the log & stop comment).

## Setup

1. Install [PlatformIO](https://platformio.org/) (`brew install platformio` or the VS Code extension).
2. `cp src/secrets.example.h src/secrets.h` and fill in:
   - `WIFI_SSID` / `WIFI_PASS`
   - `TODOIST_TOKEN` — Todoist → Settings → Integrations → Developer
     (only used to post the "log & stop" session comment)
3. Set your timezone in `src/config.h` (`TZ_POSIX`, e.g. `"CST-8"`).
4. Nothing to run on the laptop — the app talks to the device directly.

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

## Usage

1. Serve the web app over HTTP (`npm run dev`, or the built app from a LAN IP)
   — the device uses plain HTTP to `timebox.local`, which the HTTPS-deployed
   app can't reach (mixed content). Use a Todoist API token for local dev.
2. In the app: Settings → ESP32 companion display → **Trigger device over LAN**
   (off by default).
3. Start a timer in the app → the device shows the countdown within a second.
3. Touchscreen while counting:
   - **right half, tap** = +5 min (app extends too, on its next event poll)
   - **left half, hold 1 s** = log & stop (posts the Todoist comment, app exits the timer)
4. Timer ends/stops in the app → device returns to the idle clock.

## After first boot

- If touch taps land mirrored/rotated, flip `TOUCH_SWAP_XY` / `TOUCH_INV_X` /
  `TOUCH_INV_Y` in `src/config.h` and reflash.
- If the device never reacts: check that it resolves
  (`ping timebox.local`), that its HTTP server answers
  (`curl http://timebox.local:4242/health` → `ok`), and that you're running
  the app over HTTP (not the HTTPS deploy). Peek at the device without serial:
  `curl http://timebox.local:4242/logs`.

## v2 scope cuts (per docs/firmware-v2.md)

No task list / project picker / duration chips on device, no pause or
complete on device, no Todoist polling. Still no TLS CA pinning, alarm sound,
or battery icon.
