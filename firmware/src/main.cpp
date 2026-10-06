// ESP32 Timebox Companion v2 — triggered countdown display, see ../docs/firmware-v2.md.
// Idle clock until the app starts a timer; the app drives it over USB serial
// (Web Serial, one JSON object per line). WiFi is on for NTP so it works as a
// normal clock with the app closed — but no BLE and no on-device TLS: those
// were what starved IRAM/heap and tore frames on the 480x320 flush.
// Left hold = log & stop, right tap = +5 min, right hold = mark complete (mirrors the web app).
#include <Arduino.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <ArduinoJson.h>
#include <Arduino_GFX_Library.h>
#include <Wire.h>
#include <Preferences.h>
#include "config.h"
#include "secrets.h"

// pins from esp32-drive-orbit dash_35 (dashboard_display.cpp)
// NOTE: Arduino_ESP32SPIDMA overflows iram0 on this board's prebuilt core
// (IDF 4.4 links the WiFi/BT ISRs no matter what we call at runtime). The
// polling ESP32SPI is fine now that nothing competes for the CPU.
static Arduino_DataBus *bus = new Arduino_ESP32SPI(27 /*DC*/, 5 /*CS*/, 18 /*SCK*/, 23 /*MOSI*/, 19 /*MISO*/);
static Arduino_GFX *gfx = new Arduino_ST7796(bus, GFX_NOT_DEFINED /*RST via TCA9554*/, 0, true /*ips*/);
// PSRAM back buffer, flushed once per frame — kills flicker (same trick as dash_35).
static Arduino_Canvas *cv = nullptr;
static Arduino_ST7796 *panel = nullptr;  // gfx may point at cv; panel stays for sleep cmds
static bool screenAsleep = false;
static void flush() { if (cv && !screenAsleep) cv->flush(); }

// theme, mirrors web app
#define C565(r, g, b) (uint16_t)((((r) & 0xF8) << 8) | (((g) & 0xFC) << 3) | ((b) >> 3))
static const uint16_t C_BG = C565(9, 9, 11),      C_ACCENT = C565(249, 115, 22),
                      C_TEXT = C565(244, 244, 245), C_MUTED = C565(113, 113, 122),
                      C_DIM = C565(82, 82, 91);

// Adafruit-font text helper: size s chars are 6*s wide, 8*s tall. center=true → x is center.
static void text(const String& s, int x, int y, uint8_t size, uint16_t fg, uint16_t bg, bool center = false) {
  gfx->setTextSize(size);
  gfx->setTextColor(fg, bg);
  gfx->setCursor(center ? x - (int)s.length() * 6 * size / 2 : x, y);
  gfx->print(s);
}

// ---- session state (driven by the app over USB serial) ----
struct Session { String id, taskId, title; long end; int minPlanned; };
static Session sess;
static bool haveSess = false;
static String ignoredSess;          // after device-side log & stop, until a new session id
static uint32_t lastBeacon = 0;
#define BEACON_TIMEOUT_MS 25000     // app heartbeats every 10s; 2 misses + slack = session over
#define EXTEND_S 300

enum Screen { SCR_IDLE, SCR_TIMER };
static Screen screen = SCR_IDLE;
static int lastMinuteShown = -1;
static long lastShownS = -1;
static int lastHintS = -1;        // last pre-sleep hint second drawn (-1 = none)
static uint32_t lastTouchMs = 0;  // last touch press (screen-sleep activity)
static uint32_t screenOffMs = SCREEN_OFF_MS;  // app-overridable, persisted in NVS "tb"/"soff" (0 = never)

// ---- USB serial: the app (Web Serial) drives the device directly ----
// One JSON object per line, app -> device (docs/firmware-v2.md):
//   {session,id,title,minutes,end,time}   start / heartbeat ({} = stop)
//   {screenOffMin}                        screen-off timeout
//   {time}                                unix secs — no NTP without WiFi
// device -> app events are "EVT <name>" lines (extend / logstop / complete).

// log ring (serial + curl via the log server is gone with HTTP; serial only now)
#define LOG_LINES 24
static String logBuf[LOG_LINES];
static int logHead = 0;
static void logLine(const String& s) {
  Serial.println(s);
  logBuf[logHead] = s;
  logHead = (logHead + 1) % LOG_LINES;
}

static void drawTimer();        // defined below, used by applyStateJson
static void drawIdle();         // defined below, used by wakeScreen
static void goIdle();           // defined below, used by applyStateJson ({} stop)
static void drawStatusIcons();  // defined below, used by applyConfigJson

// ---- screen sleep: idle clock goes fully dark after SCREEN_OFF_MS (see config.h) ----
static void wakeScreen() {
  if (!screenAsleep) return;
  screenAsleep = false;
  panel->displayOn();       // SLPOUT + 120ms (library handles the delay)
  digitalWrite(25, HIGH);
  lastShownS = -1;          // force redraw of whatever screen we're on
  lastMinuteShown = -1;
  if (screen == SCR_TIMER) drawTimer();
  else drawIdle();
  logLine("[SCR] wake");
}
static void sleepScreen() {
  if (screenAsleep) return;
  logLine(String("[SCR] sleep (idle timeout ") + (screenOffMs / 60000) + "m)");
  digitalWrite(25, LOW);    // backlight off
  panel->displayOff();      // SLPIN — panel truly inert, GRAM retained
  screenAsleep = true;
}

// ---- touch: FT6336 single-point ----
static bool touchPresent = true;
static uint32_t touchRetryAt = 0;
static bool readTouch(int16_t &x, int16_t &y) {
  if (!touchPresent) {
    if (millis() < touchRetryAt) return false;
    touchRetryAt = millis() + 2000;  // ponytail: probe absent chip every 2s
  }
  Wire.beginTransmission(FT_ADDR);
  Wire.write(0x02);  // TD_STATUS
  if (Wire.endTransmission(false) != 0) {
    if (touchPresent) logLine("[TOUCH] FT6336 absent");
    touchPresent = false; return false;
  }
  if (Wire.requestFrom((uint8_t)FT_ADDR, (uint8_t)5) != 5) {
    if (touchPresent) logLine("[TOUCH] FT6336 absent");
    touchPresent = false; return false;
  }
  if (!touchPresent) logLine("[TOUCH] FT6336 present");
  touchPresent = true;
  uint8_t n = Wire.read() & 0x0F;
  uint8_t xh = Wire.read(), xl = Wire.read(), yh = Wire.read(), yl = Wire.read();
  if (n == 0) return false;
  x = ((xh & 0x0F) << 8) | xl;
  y = ((yh & 0x0F) << 8) | yl;
#if TOUCH_SWAP_XY
  int16_t t = x; x = y; y = t;
#endif
  x = map(x, 0, TOUCH_RAW_H, 0, 480);  // post-swap: raw x range is portrait height
  y = map(y, 0, TOUCH_RAW_W, 0, 320);
#if TOUCH_INV_X
  x = 479 - x;
#endif
#if TOUCH_INV_Y
  y = 319 - y;
#endif
  return true;
}

// ---- runtime config from the app ({screenOffMin} line, docs/firmware-v2.md) ----
// minutes on the wire, matching the app's pref; 0 = never sleep. Persisted to NVS.
static void applyConfigJson(const char* body) {
  JsonDocument doc;
  if (deserializeJson(doc, body)) return;
  uint32_t min = (uint32_t)(doc["screenOffMin"] | -1L);
  if (min == (uint32_t)-1L) return;
  uint32_t ms = min == 0 ? 0 : min * 60000UL;
  if (ms == screenOffMs) return;
  screenOffMs = ms;
  Preferences nvs;
  nvs.begin("tb", false);
  nvs.putUInt("soff", ms);
  nvs.end();
  if (!screenAsleep && screen == SCR_IDLE) { drawStatusIcons(); flush(); }  // refresh the moon badge live
  logLine(String("[CFG] screen off after ") + (min ? String(min) + "m" : String("never")));
}

// STATE write: {session,id,title,minutes,end} starts/heartbeats; {} (or no session) stops.
// end is unix ms on the wire.
static void applyStateJson(const char* body) {
  JsonDocument doc;
  if (deserializeJson(doc, body)) { logLine(String("[SER] bad state json: ") + String(body).substring(0, 60)); return; }
  const char* sid = doc["session"];
  if (!sid || !*sid) {  // app sent {} → session over
    if (haveSess) { logLine("[STATE] stop — session ended"); goIdle(); }
    return;
  }
  long long endMs = doc["end"] | 0LL;  // 13-digit unix ms — overflows 32-bit long on ESP32
  if (endMs <= 0) { logLine(String("[SER] dropped malformed state: ") + String(body).substring(0, 60)); return; }
  if (ignoredSess == sid) { lastBeacon = millis(); return; }
  bool isNew = !haveSess || sess.id != sid;
  sess.id = sid;
  sess.taskId = (const char*)(doc["id"] | "");
  sess.title = (const char*)(doc["title"] | "");
  sess.end = (long)(endMs / 1000);
  sess.minPlanned = doc["minutes"] | 0;
  haveSess = true;
  lastBeacon = millis();
  if (screenAsleep) wakeScreen();  // new timer lights the screen up
  if (isNew && screen == SCR_TIMER) drawTimer();  // new session while showing old one
  else if (screen != SCR_TIMER) { screen = SCR_TIMER; drawTimer(); }
  logLine(String("[STATE] s=") + sid + " end=" + sess.end + " '" + sess.title + "'");
}

// device → app event over serial (extend / logstop / complete). The "EVT "
// prefix keeps it parseable amid log lines; harmless if nothing is listening.
static void sendEvent(const char* evt) {
  Serial.printf("EVT %s\n", evt);
}

// ---- serial input: complete JSON lines, dispatched by shape ----
static void setClock(long long unixSecs) {
  if (unixSecs < 1700000000LL) return;  // pre-2023 = garbage, ignore
  long now = (long)time(NULL);
  if (now > 1700000000L && labs(now - (long)unixSecs) < 5) return;  // close enough
  struct timeval tv;
  tv.tv_sec = (time_t)unixSecs;
  tv.tv_usec = 0;
  settimeofday(&tv, NULL);
  logLine(String("[TIME] set from app: ") + (long)unixSecs);
  // idle screen was drawn without a clock (blank) — force it now
  if (!screenAsleep && screen == SCR_IDLE) drawIdle();
}

static void handleLine(char* line) {
  if (!strchr(line, '{')) return;
  JsonDocument doc;
  if (deserializeJson(doc, line)) return;
  if (doc["time"].is<long long>()) setClock(doc["time"]);  // rides along on state lines
  if (doc["screenOffMin"].is<long>()) { applyConfigJson(line); return; }
  if (doc["session"].is<const char*>() || doc.size() == 0) applyStateJson(line);  // {} = stop
}

static void serialPoll() {
  static char buf[512];
  static size_t n = 0;
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      buf[n] = 0;
      if (n) handleLine(buf);
      n = 0;
    } else if (n < sizeof(buf) - 1) buf[n++] = c;
    else n = 0;  // overflow — drop the line
  }
}

// ---- drawing ----
// status icons, bottom center: crescent moon with the screen-off minutes badge
// (* = never) — replaces the old text line
static void drawMoonIcon(int x, int y, uint16_t c) {
  gfx->fillCircle(x, y - 4, 5, c);
  gfx->fillCircle(x + 3, y - 6, 4, C_BG);
}
static void drawStatusIcons() {
  gfx->fillRect(0, 268, 480, 20, C_BG);
  drawMoonIcon(228, 282, C_DIM);
  text(screenOffMs ? String(screenOffMs / 60000) : String("*"), 242, 278, 1, C_DIM, C_BG);  // * = never
}

// touch feedback: accent bar under the pressed half — proves the touch
// registered and shows which zone it mapped to (diagnoses axis flips)
static int touchBarShown = -1;  // 0=left, 1=right, -1=none
static void drawTouchBar(int zone) {
  if (zone == touchBarShown) return;
  if (touchBarShown >= 0) gfx->fillRect(touchBarShown * 240, 312, 240, 6, C_BG);
  if (zone >= 0) gfx->fillRect(zone * 240, 312, 240, 6, C_ACCENT);
  touchBarShown = zone;
  flush();
}

static void drawIdle() {
  gfx->fillScreen(C_BG);
  lastMinuteShown = -1;
  lastHintS = -1;      // fillScreen wiped the hint
  touchBarShown = -1;  // fillScreen wiped the bar
  struct tm tm;
  if (getLocalTime(&tm, 0) && tm.tm_year >= 124) {
    char buf[8], dbuf[12];
    strftime(buf, sizeof(buf), "%H:%M", &tm);
    text(buf, 240, 110, 8, C_TEXT, C_BG, true);
    strftime(dbuf, sizeof(dbuf), "%a %b %d", &tm);
    text(dbuf, 240, 190, 2, C_MUTED, C_BG, true);
    lastMinuteShown = tm.tm_min;
  } else {
    text("no clock yet — connect from the app", 240, 152, 1, C_MUTED, C_BG, true);
  }
  text("waiting for timer...", 240, 292, 1, C_DIM, C_BG, true);
  drawStatusIcons();
  flush();
}

// pre-sleep hint: a few seconds of warning so a tap can still cancel it
static void drawSleepHint(int secs) {
  gfx->fillRect(0, 216, 480, 20, C_BG);
  text("screen off in " + String(secs) + "s — tap to stay awake", 240, 220, 1, C_MUTED, C_BG, true);
  flush();
}

static void updateIdleClock() {
  struct tm tm;
  if (!getLocalTime(&tm, 0) || tm.tm_year < 124 || tm.tm_min == lastMinuteShown) return;
  static bool timeLogged = false;
  if (!timeLogged) {
    timeLogged = true;
    char b[40];
    strftime(b, sizeof(b), "%Y-%m-%d %H:%M:%S %Z", &tm);
    logLine(String("[TIME] synced: ") + b + " epoch=" + (long)time(NULL));
  }
  lastMinuteShown = tm.tm_min;
  char buf[8], dbuf[12];
  strftime(buf, sizeof(buf), "%H:%M", &tm);
  gfx->fillRect(0, 100, 480, 80, C_BG);
  text(buf, 240, 110, 8, C_TEXT, C_BG, true);
  strftime(dbuf, sizeof(dbuf), "%a %b %d", &tm);
  gfx->fillRect(0, 185, 480, 24, C_BG);
  text(dbuf, 240, 190, 2, C_MUTED, C_BG, true);
  flush();
}

static void drawDigits() {
  long left = sess.end - (long)time(NULL);
  if (left == lastShownS) return;
  lastShownS = left;
  // manual MM:SS — GCC 8.4's -Werror=format-truncation can't prove snprintf is
  // bounded here, so build the (capped) 6-char string by hand instead
  bool neg = left < 0;
  long s = neg ? -left : left;
  if (s > 5999) s = 5999;  // cap 99:59
  int mm = (int)(s / 60), ss = (int)(s % 60);
  char buf[8];
  char* p = buf;
  if (neg) *p++ = '+';
  *p++ = char('0' + mm / 10); *p++ = char('0' + mm % 10);
  *p++ = ':';
  *p++ = char('0' + ss / 10); *p++ = char('0' + ss % 10);
  *p = 0;
  gfx->fillRect(20, 96, 440, 112, C_BG);
  text(buf, 240, 104, 12, left < 0 ? C_ACCENT : C_TEXT, C_BG, true);
  flush();
}

static void drawTimer() {
  gfx->fillScreen(C_BG);
  lastShownS = -1;
  touchBarShown = -1;  // fillScreen wiped the bar
  String title = sess.title;
  while (title.length() && title.length() * 12 > 460) title.remove(title.length() - 1);
  text(title, 240, 36, 2, C_MUTED, C_BG, true);
  text("hold = log & stop", 120, 298, 1, C_DIM, C_BG, true);
  text("tap +5 / hold = done", 360, 298, 1, C_DIM, C_BG, true);
  drawDigits();
  flush();
}

// ---- state changes ----
static void goIdle() {
  haveSess = false;
  screen = SCR_IDLE;
  drawIdle();
}

static void doExtend() {
  sess.end += EXTEND_S;
  sendEvent("extend");  // app applies extend(5) on the notification
  drawDigits();
}

static void doLogStop() {
  sendEvent("logstop");  // app logs & exits through its own logAndExit(false)
  ignoredSess = sess.id;
  text("logged & stopped", 240, 220, 2, C_ACCENT, C_BG, true);
  flush();
  delay(800);
  goIdle();
}

// right-half hold: app logs as completed and closes the task itself
// (it owns the close/move pref and posts the ✓ completed comment — no TLS here)
static void doComplete() {
  sendEvent("complete");
  ignoredSess = sess.id;
  text("marked complete", 240, 220, 2, C_ACCENT, C_BG, true);
  flush();
  delay(800);
  goIdle();
}

// ---- touch gestures: left hold = log & stop, right tap = +5, right hold = complete ----
static bool wasDown = false;
static uint32_t downAt = 0;
static int downX = 0;
static bool holdFired = false;

static void handleTouch(bool down, int16_t x) {
  if (down) lastTouchMs = millis();
  if (down && !wasDown) { downAt = millis(); downX = x; holdFired = false; logLine(String("[TOUCH] down x=") + x + (screen == SCR_TIMER ? " (timer)" : " (idle)")); }
  // wake tap is swallowed: waking the screen must not fire a gesture
  if (screenAsleep) { if (down) wakeScreen(); wasDown = down; return; }
  // visible feedback: accent bar under the half your finger mapped to
  drawTouchBar(down ? (x < 240 ? 0 : 1) : -1);
  if (screen != SCR_TIMER) { wasDown = down; return; }
  if (down && !holdFired && millis() - downAt >= 1000) {
    holdFired = true;
    if (downX < 240) doLogStop();   // left hold = log & stop
    else doComplete();              // right hold = mark complete
  } else if (!down && wasDown && !holdFired && downX >= 240 && millis() - downAt < 1000) {
    doExtend();                     // right tap = +5
  }
  wasDown = down;
}

// LCD reset line is on TCA9554 IO expander pin 0 (dash_35 DashboardDisplay::begin).
static void lcdReset() {
  Wire.begin(PIN_SDA, PIN_SCL);
  // ponytail: assumes power-on defaults (all inputs, outputs 0xFF) — fine here.
  Wire.beginTransmission(0x20); Wire.write(0x03); Wire.write(0xFE); Wire.endTransmission();  // pin0 output
  for (uint8_t v : {0xFF, 0xFE, 0xFF}) {
    Wire.beginTransmission(0x20); Wire.write(0x01); Wire.write(v); Wire.endTransmission();
    delay(v == 0xFE ? 10 : 200);  // high, 10ms low pulse, high+settle
  }
}

// ---- Arduino ----
void setup() {
  Serial.setRxBufferSize(1024);  // state lines with long titles exceed the 256B default
  Serial.begin(115200);
  delay(300);  // let the UART settle so the banner isn't lost
  Serial.printf("[BOOT] psramFound=%d psramSize=%u freeHeap=%u freePsram=%u\n",
    psramFound(), (unsigned)ESP.getPsramSize(), (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getFreePsram());
  Preferences nvs;  // last app-pushed config survives reboots
  nvs.begin("tb", true);
  screenOffMs = nvs.getUInt("soff", SCREEN_OFF_MS);
  nvs.end();
  // observable at boot: NVS persists across flashes — a stored 0 ("never")
  // would silently disable the timeout, so say what we actually loaded
  logLine(String("[CFG] screen off after ") + (screenOffMs ? String(screenOffMs / 60000) + "m" : String("never")));
  lcdReset();
  // touch chip is held in reset by the expander at power-on — release all pins high
  Wire.beginTransmission(0x20); Wire.write(0x03); Wire.write(0x00); Wire.endTransmission();
  Wire.beginTransmission(0x20); Wire.write(0x01); Wire.write(0xFF); Wire.endTransmission();
  delay(50);
  if (!gfx->begin(40000000)) Serial.println("[LCD] panel begin failed");
  panel = (Arduino_ST7796 *)gfx;  // keep panel handle before gfx may become the canvas
  gfx->setRotation(1);
  pinMode(25, OUTPUT);       // backlight (dash_35 kBacklightPin)
  digitalWrite(25, HIGH);
  cv = new Arduino_Canvas(480, 320, gfx);
  if (cv->begin(GFX_SKIP_OUTPUT_BEGIN)) { gfx = cv; Serial.printf("[LCD] canvas OK, freePsram=%u freeHeap=%u\n", (unsigned)ESP.getFreePsram(), (unsigned)ESP.getFreeHeap()); }
  else { delete cv; cv = nullptr; Serial.printf("[LCD] canvas FAILED (direct draws = flicker) freePsram=%u freeHeap=%u\n", (unsigned)ESP.getFreePsram(), (unsigned)ESP.getFreeHeap()); }
  gfx->fillScreen(C_BG);
  text("connecting WiFi...", 240, 152, 2, C_MUTED, C_BG, true);
  flush();
  // WiFi for NTP only (normal-clock duty with the app closed). Non-blocking:
  // the app can also push {time} over serial if the network is down.
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  WiFi.setSleep(false);  // ponytail: DTIM power-save drops packets and jitters the loop
  configTzTime(TZ_POSIX, "pool.ntp.org", "time.nist.gov");
  MDNS.begin("timebox");  // timebox.local — discovery for whatever comes later
  logLine("[SER] ready — waiting for app over USB serial");
  drawIdle();
}

void loop() {
  serialPoll();

  if (WiFi.status() != WL_CONNECTED) {  // NTP clock duty only; cheap check
    static uint32_t lastTry = 0;
    if (millis() - lastTry > 15000) { lastTry = millis(); WiFi.disconnect(); WiFi.begin(WIFI_SSID, WIFI_PASS); }
  }

  int16_t tx, ty;
  handleTouch(readTouch(tx, ty), tx);

  if (screen == SCR_IDLE) {
    updateIdleClock();
    // screen sleep on the idle clock only; a running timer stays lit (0 = never)
    if (screenOffMs && !screenAsleep) {
      uint32_t idle = millis() - lastTouchMs;
      if (idle >= screenOffMs) { sleepScreen(); lastHintS = -1; }
      else if (idle >= screenOffMs - 5000) {  // 5s warning, tap cancels via lastTouchMs
        int s = (int)((screenOffMs - idle + 999) / 1000);
        if (s != lastHintS) { lastHintS = s; drawSleepHint(s); }
      } else if (lastHintS >= 0) {  // woke during the warning window — clear it
        lastHintS = -1;
        gfx->fillRect(0, 216, 480, 20, C_BG);
        flush();
      }
    }
  } else {
    drawDigits();
    if (millis() - lastBeacon > BEACON_TIMEOUT_MS) {
      Serial.println("[STATE] heartbeat timeout — back to idle");
      goIdle();
    }
  }
  delay(20);
}
