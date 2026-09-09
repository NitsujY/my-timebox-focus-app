# Hardware & Stack Spec

## Board

ESP32 Touch LCD 3.5 (Waveshare ESP32-S3-Touch-LCD-3.5 class board).

| Component | Part | Interface | Used for |
|---|---|---|---|
| MCU | ESP32-S3, 16 MB flash, 2 MB PSRAM | — | firmware |
| Display | ST7796, 480×320 | SPI | UI |
| Touch | FT6336 (capacitive) | I2C | tap input — no physical buttons |
| RTC | PCF85063 | I2C | persistent clock (still NTP-synced on WiFi) |
| Audio codec | ES8311 | I2S | time-up alarm |
| PMIC | AXP2101 | I2C | battery %, charge state |
| IO expander | TCA9554 | I2C | backlight / misc GPIO |

Pin map: copy from the board vendor wiki/schematic — do not guess.

## Firmware stack

- **PlatformIO** (`platformio.ini`), Arduino framework on `esp32-s3`
- **TFT_eSPI** — ST7796 driver; config via `User_Setup.h` defines
- **FT6336 touch** — vendor demo lib or any minimal FT6336 I2C driver (single-point tap is all we need)
- **ArduinoJson** — with `JsonFilter`, only `id` / `content` / `section_id` / `duration`
- **WiFiClientSecure + HTTPClient** — Todoist API
- RTC/PMIC/audio libs only when the feature that needs them lands (alarm → ES8311, battery icon → AXP2101). Not v1.

## platformio.ini sketch

```ini
[env:esp32-s3-touch-lcd-3.5]
platform = espressif32
board = esp32-s3-devkitc-1
framework = arduino
board_build.arduino.memory_type = qio_qspi   ; 2MB PSRAM
lib_deps =
  bodmer/TFT_eSPI
  bblanchon/ArduinoJson
build_flags =
  -D USER_SETUP_LOADED
  ; TFT_eSPI ST7796 + pin defines go here or in User_Setup.h
```

## Secrets

`src/secrets.h`, gitignored: WiFi SSID/password, `TODOIST_TOKEN`, `TODOIST_PROJECT_ID`.
`src/secrets.example.h` committed as template.
