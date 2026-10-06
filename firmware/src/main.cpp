// ESP32 Timebox Companion v2 — triggered countdown display, see ../docs/firmware-v2.md.
// Idle clock until the app starts a timer; the app drives it directly over HTTP.
// Left hold = log & stop, right tap = +5 min, right hold = mark complete (mirrors the web app).
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiServer.h>
#include <ESPmDNS.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Arduino_GFX_Library.h>
#include <Wire.h>
#include <Preferences.h>
#include "config.h"
#include "secrets.h"

// pins from esp32-drive-orbit dash_35 (dashboard_display.cpp)
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

// ---- session state (driven by beacons) ----
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

// ---- HTTP server on port 4242: the app drives the device directly ----
// POST /state {session,id,title,minutes,end} · DELETE /state · POST /config
// {screenOffMin} · GET /events (JSON array, drains) · GET /logs (ring buffer).
// CORS * + PNA so a browser page on localhost / a LAN IP can call it.
static WiFiServer httpSrv(HTTP_PORT);
static String httpBody;   // body of the in-flight request (state/config handlers read it)

// device → app events (extend / logstop / complete), drained by GET /events
#define EVENT_SLOTS 8
static String eventBuf[EVENT_SLOTS];
static int eventHead = 0;

// log ring (GET /logs) — simplest OTA visibility without serial
#define LOG_LINES 24
static String logBuf[LOG_LINES];
static int logHead = 0;
static void logLine(const String& s) {
  Serial.println(s);
  logBuf[logHead] = s;
  logHead = (logHead + 1) % LOG_LINES;
}

static void drawTimer();        // defined below, used by serveHttp
static void drawIdle();         // defined below, used by wakeScreen
static void goIdle();           // defined below, used by serveHttp (DELETE /state)
static void drawStatusIcons();  // defined below, used by applyConfig

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

// ---- runtime config from the app (POST /config {screenOffMin}, docs/firmware-v2.md) ----
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

// POST/DELETE /state {session,id,title,minutes,end} — end is unix ms on the wire
static void applyStateJson(const char* body) {
  JsonDocument doc;
  if (deserializeJson(doc, body)) { logLine(String("[HTTP] bad /state json: ") + String(body).substring(0, 60)); return; }
  const char* sid = doc["session"];
  long long endMs = doc["end"] | 0LL;  // 13-digit unix ms — overflows 32-bit long on ESP32
  if (!sid || !*sid || endMs <= 0) { logLine(String("[HTTP] dropped malformed /state: ") + String(body).substring(0, 60)); return; }
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

// device → app event: buffered, drained by the app's GET /events poll
static void sendEvent(const char* json) {
  eventBuf[eventHead] = String("{\"type\":") + json + ",\"session\":\"" + sess.id + "\"}";
  eventHead = (eventHead + 1) % EVENT_SLOTS;
  Serial.printf("[EVENT] queued %s\n", json);
}

// ---- minimal HTTP/1.0 server: request line → optional body → dispatch ----
static void httpReply(WiFiClient& c, const char* status, const char* ctype, const String& body) {
  c.printf("HTTP/1.0 %s\r\nContent-Type: %s\r\nContent-Length: %d\r\n"
           "Access-Control-Allow-Origin: *\r\n"
           "Access-Control-Allow-Methods: GET,POST,DELETE,OPTIONS\r\n"
           "Access-Control-Allow-Headers: content-type\r\n"
           "Access-Control-Allow-Private-Network: true\r\n"
           "Connection: close\r\n\r\n", status, ctype, (int)body.length());
  c.print(body);
}
static void serveHttp() {
  WiFiClient c = httpSrv.available();
  if (!c || !c.connected()) return;
  c.setTimeout(5000);  // generous: WiFi pre-tasks can starve loop() past 1s
  String line = c.readStringUntil('\n'); line.trim();  // "METHOD /path HTTP/1.1"
  int sp1 = line.indexOf(' '), sp2 = line.indexOf(' ', sp1 + 1);
  if (sp1 < 0 || sp2 < 0) { c.stop(); return; }
  String method = line.substring(0, sp1), path = line.substring(sp1 + 1, sp2);
  int contentLen = 0;
  while (true) {  // headers
    String h = c.readStringUntil('\n'); h.trim();
    if (!h.length()) break;
    if (h.startsWith("Content-Length:") || h.startsWith("content-length:"))
      contentLen = h.substring(15).toInt();
  }
  if (method == "OPTIONS") { httpReply(c, "204 No Content", "text/plain", ""); c.flush(); c.stop(); return; }
  httpBody = "";
  if (contentLen > 0 && contentLen <= 2048) {
    httpBody.reserve(contentLen);
    while ((int)httpBody.length() < contentLen && c.connected()) {
      int a = c.available();
      if (a) { httpBody += (char)c.read(); }
      else delay(1);
    }
  }
  if (path == "/state" && method == "POST") { applyStateJson(httpBody.c_str()); httpReply(c, "200 OK", "text/plain", "ok"); }
  else if (path == "/state" && method == "DELETE") {
    if (haveSess) { logLine("[STATE] DELETE — session ended"); goIdle(); }
    httpReply(c, "200 OK", "text/plain", "ok");
  }
  else if (path == "/config" && method == "POST") { applyConfigJson(httpBody.c_str()); httpReply(c, "200 OK", "text/plain", "ok"); }
  else if (path == "/events" && method == "GET") {
    String out = "[";
    bool first = true;
    for (int i = 0; i < EVENT_SLOTS; i++) {
      int idx = (eventHead + i) % EVENT_SLOTS;  // oldest→newest
      if (eventBuf[idx].length()) { if (!first) out += ","; out += eventBuf[idx]; eventBuf[idx] = ""; first = false; }
    }
    out += "]";
    httpReply(c, "200 OK", "application/json", out);
  }
  else if (path == "/logs" && method == "GET") {
    String out;
    for (int i = 0; i < LOG_LINES; i++) {
      const String& l = logBuf[(logHead + i) % LOG_LINES];
      if (l.length()) { out += l; out += "\n"; }
    }
    httpReply(c, "200 OK", "text/plain", out);
  }
  else if (path == "/health" && method == "GET") httpReply(c, "200 OK", "text/plain", "ok");
  else httpReply(c, "404 Not Found", "text/plain", "nope");
  c.flush();
  c.stop();
}

// ---- Todoist comment (log & stop) ----
// ponytail: runs on a bg task — TLS handshake can block for seconds and
// froze the countdown when done synchronously. Failure is visible in Todoist.
static void commentTaskBg(void* p) {
  String payload = *(String*)p;  // "taskId|plannedMin|actualMin"
  delete (String*)p;
  int a = payload.indexOf('|'), b = payload.indexOf('|', a + 1);
  String taskId = payload.substring(0, a);
  int planned = payload.substring(a + 1, b).toInt();
  int actual = payload.substring(b + 1).toInt();
  if (WiFi.status() != WL_CONNECTED) { vTaskDelete(NULL); return; }
  // same format as sessionComment() in src/App.tsx
  struct tm tm;
  getLocalTime(&tm, 0);
  JsonDocument doc;
  doc["task_id"] = taskId;
  char content[96];
  snprintf(content, sizeof(content), "\xE2\x8F\xB1 %d/%d \xC2\xB7 planned %dm \xC2\xB7 actual %dm \xC2\xB7 abandoned",
           tm.tm_mon + 1, tm.tm_mday, planned, actual);
  doc["content"] = content;
  String body;
  serializeJson(doc, body);
  WiFiClientSecure c;
  c.setInsecure();
  HTTPClient http;
  if (http.begin(c, "https://api.todoist.com/api/v1/comments")) {
    http.addHeader("Authorization", "Bearer " TODOIST_TOKEN);
    http.addHeader("Content-Type", "application/json");
    http.setTimeout(8000);
    int code = http.POST(body);
    Serial.printf("[API] POST /comments -> %d\n", code);
  }
  http.end();
  vTaskDelete(NULL);
}

// ---- drawing ----
// status icons, bottom center: wifi fan (accent = disconnected) + crescent moon
// with the screen-off minutes badge (∞ = never) — replaces the old text line
static void drawWifiIcon(int x, int y, uint16_t c) {
  for (int i = 0; i < 3; i++) {
    int r = 4 + i * 3;
    for (int a = 25; a <= 155; a += 3) {
      float rad = a * 0.0174533f;
      gfx->fillCircle(x + (int)(r * cosf(rad)), y - (int)(r * sinf(rad)), 1, c);
    }
  }
  gfx->fillCircle(x, y - 1, 2, c);
}
static void drawMoonIcon(int x, int y, uint16_t c) {
  gfx->fillCircle(x, y - 4, 5, c);
  gfx->fillCircle(x + 3, y - 6, 4, C_BG);
}
static void drawStatusIcons() {
  gfx->fillRect(0, 268, 480, 20, C_BG);
  gfx->fillRect(0, 304, 480, 10, C_BG);  // the IP readout zone
  drawWifiIcon(200, 282, WiFi.status() == WL_CONNECTED ? C_DIM : C_ACCENT);
  drawMoonIcon(244, 282, C_DIM);
  text(screenOffMs ? String(screenOffMs / 60000) : String("*"), 258, 278, 1, C_DIM, C_BG);  // * = never
  // small IP, bottom right — so you know what to ping (subnet moves happen)
  if (WiFi.status() == WL_CONNECTED)
    text(WiFi.localIP().toString(), 470 - WiFi.localIP().toString().length() * 6, 306, 1, C_DIM, C_BG);
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
  char buf[10];
  if (left >= 0) snprintf(buf, sizeof(buf), "%02ld:%02ld", left / 60, left % 60);
  else {
    long ov = -left;
    if (ov > 5999) ov = 5999;  // ponytail: cap +99:59, 6 chars at size 12 = 432px
    snprintf(buf, sizeof(buf), "+%ld:%02ld", ov / 60, ov % 60);
  }
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
  sendEvent("\"extend\",\"minutes\":5");  // app applies the same extend(5) on its next poll
  drawDigits();
}

static void doLogStop() {
  sendEvent("\"logstop\"");  // app logs & exits through its own logAndExit(false)
  long started = sess.end - (long)sess.minPlanned * 60;
  int actual = (int)(((long)time(NULL) - started + 30) / 60);
  if (actual < 0) actual = 0;
  String* payload = new String(sess.taskId + "|" + sess.minPlanned + "|" + actual);
  xTaskCreate(commentTaskBg, "comment", 12288, payload, 1, NULL);
  ignoredSess = sess.id;
  text("logged & stopped", 240, 220, 2, C_ACCENT, C_BG, true);
  flush();
  delay(800);
  goIdle();
}

// right-half hold: app logs as completed and closes the task itself
// (it owns the close/move pref and posts the ✓ completed comment — no TLS here)
static void doComplete() {
  sendEvent("\"complete\"");
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

static void wifiEnsure() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  WiFi.setSleep(false);
}

// ---- Arduino ----
void setup() {
  Serial.begin(115200);
  Preferences nvs;  // last app-pushed config survives reboots
  nvs.begin("tb", true);
  screenOffMs = nvs.getUInt("soff", SCREEN_OFF_MS);
  nvs.end();
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
  if (cv->begin(GFX_SKIP_OUTPUT_BEGIN)) gfx = cv;
  else { delete cv; cv = nullptr; }  // ponytail: no PSRAM → direct draws, some flicker
  gfx->fillScreen(C_BG);
  text("connecting WiFi...", 240, 152, 2, C_MUTED, C_BG, true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  WiFi.setSleep(false);  // ponytail: DTIM power-save drops buffered packets (beacons!)
  uint32_t t = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t < 15000) delay(250);
  Serial.printf("[BOOT] wifi status=%d ip=%s\n", WiFi.status(), WiFi.localIP().toString().c_str());
  configTzTime(TZ_POSIX, "pool.ntp.org", "time.nist.gov");
  httpSrv.begin();
  Serial.println("[BOOT] http up, starting mDNS");
  // advertise timebox.local so the app can reach us without any IP config
  if (MDNS.begin("timebox")) {
    MDNS.addService("http", "tcp", HTTP_PORT);
    logLine("[MDNS] timebox.local up");
  } else {
    logLine("[MDNS] begin failed");
  }
  Serial.printf("[HTTP] listening on %d\n", HTTP_PORT);
  logLine(String("[NET] ip=") + WiFi.localIP().toString() + " gw=" + WiFi.gatewayIP().toString() +
          " rssi=" + WiFi.RSSI());
  drawIdle();
}

void loop() {
  wifiEnsure();
  serveHttp();

  int16_t tx, ty;
  handleTouch(readTouch(tx, ty), tx);

  if (screen == SCR_IDLE) {
    // live wifi hint: redraw the status icons when the link state flips
    static int wifiShown = -1;
    int up = WiFi.status() == WL_CONNECTED ? 1 : 0;
    if (up != wifiShown) { wifiShown = up; drawStatusIcons(); flush(); }
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
