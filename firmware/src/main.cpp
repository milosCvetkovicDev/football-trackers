/**
 * football-trackers - Player Tracker firmware
 * Target: WEMOS Lite ESP32 (LOLIN32 Lite) + u-blox NEO-M8N (GY-GPSV3)
 *
 * Pipeline:  NEO-M8N @10Hz (UBX-PVT) -> WiFi -> MQTT publish (QoS0)
 * Resilience: if WiFi/MQTT is down, each fix is buffered to LittleFS
 *             (newline-delimited JSON) and replayed on reconnect, so a
 *             dropout on the field never loses the session.
 *
 * Topic:  football-trackers/session/{SESSION_ID}/player/{PLAYER_ID}/telemetry
 * Packet: {"id","pl","ts","lat","lon","spd","hdg","fix","sats","pdop"}
 *         ts is the device clock (ordering only); the server is the
 *         authoritative timestamp.
 * Secrets: the WiFi PSK and per-device MQTT creds (username == PLAYER_ID, password) live
 *          in NVS, not source — provisioned once via the serial `enroll` console, so the
 *          SAME image flashes to every device. See ADR-0013 (hard gate) / ADR-0014.
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <SparkFun_u-blox_GNSS_Arduino_Library.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <WebServer.h>    // captive-portal Wi-Fi setup (ESP32 built-in; no extra lib_dep)
#include <DNSServer.h>    // captive redirect so the phone auto-opens the setup page
#include <ESPmDNS.h>      // resolve a "name.local" broker host via Bonjour/mDNS

// ----------------------- DEVICE CONFIG -----------------------
// Non-secret and identical on every device, so the SAME compiled image flashes to all
// wearables — safe to keep in source.
// Compiled DEFAULT broker host — used only when NVS has no `mqtt_host` (set it per network in the setup
// portal / `set host`, or use a "name.local" mDNS name so it works on any network). Field AP = 192.168.4.1.
static const char*    MQTT_HOST  = "192.168.1.7";   // LOCAL BENCH default: this Mac's Wi-Fi IP
static const uint16_t MQTT_PORT  = 1883;
static const char*    SESSION_ID = "test";

// Per-device SECRETS live in ESP32 NVS (Arduino Preferences), NEVER in source or the build
// artifact. This is the ADR-0013 "hard gate" for tracking real children: one image, one
// flash, only NVS differs. Provision them once over USB with the `enroll` serial console
// (see enrollConsole() below / firmware notes in README.md). The broker runs
// allow_anonymous=false with an ACL keyed on username == PLAYER_ID (server/mosquitto/ft.acl
// `%u`), so the MQTT username IS the player id and a compromised device can publish only as
// itself. Optionally enable ESP32 flash encryption so a recovered device's flash can't be
// dumped — see platformio.ini and docs/decisions/0014-firmware-secret-provisioning.md.
static const char* NVS_NS = "ft-cfg";   // NVS namespace (<= 15 chars)
String g_wifiSsid;                        // NVS "wifi_ssid"
String g_wifiPass;                        // NVS "wifi_pass" — the field-AP WPA2 PSK
String g_playerId;                        // NVS "player_id" — also the MQTT username (ACL %u)
String g_mqttPass;                        // NVS "mqtt_pass" — this device's broker password
String g_mqttHost;                        // NVS "mqtt_host" — broker host (IP or name.local); defaults to MQTT_HOST
// -------------------------------------------------------------

// Captive-portal Wi-Fi setup (option B): the device briefly becomes its own AP so a phone can pick the Wi-Fi
// from a scanned list + enter the broker host — no serial console, no reflash. WPA2-protected with a fixed,
// printed setup password (the AP is only up during provisioning). All built-in ESP32 networking, no lib_dep.
static const char* PORTAL_AP_PASS = "tracker-setup";   // >= 8 chars (WPA2); printed to serial on portal start
WebServer  g_web(80);
DNSServer  g_dns;
static const byte DNS_PORT = 53;
static bool g_portalActive = false;   // true while the setup AP+web are up (enrollReadLine pumps them)
static bool g_mdnsUp = false;         // mDNS responder started once (after Wi-Fi is up)

// GPS on Serial2. Wiring: M8N TX -> GPS_RX_PIN, M8N RX -> GPS_TX_PIN, plus 3V3 + GND.
static const int      GPS_RX_PIN      = 16;         // ESP32 RX <- M8N TX
static const int      GPS_TX_PIN      = 17;         // ESP32 TX -> M8N RX
static const uint32_t GPS_TARGET_BAUD = 115200;     // raised from 9600 for 10Hz headroom
static const uint8_t  GPS_RATE_HZ     = 10;

// Flash backlog. Size-capped so a long outage can't fill the flash.
static const char*    BACKLOG_PATH      = "/backlog.ndjson";
static const size_t   BACKLOG_MAX_BYTES = 256 * 1024;

// Device self-telemetry (health). Published low-rate on the .../status topic so
// the backend can see WHY a player's dot went stale. Best-effort (NOT backlogged
// — stale health is useless). See docs/architecture/observability.md.
static const uint32_t STATUS_INTERVAL_MS = 5000;
// Battery sense: wire VBAT through a divider to BATT_ADC_PIN (set -1 to disable).
// volts = adc/4095 * 3.3 * BATT_DIVIDER * BATT_CAL. Calibrate against a multimeter.
static const int      BATT_ADC_PIN = 35;       // ADC1_CH7 on ESP32
static const float    BATT_DIVIDER = 2.0f;     // (R1+R2)/R2 of your divider
static const float    BATT_CAL     = 1.0f;     // fine-tune factor

SFE_UBLOX_GNSS gnss;
WiFiClient     net;
PubSubClient   mqtt(net);

String g_topic;
String g_statusTopic;
char   g_clientId[32];

// Health counters/state for the .../status frame.
static uint32_t g_pubCount   = 0;   // successful telemetry publishes (cumulative)
static uint32_t g_stashCount = 0;   // backlog appends (cumulative)
static int      g_lastFix    = 0;   // last GNSS fix type seen
static int      g_lastSats   = 0;   // last satellites-in-view seen

// ----------------------- helpers -----------------------
static void buildIds() {
  uint16_t macTail = (uint16_t)(ESP.getEfuseMac() & 0xFFFF);
  snprintf(g_clientId, sizeof(g_clientId), "trk-%s-%04X", g_playerId.c_str(), macTail);
  g_topic = String("football-trackers/session/") + SESSION_ID +
            "/player/" + g_playerId + "/telemetry";
  g_statusTopic = String("football-trackers/session/") + SESSION_ID +
                  "/player/" + g_playerId + "/status";
}

static bool wifiEnsure() {
  if (WiFi.status() == WL_CONNECTED) return true;
  // iPhone Personal Hotspot is notoriously finicky with the ESP32 Arduino WiFi stack. The tweaks below also
  // help any marginal AP and are harmless on a normal router (MATEOMI): keep the radio awake (modem power-save
  // breaks association with some hotspots), start from a clean slate, and allow a longer association window.
  // The status log turns a previously-silent failure into a diagnosable code:
  //   1 = WL_NO_SSID_AVAIL (network not seen — wrong SSID / not 2.4 GHz / hotspot asleep)
  //   4 = WL_CONNECT_FAILED (auth — wrong password)
  //   6 = WL_DISCONNECTED  (association/handshake never completed — e.g. PMF/WPA3-transition mismatch)
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.disconnect(false, false);   // drop any half-open association from a previous attempt/network
  delay(150);
  Serial.printf("[wifi] connecting to '%s'\n", g_wifiSsid.c_str());
  WiFi.begin(g_wifiSsid.c_str(), g_wifiPass.c_str());
  uint32_t t0 = millis();
  wl_status_t st = WiFi.status();
  while (st != WL_CONNECTED && millis() - t0 < 15000) {   // give a slow AP more headroom than the original 8 s
    delay(250);
    st = WiFi.status();
  }
  if (st == WL_CONNECTED) {
    Serial.printf("[wifi] connected ip=%s rssi=%d\n", WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());
    return true;
  }
  Serial.printf("[wifi] FAILED status=%d (1=no-ssid 4=auth/pass 6=assoc/PMF) after %lus\n",
                (int)st, (unsigned long)((millis() - t0) / 1000));
  return false;
}

// Point PubSubClient at the broker. A "name.local" host is resolved via mDNS (Bonjour) to an IP, so the device
// finds the broker on ANY shared network without a hardcoded IP (home, field AP, hotspot). A literal IP or a
// plain hostname is passed straight through (PubSubClient does normal DNS for the latter). Returns false only
// when a ".local" name couldn't be resolved this attempt (the caller retries on the next loop).
static bool setBrokerServer() {
  if (g_mqttHost.endsWith(".local")) {
    if (!g_mdnsUp) g_mdnsUp = MDNS.begin(g_clientId);                 // start the resolver once, after Wi-Fi is up
    String name = g_mqttHost.substring(0, g_mqttHost.length() - 6);  // strip the ".local" suffix
    IPAddress ip = MDNS.queryHost(name, 2000);                        // 2 s mDNS lookup
    if (ip == IPAddress(0, 0, 0, 0)) {
      Serial.printf("[mdns] could not resolve %s — will retry\n", g_mqttHost.c_str());
      return false;
    }
    mqtt.setServer(ip, MQTT_PORT);
    return true;
  }
  mqtt.setServer(g_mqttHost.c_str(), MQTT_PORT);   // literal IP or a plain DNS hostname
  return true;
}

static bool mqttEnsure() {
  if (mqtt.connected()) return true;
  if (!wifiEnsure()) return false;
  if (!setBrokerServer()) return false;   // resolve mDNS (for name.local) or set the IP/host
  mqtt.setBufferSize(512);
  // Username is the player id (broker ACL %u); password is this device's NVS secret.
  if (mqtt.connect(g_clientId, g_playerId.c_str(), g_mqttPass.c_str())) return true;
  // Distinguish an auth failure (state 4 = bad user/pass, 5 = not authorized) from a
  // plain network drop, so a credential/ACL provisioning mistake is diagnosable on
  // serial instead of looking like a mysteriously missing player. See ADR-0007.
  Serial.printf("[mqtt] connect failed, state=%d\n", mqtt.state());
  return false;
}

// Append one payload to the flash backlog (best-effort, size-capped).
static void backlogAppend(const char* json) {
  File f = LittleFS.open(BACKLOG_PATH, FILE_APPEND);
  if (!f) return;
  if (f.size() < BACKLOG_MAX_BYTES) {
    f.println(json);
    g_stashCount++;
  }
  f.close();
}

// Current backlog size in bytes (0 if none) — a key health signal: a rising
// backlog means the device can buffer fixes but not reach the broker.
static size_t backlogBytes() {
  if (!LittleFS.exists(BACKLOG_PATH)) return 0;
  File f = LittleFS.open(BACKLOG_PATH, FILE_READ);
  size_t n = f ? f.size() : 0;
  if (f) f.close();
  return n;
}

// Battery voltage via the ADC divider (0 if disabled/unmetered).
static float battVolts() {
  if (BATT_ADC_PIN < 0) return 0.0f;
  int raw = analogRead(BATT_ADC_PIN);
  return (raw / 4095.0f) * 3.3f * BATT_DIVIDER * BATT_CAL;
}

// Rough 1S Li-Po state of charge from voltage (-1 if unmetered).
static int battPct(float v) {
  if (v <= 0.0f) return -1;
  float p = (v - 3.30f) / (4.20f - 3.30f) * 100.0f;
  return (int)(p < 0 ? 0 : (p > 100 ? 100 : p));
}

// Publish one device-health frame. Best-effort, fire-and-forget — never
// backlogged, because stale health helps no one.
static void publishStatus() {
  if (!mqtt.connected()) return;
  float v = battVolts();
  JsonDocument doc;
  doc["id"]      = g_clientId;
  doc["pl"]      = g_playerId;
  doc["ts"]      = millis();
  doc["up"]      = millis() / 1000;
  doc["heap"]    = ESP.getFreeHeap();
  doc["rssi"]    = WiFi.RSSI();
  doc["batt"]    = serialized(String(v, 2));
  doc["pct"]     = battPct(v);
  doc["fix"]     = g_lastFix;
  doc["sats"]    = g_lastSats;
  doc["pub"]     = g_pubCount;
  doc["stash"]   = g_stashCount;
  doc["backlog"] = (uint32_t)backlogBytes();

  char buf[256];
  serializeJson(doc, buf, sizeof(buf));
  mqtt.publish(g_statusTopic.c_str(), buf);
}

// Replay everything buffered, then clear. Called right after (re)connect.
static void backlogFlush() {
  if (!LittleFS.exists(BACKLOG_PATH)) return;
  File f = LittleFS.open(BACKLOG_PATH, FILE_READ);
  if (!f) return;
  bool allSent = true;
  while (f.available()) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line.isEmpty()) continue;
    if (!mqtt.connected() || !mqtt.publish(g_topic.c_str(), line.c_str())) {
      allSent = false;   // stop; keep the file for the next attempt
      break;
    }
  }
  f.close();
  if (allSent) LittleFS.remove(BACKLOG_PATH);
}

// ----------------------- config / enrollment -----------------------
// Per-device secrets live in NVS, written once via the serial `enroll` console. This keeps
// the compiled image identical across devices and out of the repo (ADR-0013 hard gate).

// Load the credential set from NVS into the g_* globals. Returns true only when ALL four
// fields are present, so a never-enrolled or half-provisioned device is treated as
// un-enrolled rather than silently connecting with blanks.
static bool configLoad() {
  Preferences p;
  p.begin(NVS_NS, /*readOnly=*/true);
  g_wifiSsid = p.getString("wifi_ssid", "");
  g_wifiPass = p.getString("wifi_pass", "");
  g_playerId = p.getString("player_id", "");
  g_mqttPass = p.getString("mqtt_pass", "");
  g_mqttHost = p.getString("mqtt_host", MQTT_HOST);   // optional; falls back to the compiled default
  p.end();
  // Host is optional (has a compiled default); the four credential fields are required to count as enrolled.
  return g_wifiSsid.length() && g_wifiPass.length() &&
         g_playerId.length() && g_mqttPass.length();
}

// Print current config to serial, masking the secrets (length only — never echo a
// password back over the wire).
static void enrollShow() {
  Serial.printf("  ssid     = %s\n", g_wifiSsid.length() ? g_wifiSsid.c_str() : "<empty>");
  Serial.printf("  wifipass = %s (%u chars)\n", g_wifiPass.length() ? "set" : "<empty>", g_wifiPass.length());
  Serial.printf("  player   = %s\n", g_playerId.length() ? g_playerId.c_str() : "<empty>");
  Serial.printf("  mqttpass = %s (%u chars)\n", g_mqttPass.length() ? "set" : "<empty>", g_mqttPass.length());
  Serial.printf("  host     = %s\n", g_mqttHost.length() ? g_mqttHost.c_str() : "<default>");
}

static void enrollHelp() {
  Serial.println(F(
    "enrollment commands (also pipe-friendly: feed these lines over serial):\n"
    "  set ssid <value>       field-AP SSID\n"
    "  set wifipass <value>   field-AP WPA2 PSK\n"
    "  set player <value>     this device's PLAYER_ID (== MQTT username, ACL %u)\n"
    "  set mqttpass <value>   this device's MQTT password\n"
    "  set host <value>       broker host: IP or name.local (optional; default compiled in)\n"
    "  show                   print current values (passwords masked)\n"
    "  save                   validate all four, write NVS, reboot\n"
    "  clear                  erase stored credentials\n"
    "  quit                   exit without saving (only when a full set is already saved)\n"
    "  help                   this list\n"
    "value is everything after the key (spaces allowed; no quotes).\n"
    "exit: 'save' (writes NVS + reboots) or 'quit' (only when creds are already saved)."));
}

// Block until a full line arrives on serial; strips a trailing CR. Enrollment is a
// deliberate device-offline state, so blocking here is intended.
static String enrollReadLine() {
  String line;
  for (;;) {
    // While waiting for a serial line, keep servicing the captive portal (if it's up) so the phone-based
    // setup works concurrently with the serial console — whichever the operator uses, `save` reboots.
    while (!Serial.available()) {
      if (g_portalActive) { g_dns.processNextRequest(); g_web.handleClient(); }
      delay(5);
    }
    char c = Serial.read();
    if (c == '\n') break;
    if (c == '\r') continue;
    line += c;
    if (line.length() > 256) break;   // guard against a runaway sender
  }
  return line;
}

// Interactive (and pipe-friendly) serial console to provision NVS. Exits by rebooting after a
// successful `save`, or via `quit` when NVS already holds a complete set — so it can never
// return with incomplete creds (at first boot NVS is empty, so `quit` is refused there).
static void enrollConsole() {
  Serial.println(F("\n=== football-trackers enrollment ==="));
  Serial.println(F("set all four fields, then 'save' (save writes NVS and reboots)."));
  enrollHelp();
  enrollShow();
  for (;;) {
    Serial.print("\nenroll> ");
    String line = enrollReadLine();
    line.trim();
    if (line.isEmpty()) continue;

    if (line == "help") { enrollHelp(); continue; }
    if (line == "show") { enrollShow(); continue; }
    if (line == "clear") {
      Preferences p; p.begin(NVS_NS, false); p.clear(); p.end();
      g_wifiSsid = ""; g_wifiPass = ""; g_playerId = ""; g_mqttPass = "";
      Serial.println("[cfg] cleared");
      continue;
    }
    if (line == "save") {
      if (!(g_wifiSsid.length() && g_wifiPass.length() &&
            g_playerId.length() && g_mqttPass.length())) {
        Serial.println("[cfg] refusing to save — all four fields are required");
        enrollShow();
        continue;
      }
      Preferences p; p.begin(NVS_NS, false);
      p.putString("wifi_ssid", g_wifiSsid);
      p.putString("wifi_pass", g_wifiPass);
      p.putString("player_id", g_playerId);
      p.putString("mqtt_pass", g_mqttPass);
      p.putString("mqtt_host", g_mqttHost);   // optional; defaults to the compiled MQTT_HOST when unset
      p.end();
      Serial.println("[cfg] saved to NVS — rebooting");
      delay(200);
      ESP.restart();
    }
    if (line == "quit") {
      // Allowed only if NVS already holds a complete set (re-provisioning a live device, not
      // first-boot enrollment). Read NVS directly so in-progress edits aren't clobbered on the
      // reject path; on success, reload to discard any unsaved edits and restore live values.
      Preferences p; p.begin(NVS_NS, /*readOnly=*/true);
      bool nvsComplete = p.getString("wifi_ssid", "").length() && p.getString("wifi_pass", "").length() &&
                         p.getString("player_id", "").length() && p.getString("mqtt_pass", "").length();
      p.end();
      if (!nvsComplete) {
        Serial.println("[cfg] config incomplete — set the missing fields and 'save' (can't quit yet)");
        continue;
      }
      configLoad();   // discard unsaved edits; restore the saved (live) values
      Serial.println("[cfg] exit — unsaved edits discarded, running with saved config");
      return;
    }
    if (line.startsWith("set ")) {
      String rest = line.substring(4);
      int sp = rest.indexOf(' ');
      if (sp < 0) { Serial.println("[cfg] usage: set <key> <value>"); continue; }
      String key = rest.substring(0, sp);
      String val = rest.substring(sp + 1);
      if      (key == "ssid")     g_wifiSsid = val;
      else if (key == "wifipass") g_wifiPass = val;
      else if (key == "player")   g_playerId = val;
      else if (key == "mqttpass") g_mqttPass = val;
      else if (key == "host")     g_mqttHost = val;
      else { Serial.printf("[cfg] unknown key '%s'\n", key.c_str()); continue; }
      Serial.printf("[cfg] %s updated\n", key.c_str());
      continue;
    }
    Serial.println("[cfg] unrecognised — type 'help'");
  }
}

// ----------------------- captive-portal Wi-Fi setup (option B) -----------------------
// A phone-friendly alternative to the serial console: the device makes its own Wi-Fi AP, you connect, and a web
// page scans + lists nearby Wi-Fi so you pick one and enter the broker host — no serial, no reflash. It runs
// CONCURRENTLY with the serial console (enrollReadLine pumps it); whichever path saves, the device reboots.

// HTML-escape a value before placing it in page text / an attribute (SSIDs can contain quotes/&).
static String htmlEscape(const String& s) {
  String o; o.reserve(s.length() + 8);
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    if      (c == '&')  o += "&amp;";
    else if (c == '<')  o += "&lt;";
    else if (c == '>')  o += "&gt;";
    else if (c == '"')  o += "&quot;";
    else if (c == '\'') o += "&#39;";
    else                o += c;
  }
  return o;
}

// GET / (and any unknown path, so the captive portal auto-opens): the setup form with a scanned Wi-Fi list +
// the broker host (prefilled). The scan is synchronous (~2 s) — the page just takes a beat to render.
static void portalRoot() {
  int n = WiFi.scanNetworks();
  String h = F("<!doctype html><html><head><meta charset=utf-8>"
               "<meta name=viewport content='width=device-width,initial-scale=1'><title>Tracker setup</title></head>"
               "<body style='font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:16px'>"
               "<h2>Player tracker setup</h2><form method=POST action=/save>"
               "<label>Wi-Fi network (2.4 GHz)</label><br>");
  if (n > 0) {
    h += F("<select name=ssid style='width:100%;padding:8px;margin:4px 0'>");
    for (int i = 0; i < n; i++) {
      String s = htmlEscape(WiFi.SSID(i));
      h += "<option value='" + s + "'>" + s + " (" + String(WiFi.RSSI(i)) + " dBm)</option>";
    }
    h += F("</select>");
  } else {
    h += F("<input name=ssid placeholder='SSID (no networks found - type it)' style='width:100%;padding:8px;margin:4px 0'>");
  }
  h += F("<br><label>Wi-Fi password</label><br>"
         "<input name=wifipass type=password style='width:100%;padding:8px;margin:4px 0'>"
         "<br><label>Player ID</label><br>");
  h += "<input name=player value='" + htmlEscape(g_playerId) + "' style='width:100%;padding:8px;margin:4px 0'>";
  h += F("<br><label>MQTT password</label><br>"
         "<input name=mqttpass type=password style='width:100%;padding:8px;margin:4px 0'>"
         "<br><label>Broker host (IP or name.local)</label><br>");
  h += "<input name=host value='" + htmlEscape(g_mqttHost) + "' style='width:100%;padding:8px;margin:4px 0'>";
  h += F("<br><br><button type=submit style='width:100%;padding:12px;font-size:16px'>Save &amp; reboot</button>"
         "</form></body></html>");
  g_web.send(200, "text/html", h);
  WiFi.scanDelete();
}

// POST /save: validate the four required fields, write NVS (+ optional host), reboot into normal operation.
static void portalSave() {
  String ssid = g_web.arg("ssid"), wifipass = g_web.arg("wifipass");
  String player = g_web.arg("player"), mqttpass = g_web.arg("mqttpass"), host = g_web.arg("host");
  if (!ssid.length() || !wifipass.length() || !player.length() || !mqttpass.length()) {
    g_web.send(400, "text/html",
               F("<p>SSID, Wi-Fi password, player and MQTT password are required. <a href=/>back</a></p>"));
    return;
  }
  if (!host.length()) host = MQTT_HOST;
  Preferences p; p.begin(NVS_NS, false);
  p.putString("wifi_ssid", ssid);
  p.putString("wifi_pass", wifipass);
  p.putString("player_id", player);
  p.putString("mqtt_pass", mqttpass);
  p.putString("mqtt_host", host);
  p.end();
  g_web.send(200, "text/html", F("<h3>Saved. Rebooting...</h3><p>The tracker is connecting to your Wi-Fi now.</p>"));
  Serial.println("[portal] saved to NVS — rebooting");
  delay(600);
  ESP.restart();
}

// Bring up the setup AP + captive DNS + web server. AP_STA mode so the STA side can still scan for networks.
static void startPortal() {
  WiFi.mode(WIFI_AP_STA);
  uint16_t macTail = (uint16_t)(ESP.getEfuseMac() & 0xFFFF);
  char ap[24];
  snprintf(ap, sizeof(ap), "ft-setup-%04X", macTail);
  WiFi.softAP(ap, PORTAL_AP_PASS);
  IPAddress ip = WiFi.softAPIP();
  g_dns.start(DNS_PORT, "*", ip);          // captive: every DNS lookup resolves to us, so the page auto-opens
  g_web.on("/", HTTP_GET, portalRoot);
  g_web.on("/save", HTTP_POST, portalSave);
  g_web.onNotFound(portalRoot);            // captive-portal probe URLs -> the form
  g_web.begin();
  g_portalActive = true;
  Serial.printf("[portal] Wi-Fi setup AP '%s' (password '%s') — connect a phone, open http://%s\n",
                ap, PORTAL_AP_PASS, ip.toString().c_str());
}

// Tear the portal down — used when re-provisioning a LIVE device exits via `quit` (instead of saving+rebooting).
static void stopPortal() {
  g_web.stop();
  g_dns.stop();
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  g_portalActive = false;
}

// Non-blocking: lets an operator type `enroll` over serial during normal operation to
// re-provision (e.g. PSK rotation after a lost device — ADR-0013 playbook). Re-enrollment
// ends in a reboot (via save), which is fine for a maintenance action.
static void pollSerialCommands() {
  static String line;
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      line.trim();
      if (line == "enroll") enrollConsole();
      // `portal`: re-provision a live device via the phone setup AP (+ serial). `quit` in the console
      // tears the portal back down; `save` reboots. Going offline briefly is fine for a maintenance action.
      else if (line == "portal") { startPortal(); enrollConsole(); stopPortal(); }
      line = "";
    } else {
      line += c;
      if (line.length() > 64) line = "";
    }
  }
}

// ----------------------- GPS bring-up -----------------------
static void gpsBegin() {
  // M8N ships at 9600 baud / 1Hz / NMEA. Open, talk UBX, raise baud, reconfigure.
  Serial2.begin(9600, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  if (gnss.begin(Serial2)) {
    gnss.setSerialRate(GPS_TARGET_BAUD);
    delay(100);
  }
  Serial2.updateBaudRate(GPS_TARGET_BAUD);
  if (!gnss.begin(Serial2)) {
    Serial.println("[gps] not seen @115200, falling back to 9600");
    Serial2.updateBaudRate(9600);
    gnss.begin(Serial2);
  }
  gnss.setUART1Output(COM_TYPE_UBX);          // UBX only - kills NMEA noise
  gnss.setNavigationFrequency(GPS_RATE_HZ);   // 10 Hz fix rate
  gnss.setAutoPVT(true);                       // PVT pushed in background
  gnss.saveConfiguration();                    // persist in M8N flash
  Serial.println("[gps] configured @10Hz UBX-PVT");
}

// ----------------------- main -----------------------
void setup() {
  Serial.begin(115200);
  delay(200);
  LittleFS.begin(true);   // format on first boot if needed

  // Secrets come from NVS, not source. If this device has never been enrolled (or NVS was
  // wiped), refuse to run on placeholders — block in the serial enrollment console until a
  // complete credential set is saved, which then reboots into normal operation.
  if (!configLoad()) {
    Serial.println("[cfg] no credentials in NVS — starting Wi-Fi setup (phone portal + serial console)");
    startPortal();     // phone-based captive portal ('ft-setup-XXXX')...
    enrollConsole();   // ...AND the serial console concurrently (enrollReadLine pumps the portal). Either path's
                       // 'save' reboots; 'quit' is refused on first boot, so this returns only once provisioned.
  }

  buildIds();
  gpsBegin();
  wifiEnsure();
  mqttEnsure();
  Serial.printf("[net] client=%s topic=%s\n", g_clientId, g_topic.c_str());
}

void loop() {
  mqtt.loop();
  pollSerialCommands();   // honour an `enroll` typed over serial (re-provision / PSK rotation)

  static bool wasConnected = false;
  bool connected = mqttEnsure();
  if (connected && !wasConnected) backlogFlush();   // just came back online
  wasConnected = connected;

  // getPVT() returns true only when a fresh 10Hz solution is ready.
  if (gnss.getPVT()) {
    int fixType = gnss.getFixType();   // 0=none 2=2D 3=3D
    int siv     = gnss.getSIV();
    g_lastFix   = fixType;             // remembered for the .../status frame
    g_lastSats  = siv;

    JsonDocument doc;
    doc["id"]   = g_clientId;
    doc["pl"]   = g_playerId;
    doc["ts"]   = millis();                                          // device clock
    doc["lat"]  = serialized(String(gnss.getLatitude()  / 1e7, 7)); // 7 dp ~1cm
    doc["lon"]  = serialized(String(gnss.getLongitude() / 1e7, 7));
    doc["spd"]  = gnss.getGroundSpeed() / 1000.0;                   // mm/s -> m/s
    doc["hdg"]  = gnss.getHeading() / 1e5;                          // deg
    doc["fix"]  = fixType;
    doc["sats"] = siv;
    doc["pdop"] = gnss.getPDOP() / 100.0;

    char buf[256];
    serializeJson(doc, buf, sizeof(buf));

    if (connected && mqtt.publish(g_topic.c_str(), buf)) {
      g_pubCount++;
    } else {
      backlogAppend(buf);    // offline -> stash to flash, replay later
    }
  }

  // Low-rate device-health heartbeat (best-effort).
  static uint32_t lastStatus = 0;
  if (connected && millis() - lastStatus >= STATUS_INTERVAL_MS) {
    publishStatus();
    lastStatus = millis();
  }
}
