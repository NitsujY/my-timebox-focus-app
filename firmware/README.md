# ESP32 Timebox Companion — firmware v2

Triggered countdown display for the Timebox Focus web app: idle clock until
you start a timer in the app, then big digits. Design contract:
[../docs/firmware-v2.md](../docs/firmware-v2.md). Hardware: `SPEC.md`.

The web app drives the device directly over **USB serial (Web Serial)** — one
JSON object per line at 115200 baud. No BLE: the BLE stack on top of WiFi
starved IRAM/heap and made the 480×320 flush flicker, so the cable replaced it.
WiFi stays on for **NTP only**, so the device works as a normal clock even with
the app closed (it also advertises `timebox.local` via mDNS). Chrome/Edge only
(Safari/Firefox have no Web Serial). If the network is down, the app pushes
`{time}` over serial as backup.

## Setup

1. Install [PlatformIO](https://platformio.org/) (`brew install platformio` or the VS Code extension).
2. `cp src/secrets.example.h src/secrets.h` and fill in `WIFI_SSID` / `WIFI_PASS`.
3. Set your timezone in `src/config.h` (`TZ_POSIX`, e.g. `"CST-8"`).
4. Nothing to run on the laptop and nothing to pair — plug the device in and
   the app opens its serial port.

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

1. Open the app in Chrome/Edge (works from the HTTPS deploy or `npm run dev`).
2. In the app: Settings → ESP32 companion display → **Trigger device**
   (off by default). The first time you start a timer, the browser shows a
   port dialog — pick the device's USB serial port.
3. Start a timer in the app → the device shows the countdown within a second.
3. Touchscreen while counting:
   - **right half, tap** = +5 min (app extends too, via the `EVT extend` line)
   - **left half, hold 1 s** = log & stop (the app logs the session comment and exits the timer)
4. Timer ends/stops in the app → device returns to the idle clock.

## After first boot

- If touch taps land mirrored/rotated, flip `TOUCH_SWAP_XY` / `TOUCH_INV_X` /
  `TOUCH_INV_Y` in `src/config.h` and reflash.
- If the device never reacts: confirm the cable carries data (not charge-only),
  that you're on Chrome/Edge, and that you picked the right port in the
  browser's dialog. Serial logs: `pio device monitor` at 115200 baud — note the
  app holds the port while connected, so close the app tab first.

## v2 scope cuts (per docs/firmware-v2.md)

No task list / project picker / duration chips on device, no pause or
complete on device, no Todoist polling. Still no TLS CA pinning, alarm sound,
or battery icon.
