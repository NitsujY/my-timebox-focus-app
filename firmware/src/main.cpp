// ESP32 Timebox Companion — see DESIGN.md. List screen (clock + Focus tasks)
// and timer screen (ring + MM:SS). Todoist REST API v1 direct; no backend.
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Arduino_GFX_Library.h>
#include <Preferences.h>
#include <Wire.h>
#include "config.h"
#include "secrets.h"

// pins from esp32-drive-orbit dash_35 (dashboard_display.cpp)
static Arduino_DataBus *bus = new Arduino_ESP32SPI(27 /*DC*/, 5 /*CS*/, 18 /*SCK*/, 23 /*MOSI*/, 19 /*MISO*/);
static Arduino_GFX *gfx = new Arduino_ST7796(bus, GFX_NOT_DEFINED /*RST via TCA9554*/, 0, true /*ips*/);
static WiFiClientSecure tls;

// theme, mirrors web app
#define C565(r, g, b) (uint16_t)((((r) & 0xF8) << 8) | (((g) & 0xFC) << 3) | ((b) >> 3))
static const uint16_t C_BG = C565(9, 9, 11),      C_CARD = C565(24, 24, 27),
                      C_BORDER = C565(39, 39, 42), C_ACCENT = C565(249, 115, 22),
                      C_TEXT = C565(244, 244, 245), C_MUTED = C565(113, 113, 122),
                      C_DIM = C565(82, 82, 91),    C_CHIP_TX = C565(161, 161, 170);

// Adafruit-font text helper: size s chars are 6*s wide, 8*s tall. center=true → x is center.
static void text(const String& s, int x, int y, uint8_t size, uint16_t fg, uint16_t bg, bool center = false) {
  gfx->setTextSize(size);
  gfx->setTextColor(fg, bg);
  gfx->setCursor(center ? x - (int)s.length() * 6 * size / 2 : x, y);
  gfx->print(s);
}

struct Task { String id, content; int durMin; };
static Task tasks[3];
static int taskCount = 0;
static String focusSectionId;
static Preferences prefs;
static String projectId;  // NVS override, falls back to TODOIST_PROJECT_ID

// ponytail: picker shows first 5 projects, no scroll — raise if you have more.
struct Proj { String id, name; };
static Proj projects[5];
static int projectCount = 0;

static int sel = -1;
static int minutes = 25;
static const int DURATIONS[] = {5, 10, 15, 25, 50, 90};

enum Screen { SCR_LIST, SCR_TIMER, SCR_PROJECTS };
static Screen screen = SCR_LIST;
static long totalS = 0, leftS = 0;
static bool paused = false;
static uint32_t lastSec = 0, lastSync = 0;
static int lastMinuteShown = -1, shownSpan = -1;

// ---- layout (480x320 landscape) ----
#define LABEL_Y   74
#define TASK_X    12
#define TASK_W    456
#define TASK_H    52
#define TASK_Y0   88
#define TASK_GAP  8
#define BAR_Y     268
#define BAR_H     36
#define BACK_X    12
#define BACK_W    40
#define CHIP_X0   64
#define CHIP_W    54
#define CHIP_GAP  8
// timer
#define RING_CX   240
#define RING_CY   118
#define RING_R    88
#define RING_IR   74
#define PLUS_X    128
#define BTN_Y     262
#define PLUS_W    90
#define LOG_X     228
#define LOG_W     124
#define BTN_H     38
#define MAX_MIN   99  // ponytail: font-7 MM:SS stays 2-digit; +5 caps here

static bool inRect(int x, int y, int rx, int ry, int rw, int rh) {
  return x >= rx && x < rx + rw && y >= ry && y < ry + rh;
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
  if (Wire.endTransmission(false) != 0) { touchPresent = false; return false; }
  if (Wire.requestFrom((uint8_t)FT_ADDR, (uint8_t)5) != 5) { touchPresent = false; return false; }
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

// ---- Todoist API v1 ----
static int apiGet(const String& path, JsonDocument& doc, JsonDocument& filter) {
  HTTPClient http;
  if (!http.begin(tls, "https://api.todoist.com" + path)) return -1;
  http.addHeader("Authorization", "Bearer " TODOIST_TOKEN);
  int code = http.GET();
  Serial.printf("[API] GET %s -> %d\n", path.c_str(), code);
  if (code == 200 && deserializeJson(doc, http.getStream(),
                                     DeserializationOption::Filter(filter)))
    code = -2;
  http.end();
  return code;
}

// ponytail: ignores next_cursor pagination — first page is plenty for a Focus list.
static bool syncTasks() {
  JsonDocument doc, filter;
  if (focusSectionId.isEmpty()) {
    filter["results"][0]["id"] = true;
    filter["results"][0]["name"] = true;
    if (apiGet("/api/v1/sections?project_id=" + projectId, doc, filter) != 200)
      return false;
    for (JsonObject s : doc["results"].as<JsonArray>())
      if (String(s["name"].as<const char*>()).equalsIgnoreCase("Focus")) {
        focusSectionId = s["id"].as<String>();
        break;
      }
    if (focusSectionId.isEmpty()) { Serial.println("[API] no Focus section found"); return false; }
  }
  filter.clear();
  filter["results"][0]["id"] = true;
  filter["results"][0]["content"] = true;
  filter["results"][0]["section_id"] = true;
  filter["results"][0]["duration"]["amount"] = true;
  filter["results"][0]["duration"]["unit"] = true;
  if (apiGet("/api/v1/tasks?project_id=" + projectId, doc, filter) != 200)
    return false;
  taskCount = 0;
  for (JsonObject t : doc["results"].as<JsonArray>()) {
    if (focusSectionId != t["section_id"].as<const char*>()) continue;
    if (taskCount == 3) break;
    tasks[taskCount].id = t["id"].as<String>();
    tasks[taskCount].content = t["content"].as<String>();
    int d = -1;
    if (!t["duration"].isNull()) {
      int amt = t["duration"]["amount"];
      const char* unit = t["duration"]["unit"] | "";
      d = unit[0] == 'd' ? amt * 1440 : amt;  // day or minute
    }
    tasks[taskCount].durMin = d;
    taskCount++;
  }
  return true;
}

static bool fetchProjects() {
  JsonDocument doc, filter;
  filter["results"][0]["id"] = true;
  filter["results"][0]["name"] = true;
  if (apiGet("/api/v1/projects", doc, filter) != 200) return false;
  projectCount = 0;
  for (JsonObject p : doc["results"].as<JsonArray>()) {
    if (projectCount == 5) break;
    projects[projectCount].id = p["id"].as<String>();
    projects[projectCount].name = p["name"].as<String>();
    projectCount++;
  }
  return true;
}

static void closeTask(const String& id) {
  HTTPClient http;
  if (http.begin(tls, "https://api.todoist.com/api/v1/tasks/" + id + "/close")) {
    http.addHeader("Authorization", "Bearer " TODOIST_TOKEN);
    http.POST("");  // ponytail: fire-and-forget; a failed close is visible in Todoist
  }
  http.end();
}

// ---- drawing ----
static void drawClock() {
  struct tm tm;
  if (!getLocalTime(&tm, 0) || tm.tm_year < 124) return;  // NTP not synced yet
  if (tm.tm_min == lastMinuteShown) return;
  lastMinuteShown = tm.tm_min;
  char buf[12];
  strftime(buf, sizeof(buf), "%H:%M", &tm);
  gfx->fillRect(0, 8, 300, 64, C_BG);
  text(buf, 18, 16, 8, C_TEXT, C_BG);
  strftime(buf, sizeof(buf), "%a %b %d", &tm);
  gfx->fillRect(320, 30, 142, 20, C_BG);
  text(buf, 462 - (int)strlen(buf) * 12, 33, 2, C_MUTED, C_BG);
}

static void drawTaskRow(int i) {
  int y = TASK_Y0 + i * (TASK_H + TASK_GAP);
  bool s = i == sel, dim = sel >= 0 && !s;
  uint16_t fg = dim ? C_MUTED : C_TEXT;
  gfx->fillRoundRect(TASK_X, y, TASK_W, TASK_H, 10, C_CARD);
  gfx->drawRoundRect(TASK_X, y, TASK_W, TASK_H, 10, s ? C_ACCENT : C_BORDER);
  if (s) gfx->drawRoundRect(TASK_X + 1, y + 1, TASK_W - 2, TASK_H - 2, 9, C_ACCENT);
  int bx = TASK_X + 14, by = y + (TASK_H - 22) / 2;
  if (s) gfx->fillRoundRect(bx, by, 22, 22, 6, C_ACCENT);
  else   gfx->drawRoundRect(bx, by, 22, 22, 6, C_DIM);
  String title = tasks[i].content;
  while (title.length() && title.length() * 18 > 310) title.remove(title.length() - 1);  // size-3 char = 18px
  if (title != tasks[i].content) { title.remove(title.length() - 3); title += "..."; }
  text(title, bx + 36, y + TASK_H / 2 - 10, 3, fg, C_CARD);
  if (tasks[i].durMin > 0) {
    char d[8];
    sprintf(d, "%dm", tasks[i].durMin);
    text(d, TASK_X + TASK_W - 14 - (int)strlen(d) * 12, y + TASK_H / 2 - 7, 2, C_MUTED, C_CARD);
  }
}

static void drawBar() {
  gfx->fillRect(0, BAR_Y - 6, 480, 320 - BAR_Y + 6, C_BG);
  if (sel < 0) {
    text("tap a task to focus", 240, BAR_Y + BAR_H / 2 - 7, 2, C_DIM, C_BG, true);
    return;
  }
  gfx->drawRoundRect(BACK_X, BAR_Y, BACK_W, BAR_H, 8, C_BORDER);
  text("<-", BACK_X + BACK_W / 2, BAR_Y + BAR_H / 2 - 7, 2, C_MUTED, C_BG, true);
  for (int i = 0; i < 6; i++) {
    int x = CHIP_X0 + i * (CHIP_W + CHIP_GAP);
    bool on = DURATIONS[i] == minutes;
    gfx->fillRoundRect(x, BAR_Y, CHIP_W, BAR_H, 18, on ? C_ACCENT : C_CARD);
    gfx->drawRoundRect(x, BAR_Y, CHIP_W, BAR_H, 18, on ? C_ACCENT : C_BORDER);
    text(String(DURATIONS[i]) + "m", x + CHIP_W / 2, BAR_Y + BAR_H / 2 - 7, 2,
         on ? C_BG : C_CHIP_TX, on ? C_ACCENT : C_CARD, true);
  }
}

static void drawList() {
  gfx->fillScreen(C_BG);
  lastMinuteShown = -1;
  drawClock();
  text("FOCUS - PICK A TASK", 18, LABEL_Y, 2, C_MUTED, C_BG);
  if (taskCount == 0)
    text("no tasks in Focus section", 240, 163, 2, C_MUTED, C_BG, true);
  for (int i = 0; i < taskCount; i++) drawTaskRow(i);
  drawBar();
}

// ring fills clockwise from top; wedge = dots along radius midpoint (RING_R+RING_IR)/2.
// ponytail: chunky dotted ring instead of a smooth arc — no arc primitive in Arduino_GFX.
static void ringWedge(int fromDeg, int toDeg, uint16_t color) {
  for (int a = fromDeg; a < toDeg; a += 2) {
    float rad = (a - 90) * 0.0174533f;
    gfx->fillCircle(RING_CX + (int)(81 * cosf(rad)), RING_CY + (int)(81 * sinf(rad)), 7, color);
  }
}

static void drawRemain() {
  char buf[8];
  sprintf(buf, "%02ld:%02ld", leftS / 60, leftS % 60);
  gfx->fillRect(RING_CX - 76, RING_CY - 20, 152, 40, C_BG);
  text(buf, RING_CX, RING_CY - 18, 5, paused ? C_ACCENT : C_TEXT, C_BG, true);
}

static void updateRing() {
  int span = leftS <= 0 ? 360 : (int)((1.0f - (float)leftS / totalS) * 360);
  if (span < shownSpan) {  // +5 pressed: erase back to track
    ringWedge(span, shownSpan, C_CARD);
  } else if (span > shownSpan) {
    ringWedge(shownSpan < 0 ? 0 : shownSpan, span, C_ACCENT);
  }
  shownSpan = span;
  drawRemain();
}

static void drawTimer() {
  gfx->fillScreen(C_BG);
  shownSpan = 0;
  ringWedge(0, 360, C_CARD);  // track
  updateRing();
  String title = sel >= 0 ? tasks[sel].content : "";
  while (title.length() && title.length() * 12 > 400) title.remove(title.length() - 1);
  text(title, 240, 225, 2, C_CHIP_TX, C_BG, true);
  gfx->fillRoundRect(PLUS_X, BTN_Y, PLUS_W, BTN_H, 10, C_CARD);
  gfx->drawRoundRect(PLUS_X, BTN_Y, PLUS_W, BTN_H, 10, C_BORDER);
  text("+5 min", PLUS_X + PLUS_W / 2, BTN_Y + BTN_H / 2 - 7, 2, C_TEXT, C_CARD, true);
  gfx->fillRoundRect(LOG_X, BTN_Y, LOG_W, BTN_H, 10, C_ACCENT);
  text("Log & exit", LOG_X + LOG_W / 2, BTN_Y + BTN_H / 2 - 7, 2, C_BG, C_ACCENT, true);
  text("tap background = pause/resume", 240, 306, 1, C_DIM, C_BG, true);
}

static void drawProjects() {
  gfx->fillScreen(C_BG);
  text("PICK A PROJECT", 18, LABEL_Y, 2, C_MUTED, C_BG);
  for (int i = 0; i < projectCount; i++) {
    int y = TASK_Y0 + i * (TASK_H + TASK_GAP);
    bool cur = projects[i].id == projectId;
    gfx->fillRoundRect(TASK_X, y, TASK_W, TASK_H, 10, C_CARD);
    gfx->drawRoundRect(TASK_X, y, TASK_W, TASK_H, 10, cur ? C_ACCENT : C_BORDER);
    text(projects[i].name, TASK_X + 14, y + TASK_H / 2 - 10, 3, C_TEXT, C_CARD);
  }
  gfx->drawRoundRect(BACK_X, BAR_Y, BACK_W, BAR_H, 8, C_BORDER);
  text("<-", BACK_X + BACK_W / 2, BAR_Y + BAR_H / 2 - 7, 2, C_MUTED, C_BG, true);
}

// ---- state changes ----
static void syncAndRefresh() {
  String selId = sel >= 0 ? tasks[sel].id : "";
  bool ok = syncTasks();
  lastSync = millis();
  if (!ok && taskCount == 0) {
    gfx->fillScreen(C_BG);
    lastMinuteShown = -1;
    drawClock();
    text("sync failed — check WiFi/token/Focus section", 240, 163, 2, C_MUTED, C_BG, true);
    return;
  }
  if (sel >= 0 && (sel >= taskCount || tasks[sel].id != selId)) sel = -1;
  drawList();
}

static void startTimer() {
  totalS = leftS = (long)minutes * 60;
  paused = false;
  screen = SCR_TIMER;
  lastSec = millis();
  drawTimer();
}

static void exitTimer(bool closeIt) {
  if (closeIt && sel >= 0) closeTask(tasks[sel].id);
  sel = -1;
  screen = SCR_LIST;
  syncAndRefresh();
}

static void handleListTap(int x, int y) {
  if (inRect(x, y, 300, 0, 180, 64)) {  // tap date = project picker
    if (fetchProjects() && projectCount > 0) {
      screen = SCR_PROJECTS;
      drawProjects();
    }
    return;
  }
  for (int i = 0; i < taskCount; i++)
    if (inRect(x, y, TASK_X, TASK_Y0 + i * (TASK_H + TASK_GAP), TASK_W, TASK_H)) {
      if (sel == i) { startTimer(); return; }
      sel = i;
      minutes = tasks[i].durMin > 0 ? tasks[i].durMin : 25;
      drawList();
      return;
    }
  if (sel < 0) return;
  if (inRect(x, y, BACK_X, BAR_Y, BACK_W, BAR_H)) { sel = -1; drawList(); return; }
  for (int i = 0; i < 6; i++)
    if (inRect(x, y, CHIP_X0 + i * (CHIP_W + CHIP_GAP), BAR_Y, CHIP_W, BAR_H)) {
      minutes = DURATIONS[i];
      drawBar();
      return;
    }
}

static void handleTimerTap(int x, int y) {
  if (inRect(x, y, PLUS_X, BTN_Y, PLUS_W, BTN_H)) {
    if (totalS + 300 <= MAX_MIN * 60L) { totalS += 300; leftS += 300; }
    updateRing();
  } else if (inRect(x, y, LOG_X, BTN_Y, LOG_W, BTN_H)) {
    exitTimer(true);
  } else {
    paused = !paused;
    lastSec = millis();
    updateRing();
  }
}

static void handleProjectsTap(int x, int y) {
  if (inRect(x, y, BACK_X, BAR_Y, BACK_W, BAR_H)) {
    screen = SCR_LIST;
    drawList();
    return;
  }
  for (int i = 0; i < projectCount; i++)
    if (inRect(x, y, TASK_X, TASK_Y0 + i * (TASK_H + TASK_GAP), TASK_W, TASK_H)) {
      if (projects[i].id != projectId) {
        projectId = projects[i].id;
        prefs.putString("project_id", projectId);
        focusSectionId = "";
        sel = -1;
      }
      screen = SCR_LIST;
      syncAndRefresh();
      return;
    }
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
  Serial.begin(115200);
  lcdReset();
  // touch chip is held in reset by the expander at power-on — release all pins high
  Wire.beginTransmission(0x20); Wire.write(0x03); Wire.write(0x00); Wire.endTransmission();
  Wire.beginTransmission(0x20); Wire.write(0x01); Wire.write(0xFF); Wire.endTransmission();
  delay(50);
  if (!gfx->begin(40000000)) Serial.println("[LCD] panel begin failed");
  gfx->setRotation(1);
  pinMode(25, OUTPUT);       // backlight (dash_35 kBacklightPin)
  digitalWrite(25, HIGH);
  gfx->fillScreen(C_BG);
  text("connecting WiFi...", 240, 152, 2, C_MUTED, C_BG, true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) delay(250);
  tls.setInsecure();  // ponytail: pin api.todoist.com root CA before leaving your desk (DESIGN.md)
  prefs.begin("timebox", false);
  projectId = prefs.getString("project_id", TODOIST_PROJECT_ID);
  configTzTime(TZ_POSIX, "pool.ntp.org", "time.nist.gov");
  text("syncing...", 240, 176, 2, C_MUTED, C_BG, true);
  screen = SCR_LIST;
  syncAndRefresh();
}

void loop() {
  int16_t tx, ty;
  static bool wasDown = false;
  bool down = readTouch(tx, ty);
  if (down && !wasDown) {
    if (screen == SCR_LIST) handleListTap(tx, ty);
    else if (screen == SCR_TIMER) handleTimerTap(tx, ty);
    else handleProjectsTap(tx, ty);
  }
  wasDown = down;

  if (screen == SCR_LIST) {
    drawClock();
    if (millis() - lastSync > SYNC_INTERVAL_MS) syncAndRefresh();
  } else if (!paused && leftS > 0) {
    uint32_t now = millis();
    uint32_t elapsed = (now - lastSec) / 1000;
    if (elapsed) {
      lastSec += elapsed * 1000;
      leftS -= elapsed;
      if (leftS < 0) leftS = 0;
      updateRing();
    }
  }
  delay(20);
}
