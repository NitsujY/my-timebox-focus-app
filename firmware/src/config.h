#pragma once

// I2C bus (FT6336 touch, TCA9554 expander) — from dash_35 firmware.
#define PIN_SDA 21
#define PIN_SCL 22

// FT6336 touch (minimal single-tap I2C read, no lib).
#define FT_ADDR      0x38
#define TOUCH_RAW_W  320  // raw range in portrait
#define TOUCH_RAW_H  480
// ponytail: panel mounting varies — flip these after first boot if mirrored.
#define TOUCH_SWAP_XY 1   // panel native portrait, screen rotated landscape
#define TOUCH_INV_X   0
#define TOUCH_INV_Y   1

// POSIX TZ string for configTzTime, e.g. "PST8PDT,M3.2.0,M11.1.0".
#define TZ_POSIX "CST-8"

// LAN trigger: the app drives the device over BLE (Web Bluetooth, docs/firmware-v2.md).
// Nordic-UART-style service; the device advertises as "Timebox".
#define BLE_SVC_UUID   "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define BLE_STATE_UUID "6e400002-b5a3-f393-e0a9-e50e24dcca9e"  // write=state json ({} = stop), notify=events
#define BLE_CONFIG_UUID "6e400003-b5a3-f393-e0a9-e50e24dcca9e" // write={screenOffMin}

// Screen sleep: idle clock goes fully dark (backlight + ST7796 SLPIN) after this.
// Active timer keeps the screen on; touch or a /state POST wakes it.
// Default only — the app overrides it at runtime via POST /config
// ({screenOffMin}, ../docs/firmware-v2.md); the override persists in NVS.
#define SCREEN_OFF_MS (5 * 60 * 1000UL)
