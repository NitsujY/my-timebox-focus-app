// Copy to secrets.h (gitignored) and fill in.
#pragma once

// WiFi is used for NTP only — the device works as a normal clock even with
// the app closed. No Todoist token here: all API calls are app-side.
#define WIFI_SSID "your-ssid"
#define WIFI_PASS "your-password"
