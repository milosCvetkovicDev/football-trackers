/**
 * football-trackers - Player Tracker firmware
 * Target: WEMOS Lite ESP32 (LOLIN32 Lite) + u-blox NEO-M8N (GY-GPSV3)
 *
 * Pipeline:  NEO-M8N @10Hz (UBX-PVT) -> WiFi -> MQTT publish (QoS0)
 * Resilience (Phase 4, audit F-1..F-6): connectivity is a NON-BLOCKING state machine with
 *             jittered backoff, so a dropout never stalls the GPS drain; offline fixes go to
 *             a two-file flash backlog (drop-OLDEST when full) and are replayed PACED on
 *             reconnect from an NVS cursor — a crash mid-flush re-sends at most one
 *             checkpoint window, which the server dedupes by the monotonic `sq`.
 *
 * Topic:  football-trackers/session/{SESSION_ID}/player/{PLAYER_ID}/telemetry
 * Packet: {"id","pl","ts","lat","lon","spd","hdg","fix","sats","pdop","sq","gts"}
 *         ts is the device clock (ordering only). gts is the FIX's GPS-UTC epoch ms (0 when
 *         GPS time is not yet valid): the server trusts a sane gts as the row's time, so a
 *         replayed outage spans its real duration. sq is the per-device monotonic sequence
 *         (survives reboots via an NVS high-water mark) the server dedupes on.
 * Status: {"id","pl","ts","up","heap","rssi","batt","pct","fix","sats","pub","stash",
 *          "backlog","rst","boot","ver"} — reset reason, boot count and firmware version
 *          make a brownout/watchdog loop visible from the bench (F-4).
 * Secrets: the WiFi PSK and per-device MQTT creds (username == PLAYER_ID, password) live
 *          in NVS, not source — provisioned once via the serial `enroll` console, so the
 *          SAME image flashes to every device. See ADR-0013 (hard gate) / ADR-0014.
 *          SESSION_ID is NVS too (F-6): session is the unit of ACCESS CONTROL, so it must
 *          be settable per fixture without a reflash (`set session <id>`).
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
#include <esp_task_wdt.h> // hardware watchdog: a wedged loop reboots instead of dying on a child (F-4)
#include <esp_system.h>   // esp_reset_reason(), esp_random()
#include "resilience.h"   // the pure Phase 4 logic — host-tested in firmware/test/host/

static const char* FW_VERSION = "ft-fw/2.0.0-p4";

// ----------------------- DEVICE CONFIG -----------------------
// Non-secret and identical on every device, so the SAME compiled image flashes to all
// wearables — safe to keep in source.
// Compiled DEFAULT broker host — used only when NVS has no `mqtt_host` (set it per network in the setup
// portal / `set host`, or use a "name.local" mDNS name so it works on any network). Field AP = 192.168.4.1.
static const char*    MQTT_HOST  = "192.168.1.7";   // LOCAL BENCH default: this Mac's Wi-Fi IP
static const uint16_t MQTT_PORT  = 1883;
// Compiled DEFAULT session — used only when NVS has no `session_id`. Session is the unit of access
// control (a coach is authorised per session), so real fixtures set it at enrollment (F-6).
static const char*    SESSION_ID = "test";

static const char* NVS_NS = "ft-cfg";   // NVS namespace (<= 15 chars)
String g_wifiSsid;                        // NVS "wifi_ssid"
String g_wifiPass;                        // NVS "wifi_pass" — the field-AP WPA2 PSK
String g_playerId;                        // NVS "player_id" — also the MQTT username (ACL %u)
String g_mqttPass;                        // NVS "mqtt_pass" — this device's broker password
String g_mqttHost;                        // NVS "mqtt_host" — broker host (IP or name.local); defaults to MQTT_HOST
String g_sessionId;                       // NVS "session_id" — defaults to the compiled SESSION_ID
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
// UBX-PVT @10 Hz is ~1 KB/s. The default 256-byte RX buffer overruns in ~250 ms — part of how
// the old blocking reconnect lost ~99% of an outage. NOTE the honest limit: the SparkFun driver
// parses the whole ring into ONE PVT struct, so buffered bytes do NOT become recoverable fixes —
// every solution arriving during a stall except the last is lost regardless of buffer size. The
// buffer prevents UART overrun corruption; the real protection is keeping stalls short (the
// 400 ms TCP pre-connect + 1 s CONNACK bound in netTick).
static const size_t   GPS_RX_BUFFER   = 8192;
static const int      GPS_DRAIN_MAX   = 50;         // PVT solutions processed per loop() pass

// Flash backlog (Phase 4): TWO files so "full" can drop the OLDEST half instead of every new
// fix. Combined budget unchanged at 256 KB.
static const char*    BK_PATH[2]        = { "/backlog.0.ndjson", "/backlog.1.ndjson" };
static const uint32_t BK_CAP_HALF       = 128 * 1024;
static const char*    BK_LEGACY_PATH    = "/backlog.ndjson";   // pre-Phase-4 single file: adopted at boot
static const uint32_t FLUSH_INTERVAL_MS = 33;   // ~30 replay msgs/s — inside the server's 50/s cap with live 10 Hz on top

// Reconnect backoff (both WiFi association and MQTT connect attempts).
static const uint32_t BACKOFF_BASE_MS = 1000;
static const uint32_t BACKOFF_MAX_MS  = 15000;
static const uint32_t WIFI_ASSOC_TIMEOUT_MS = 15000; // association window (non-blocking — the loop keeps running)

// Watchdog: generous — the longest legitimate stall is a ~3 s TCP connect + LittleFS work.
static const uint32_t WDT_TIMEOUT_S = 20;

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
static uint32_t g_bootCount  = 0;   // NVS boot counter (F-4)
static int      g_resetReason = -1; // esp_reset_reason() of THIS boot (F-4)

// GPS-UTC clock: last valid fix time + the millis() it was taken at, so "now" can be
// estimated between fixes (used only for backlog expiry — the server never trusts it blindly).
static uint64_t g_lastGtsMs   = 0;
static uint32_t g_lastGtsAtMs = 0;

// Sequence (F-1) — see resilience.h for the crash-safety contract.
static FtSeqState g_seq;

// Backlog state mirror (files on LittleFS, gens/cursors in NVS, decisions in resilience.h).
static FtBkState g_bk;
static uint32_t  g_flushSinceCheckpoint[2] = { 0, 0 };   // per file — finishing one must not widen the other's crash window
static uint8_t   g_flushFailStreak = 0;                   // consecutive publish failures at ONE cursor position
static uint32_t  g_lastFlushPubMs = 0;
static bool      g_bootPurgeDone = false;

// ----------------------- NVS helpers -----------------------
static uint32_t nvsGetU32(const char* key, uint32_t def) {
  Preferences p;
  p.begin(NVS_NS, /*readOnly=*/true);
  uint32_t v = p.getUInt(key, def);
  p.end();
  return v;
}

static void nvsPutU32(const char* key, uint32_t v) {
  Preferences p;
  p.begin(NVS_NS, false);
  p.putUInt(key, v);
  p.end();
}

static const char* BK_KEY_GEN[2] = { "bk_gen0", "bk_gen1" };
static const char* BK_KEY_OFF[2] = { "bk_off0", "bk_off1" };

// ----------------------- helpers -----------------------
static void buildIds() {
  uint16_t macTail = (uint16_t)(ESP.getEfuseMac() & 0xFFFF);
  snprintf(g_clientId, sizeof(g_clientId), "trk-%s-%04X", g_playerId.c_str(), macTail);
  g_topic = String("football-trackers/session/") + g_sessionId +
            "/player/" + g_playerId + "/telemetry";
  g_statusTopic = String("football-trackers/session/") + g_sessionId +
                  "/player/" + g_playerId + "/status";
}

// Point PubSubClient at the broker. A "name.local" host is resolved via mDNS (Bonjour) to an IP, so the device
// finds the broker on ANY shared network without a hardcoded IP (home, field AP, hotspot). A literal IP or a
// plain hostname is passed straight through (PubSubClient does normal DNS for the latter). Returns false only
// when a ".local" name couldn't be resolved this attempt (the caller backs off and retries).
static IPAddress g_brokerIp;   // resolved .local address, cached so the 2 s mDNS query runs once per network

static bool setBrokerServer() {
  if (g_mqttHost.endsWith(".local")) {
    if (g_brokerIp != IPAddress(0, 0, 0, 0)) {   // cached — do not pay the 2 s lookup per attempt
      mqtt.setServer(g_brokerIp, MQTT_PORT);
      return true;
    }
    if (!g_mdnsUp) g_mdnsUp = MDNS.begin(g_clientId);                 // start the resolver once, after Wi-Fi is up
    String name = g_mqttHost.substring(0, g_mqttHost.length() - 6);  // strip the ".local" suffix
    IPAddress ip = MDNS.queryHost(name, 2000);                        // 2 s mDNS lookup (bounded, once)
    if (ip == IPAddress(0, 0, 0, 0)) {
      Serial.printf("[mdns] could not resolve %s — will retry\n", g_mqttHost.c_str());
      return false;
    }
    g_brokerIp = ip;
    mqtt.setServer(ip, MQTT_PORT);
    return true;
  }
  mqtt.setServer(g_mqttHost.c_str(), MQTT_PORT);   // literal IP or a plain DNS hostname
  return true;
}

// ----------------------- connectivity state machine (non-blocking) -----------------------
// The old wifiEnsure() blocked the loop for up to 15 s per reconnect attempt; at 10 Hz that
// was ~150 fixes lost per attempt with a 256-byte GPS buffer — the audit's "~99% of an outage
// lost". Here every wait is a state + a deadline, the loop always returns to the GPS drain,
// and failed attempts back off with jitter (a squad of trackers must not thundering-herd the
// AP or broker when they come back).
enum NetState { NET_DOWN, NET_WIFI_WAIT, NET_ONLINE };
static NetState g_net = NET_DOWN;
static uint32_t g_nextAttemptMs = 0;   // no attempt before this millis()
static uint32_t g_wifiT0 = 0;
static uint32_t g_attempt = 0;

static void netScheduleRetry() {
  g_attempt++;
  uint32_t d = ft_backoff_ms(g_attempt, BACKOFF_BASE_MS, BACKOFF_MAX_MS, (uint8_t)(esp_random() & 0xFF));
  g_nextAttemptMs = millis() + d;
  g_net = NET_DOWN;
}

/** Advance the connect state machine one step. Never blocks longer than one MQTT TCP attempt (~3 s). */
static bool netTick() {
  if (mqtt.connected()) {
    g_net = NET_ONLINE;
    g_attempt = 0;
    return true;
  }
  uint32_t now = millis();
  switch (g_net) {
    case NET_ONLINE:   // just lost the broker
      g_net = NET_DOWN;
      g_nextAttemptMs = now;   // first retry immediately; failures back off from there
      return false;
    case NET_DOWN: {
      if ((int32_t)(now - g_nextAttemptMs) < 0) return false;
      if (WiFi.status() != WL_CONNECTED) {
        WiFi.persistent(false);
        WiFi.mode(WIFI_STA);
        WiFi.setSleep(false);            // modem power-save breaks association with some hotspots
        WiFi.disconnect(false, false);   // drop any half-open association from a previous attempt
        Serial.printf("[wifi] connecting to '%s' (attempt %lu)\n", g_wifiSsid.c_str(), (unsigned long)g_attempt + 1);
        WiFi.begin(g_wifiSsid.c_str(), g_wifiPass.c_str());
        g_wifiT0 = now;
        g_net = NET_WIFI_WAIT;
        return false;
      }
      // WiFi is up: one bounded MQTT attempt. The GPS side CANNOT buffer through a long stall —
      // the SparkFun driver parses the whole UART ring into ONE PVT struct, so every solution
      // that arrives during a blocking call except the last is gone (checker finding). The stall
      // is therefore kept short instead: pre-connect the TCP socket ourselves with a 400 ms
      // timeout (PubSubClient::connect short-circuits its own blocking connect when the client
      // is already connected), and bound the CONNACK wait to 1 s. Worst case ≈ 1.4 s ≈ 14 fixes
      // per attempt, ~5-6 backoff attempts in a 60 s outage — comfortably inside the ≥92% budget.
      if (!setBrokerServer()) { netScheduleRetry(); return false; }
      if (!net.connected()) {
        bool tcpUp = g_brokerIp != IPAddress(0, 0, 0, 0)
          ? net.connect(g_brokerIp, MQTT_PORT, 400)
          : net.connect(g_mqttHost.c_str(), MQTT_PORT, 400);
        if (!tcpUp) {
          Serial.printf("[mqtt] tcp connect failed (attempt %lu)\n", (unsigned long)g_attempt + 1);
          netScheduleRetry();
          return false;
        }
      }
      mqtt.setBufferSize(512);
      mqtt.setSocketTimeout(1);
      // Username is the player id (broker ACL %u); password is this device's NVS secret.
      if (mqtt.connect(g_clientId, g_playerId.c_str(), g_mqttPass.c_str())) {
        Serial.printf("[mqtt] connected as %s\n", g_clientId);
        g_net = NET_ONLINE;
        g_attempt = 0;
        return true;
      }
      // state 4 = bad user/pass, 5 = not authorized — a provisioning mistake, not a network drop (ADR-0007).
      Serial.printf("[mqtt] connect failed, state=%d\n", mqtt.state());
      netScheduleRetry();
      return false;
    }
    case NET_WIFI_WAIT: {
      wl_status_t st = WiFi.status();
      if (st == WL_CONNECTED) {
        Serial.printf("[wifi] connected ip=%s rssi=%d\n", WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());
        g_net = NET_DOWN;          // fall through to the MQTT attempt on the next tick
        g_nextAttemptMs = millis();
        return false;
      }
      if (millis() - g_wifiT0 >= WIFI_ASSOC_TIMEOUT_MS) {
        // 1 = WL_NO_SSID_AVAIL (not seen / not 2.4 GHz)  4 = WL_CONNECT_FAILED (auth)  6 = WL_DISCONNECTED (assoc/PMF)
        Serial.printf("[wifi] FAILED status=%d (1=no-ssid 4=auth/pass 6=assoc/PMF)\n", (int)st);
        netScheduleRetry();
      }
      return false;
    }
  }
  return false;
}

// ----------------------- backlog (Phase 4: two files, cursor, drop-oldest) -----------------------
static uint32_t fileSize(const char* path) {
  if (!LittleFS.exists(path)) return 0;
  File f = LittleFS.open(path, FILE_READ);
  uint32_t n = f ? (uint32_t)f.size() : 0;
  if (f) f.close();
  return n;
}

/** Rebuild the RAM mirror from FS + NVS (boot, and after any structural change). */
static void bkReconcile() {
  for (int i = 0; i < 2; i++) {
    g_bk.f[i].exists = LittleFS.exists(BK_PATH[i]);
    g_bk.f[i].size = g_bk.f[i].exists ? fileSize(BK_PATH[i]) : 0;
    g_bk.f[i].gen = nvsGetU32(BK_KEY_GEN[i], 0);
    g_bk.f[i].off = nvsGetU32(BK_KEY_OFF[i], 0);
    if (!g_bk.f[i].exists && g_bk.f[i].gen != 0) {   // file gone (flushed/crashed) — clear its NVS state
      nvsPutU32(BK_KEY_GEN[i], 0);
      nvsPutU32(BK_KEY_OFF[i], 0);
      g_bk.f[i].gen = 0;
      g_bk.f[i].off = 0;
    }
    if (g_bk.f[i].off > g_bk.f[i].size) g_bk.f[i].off = g_bk.f[i].size;   // cursor can never trail past EOF
    // Heal a torn tail (crash mid-append): terminate it with '\n' so the fragment becomes its
    // own line — the flush's endsWith("}") guard then skips it — instead of the NEXT append
    // merging onto it and taking a good record down with it (checker finding).
    if (g_bk.f[i].exists && g_bk.f[i].size > 0) {
      File f = LittleFS.open(BK_PATH[i], FILE_READ);
      if (f) {
        bool torn = false;
        if (f.seek(g_bk.f[i].size - 1)) torn = f.read() != '\n';
        f.close();
        if (torn) {
          File a = LittleFS.open(BK_PATH[i], FILE_APPEND);
          if (a) { a.print('\n'); g_bk.f[i].size = (uint32_t)a.size(); a.close(); }
          Serial.println("[bk] healed a torn record tail from an interrupted append");
        }
      }
    }
  }
  g_bk.next_gen = nvsGetU32("bk_nextgen", 1);
  for (int i = 0; i < 2; i++) {
    if (g_bk.f[i].exists && g_bk.f[i].gen == 0) {
      // A file with no recorded generation (crash between create and persist): adopt it as newest.
      g_bk.f[i].gen = g_bk.next_gen++;
      nvsPutU32(BK_KEY_GEN[i], g_bk.f[i].gen);
      nvsPutU32("bk_nextgen", g_bk.next_gen);
    }
    if (g_bk.f[i].gen >= g_bk.next_gen) {
      g_bk.next_gen = g_bk.f[i].gen + 1;
      nvsPutU32("bk_nextgen", g_bk.next_gen);
    }
  }
}

/** Pre-Phase-4 single-file backlog: adopt it as generation 1 so nothing stashed is lost on upgrade. */
static void bkAdoptLegacy() {
  if (!LittleFS.exists(BK_LEGACY_PATH)) return;
  if (!LittleFS.exists(BK_PATH[0]) && !LittleFS.exists(BK_PATH[1])) {
    LittleFS.rename(BK_LEGACY_PATH, BK_PATH[0]);
    nvsPutU32(BK_KEY_GEN[0], 1);
    nvsPutU32(BK_KEY_OFF[0], 0);
    nvsPutU32("bk_nextgen", 2);
    Serial.println("[bk] adopted pre-Phase-4 backlog file");
  } else {
    LittleFS.remove(BK_LEGACY_PATH);   // both worlds present — the old file is the oldest data; budget wins
  }
}

/** Append one record to the active backlog file (drop-oldest rotation per resilience.h). */
static void backlogAppend(const char* json) {
  FtBkAppendPlan plan = ft_bk_append_plan(&g_bk, BK_CAP_HALF);
  // I/O CONTRACT (resilience.h FtBkAppendPlan): the ONLY file this function may delete is
  // BK_PATH[plan.target] — when drop_oldest_at_target is set, the unflushed OLDER half sits AT
  // plan.target and start_fresh below recreates that same slot; the OTHER slot holds the newest
  // stashed fixes. (The first cut deleted `1 - plan.target` here and destroyed BOTH halves —
  // caught by the checker pass; the host test now pins which slot the sacrifice sits in.)
  if (plan.drop_oldest_at_target) {
    Serial.println("[bk] full — dropping the OLDEST half to keep the newest fixes");
  }
  if (plan.start_fresh) {
    LittleFS.remove(BK_PATH[plan.target]);   // the dropped older half, or stale leftovers from a crash
    g_bk.f[plan.target] = { true, 0, plan.new_gen, 0 };
    g_bk.next_gen = plan.new_gen + 1;
    nvsPutU32(BK_KEY_GEN[plan.target], plan.new_gen);
    nvsPutU32(BK_KEY_OFF[plan.target], 0);
    nvsPutU32("bk_nextgen", g_bk.next_gen);
  }
  File f = LittleFS.open(BK_PATH[plan.target], FILE_APPEND);
  if (!f) return;
  f.print(json);
  f.print('\n');   // exactly \n (println would write \r\n)
  g_bk.f[plan.target].exists = true;
  g_bk.f[plan.target].size = (uint32_t)f.size();
  f.close();
  g_stashCount++;
}

static size_t backlogBytes() {
  size_t total = 0;
  for (int i = 0; i < 2; i++) {
    if (!g_bk.f[i].exists) continue;
    total += g_bk.f[i].size > g_bk.f[i].off ? g_bk.f[i].size - g_bk.f[i].off : 0;
  }
  return total;
}

/** Estimated current GPS-UTC ms (0 = never had valid GPS time). Only used for expiry checks. */
static uint64_t nowGtsMs() {
  if (g_lastGtsMs == 0) return 0;
  return g_lastGtsMs + (uint64_t)(millis() - g_lastGtsAtMs);
}

/** Finish a fully-drained flush file: delete it and clear its NVS state. */
static void bkFinishFile(int idx) {
  LittleFS.remove(BK_PATH[idx]);
  nvsPutU32(BK_KEY_GEN[idx], 0);
  nvsPutU32(BK_KEY_OFF[idx], 0);
  g_bk.f[idx] = { false, 0, 0, 0 };
  g_flushSinceCheckpoint[idx] = 0;
  Serial.println("[bk] file fully replayed");
}

/**
 * Replay ONE backlog record per call, paced (audit F-1/F-2): oldest file first, resumed from
 * the NVS cursor. The cursor is persisted every FT_BK_CHECKPOINT_EVERY records, so a crash
 * re-sends at most that window (the server dedupes by sq). Expired records (older than the
 * server's replay-trust window) are skipped — stale child location has no operational value (F-5).
 */
static void backlogFlushTick() {
  if (!mqtt.connected()) return;
  int idx = ft_bk_flush_target(&g_bk);
  if (idx < 0) return;
  uint32_t now = millis();
  if (now - g_lastFlushPubMs < FLUSH_INTERVAL_MS) return;

  File f = LittleFS.open(BK_PATH[idx], FILE_READ);
  if (!f) { bkFinishFile(idx); return; }
  if (!f.seek(g_bk.f[idx].off)) { f.close(); bkFinishFile(idx); return; }
  if (!f.available()) { f.close(); bkFinishFile(idx); return; }
  String line = f.readStringUntil('\n');
  uint32_t newOff = (uint32_t)f.position();
  bool atEnd = !f.available();
  f.close();
  line.trim();

  bool consumed = true;
  if (line.length() > 0 && line.endsWith("}")) {   // a torn final line (crash mid-append) is skipped
    uint64_t gts = 0;
    ft_extract_u64(line.c_str(), "\"gts\":", &gts);
    if (!ft_bk_expired(gts, nowGtsMs())) {
      if (mqtt.publish(g_topic.c_str(), line.c_str())) {
        g_pubCount++;
        g_lastFlushPubMs = now;
        g_flushFailStreak = 0;
      } else if (mqtt.connected() || ++g_flushFailStreak >= 3) {
        // publish() failed while the connection is UP (an over-sized/corrupt record the broker
        // buffer refuses) or keeps failing at the SAME cursor position: a poison record. Consume
        // it — retrying forever would wedge the whole backlog behind one bad line (checker finding).
        Serial.println("[bk] skipping an unpublishable record");
        g_flushFailStreak = 0;
      } else {
        consumed = false;   // broker went away mid-flush — keep the cursor, retry after reconnect
      }
    }
  }
  if (!consumed) return;
  g_bk.f[idx].off = newOff;
  g_flushSinceCheckpoint[idx]++;
  if (atEnd) {
    bkFinishFile(idx);
  } else if (ft_bk_should_checkpoint(g_flushSinceCheckpoint[idx])) {
    nvsPutU32(BK_KEY_OFF[idx], newOff);
    g_flushSinceCheckpoint[idx] = 0;
  }
}

/**
 * F-5: age purge, run ONCE per boot as soon as GPS time is valid (at boot there is no clock
 * to judge age with). A file whose NEWEST record is older than the window is deleted whole —
 * plaintext child location must not sit on flash indefinitely. Feed the watchdog while scanning.
 */
static void backlogBootPurge() {
  uint64_t now = nowGtsMs();
  if (now == 0) return;
  for (int i = 0; i < 2; i++) {
    if (!g_bk.f[i].exists) continue;
    File f = LittleFS.open(BK_PATH[i], FILE_READ);
    if (!f) continue;
    uint64_t newest = 0;
    while (f.available()) {
      String line = f.readStringUntil('\n');
      uint64_t gts = 0;
      if (ft_extract_u64(line.c_str(), "\"gts\":", &gts) && gts > newest) newest = gts;
      esp_task_wdt_reset();
    }
    f.close();
    if (newest > 0 && ft_bk_expired(newest, now)) {
      Serial.printf("[bk] purging %s — newest record is older than the replay window\n", BK_PATH[i]);
      bkFinishFile(i);
    }
  }
  g_bootPurgeDone = true;
}

/** Serial `wipe`: erase every stashed fix + cursors (lost-device / privacy path, F-5). */
static void backlogWipe() {
  for (int i = 0; i < 2; i++) bkFinishFile(i);
  if (LittleFS.exists(BK_LEGACY_PATH)) LittleFS.remove(BK_LEGACY_PATH);
  Serial.println("[bk] backlog deleted (raw flash sectors recoverable until overwritten — see the flash-encryption note in platformio.ini)");
}

// ----------------------- battery / status -----------------------
static float battVolts() {
  if (BATT_ADC_PIN < 0) return 0.0f;
  int raw = analogRead(BATT_ADC_PIN);
  return (raw / 4095.0f) * 3.3f * BATT_DIVIDER * BATT_CAL;
}

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
  doc["rst"]     = g_resetReason;     // F-4: why did the last boot happen
  doc["boot"]    = g_bootCount;       // F-4: a climbing count with short uptimes = brownout/wdt loop
  doc["ver"]     = FW_VERSION;        // F-4: which image is on this child's tracker

  char buf[320];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  if (n == 0 || n >= sizeof(buf)) return;   // never publish a truncated frame
  mqtt.publish(g_statusTopic.c_str(), buf);
}

// ----------------------- config / enrollment -----------------------
// Per-device secrets live in NVS, written once via the serial `enroll` console. This keeps
// the compiled image identical across devices and out of the repo (ADR-0013 hard gate).

// Load the credential set from NVS into the g_* globals. Returns true only when ALL four
// fields are present AND the ids are topic-safe, so a never-enrolled, half-provisioned or
// badly-provisioned device is treated as un-enrolled rather than silently black-holing (F-3).
static bool configLoad() {
  Preferences p;
  p.begin(NVS_NS, /*readOnly=*/true);
  g_wifiSsid = p.getString("wifi_ssid", "");
  g_wifiPass = p.getString("wifi_pass", "");
  g_playerId = p.getString("player_id", "");
  g_mqttPass = p.getString("mqtt_pass", "");
  g_mqttHost = p.getString("mqtt_host", MQTT_HOST);   // optional; falls back to the compiled default
  g_sessionId = p.getString("session_id", SESSION_ID); // optional; falls back to the compiled default (F-6)
  p.end();
  if (!(g_wifiSsid.length() && g_wifiPass.length() &&
        g_playerId.length() && g_mqttPass.length())) return false;
  // F-3: an id with '/' (or '+', '#', a space, 65+ chars) corrupts the topic — the broker routes it, the
  // server's single-level '+' never matches, and every fix disappears with NO error anywhere. Refuse to run.
  if (!ft_id_valid(g_playerId.c_str())) {
    Serial.printf("[cfg] player id %s is not topic-safe ([A-Za-z0-9._-]{1,64}) — re-enroll\n", g_playerId.c_str());
    return false;
  }
  if (!ft_id_valid(g_sessionId.c_str())) {
    Serial.printf("[cfg] session id %s is not topic-safe ([A-Za-z0-9._-]{1,64}) — re-enroll\n", g_sessionId.c_str());
    return false;
  }
  return true;
}

// Print current config to serial, masking the secrets (length only — never echo a
// password back over the wire).
static void enrollShow() {
  Serial.printf("  ssid     = %s\n", g_wifiSsid.length() ? g_wifiSsid.c_str() : "<empty>");
  Serial.printf("  wifipass = %s (%u chars)\n", g_wifiPass.length() ? "set" : "<empty>", g_wifiPass.length());
  Serial.printf("  player   = %s\n", g_playerId.length() ? g_playerId.c_str() : "<empty>");
  Serial.printf("  mqttpass = %s (%u chars)\n", g_mqttPass.length() ? "set" : "<empty>", g_mqttPass.length());
  Serial.printf("  host     = %s\n", g_mqttHost.length() ? g_mqttHost.c_str() : "<default>");
  Serial.printf("  session  = %s\n", g_sessionId.length() ? g_sessionId.c_str() : SESSION_ID);
}

static void enrollHelp() {
  Serial.println(F(
    "enrollment commands (also pipe-friendly: feed these lines over serial):\n"
    "  set ssid <value>       field-AP SSID\n"
    "  set wifipass <value>   field-AP WPA2 PSK\n"
    "  set player <value>     this device's PLAYER_ID (== MQTT username, ACL %u; [A-Za-z0-9._-]{1,64})\n"
    "  set mqttpass <value>   this device's MQTT password\n"
    "  set host <value>       broker host: IP or name.local (optional; default compiled in)\n"
    "  set session <value>    session id for this fixture (optional; [A-Za-z0-9._-]{1,64})\n"
    "  show                   print current values (passwords masked)\n"
    "  save                   validate, write NVS, reboot\n"
    "  clear                  erase stored credentials\n"
    "  quit                   exit without saving (only when a full set is already saved)\n"
    "  help                   this list\n"
    "value is everything after the key (spaces allowed; no quotes).\n"
    "exit: 'save' (writes NVS + reboots) or 'quit' (only when creds are already saved)."));
}

// Block until a full line arrives on serial; strips a trailing CR. Enrollment is a
// deliberate device-offline state, so blocking here is intended (the watchdog is fed).
static String enrollReadLine() {
  String line;
  for (;;) {
    while (!Serial.available()) {
      if (g_portalActive) { g_dns.processNextRequest(); g_web.handleClient(); }
      esp_task_wdt_reset();   // enrollment legitimately waits forever — that's not a wedge
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
      // Remove credentials INDIVIDUALLY — never Preferences.clear(): the namespace also holds
      // seq_hw and boot_count, and wiping seq_hw would restart the sequence at 0 while the
      // server still stores this player's old (device, seq) rows — every re-used seq would be
      // silently swallowed as a duplicate for the retention window (checker finding).
      Preferences p; p.begin(NVS_NS, false);
      p.remove("wifi_ssid"); p.remove("wifi_pass"); p.remove("player_id");
      p.remove("mqtt_pass"); p.remove("mqtt_host"); p.remove("session_id");
      p.end();
      g_wifiSsid = ""; g_wifiPass = ""; g_playerId = ""; g_mqttPass = ""; g_sessionId = SESSION_ID;
      Serial.println("[cfg] cleared (sequence + boot counters kept — they protect replay dedupe)");
      continue;
    }
    if (line == "save") {
      if (!(g_wifiSsid.length() && g_wifiPass.length() &&
            g_playerId.length() && g_mqttPass.length())) {
        Serial.println("[cfg] refusing to save — all four fields are required");
        enrollShow();
        continue;
      }
      // F-3: refuse a topic-unsafe id AT ENROLLMENT — this is where the operator can still fix it.
      if (!ft_id_valid(g_playerId.c_str())) {
        Serial.println("[cfg] refusing to save — player id must match [A-Za-z0-9._-]{1,64} (no '/', '+', '#', spaces)");
        continue;
      }
      if (g_sessionId.length() && !ft_id_valid(g_sessionId.c_str())) {
        Serial.println("[cfg] refusing to save — session id must match [A-Za-z0-9._-]{1,64}");
        continue;
      }
      Preferences p; p.begin(NVS_NS, false);
      // A pending backlog was recorded under the PREVIOUS session — session is the unit of coach
      // access control, so those fixes must never replay into the new session's topic (checker
      // finding). Discard them on a session change.
      String prevSession = p.getString("session_id", SESSION_ID);
      String newSession = g_sessionId.length() ? g_sessionId : String(SESSION_ID);
      if (prevSession != newSession) {
        Serial.println("[cfg] session changed — wiping the pending backlog (it belongs to the old session)");
        backlogWipe();
      }
      p.putString("wifi_ssid", g_wifiSsid);
      p.putString("wifi_pass", g_wifiPass);
      p.putString("player_id", g_playerId);
      p.putString("mqtt_pass", g_mqttPass);
      p.putString("mqtt_host", g_mqttHost);   // optional; defaults to the compiled MQTT_HOST when unset
      p.putString("session_id", newSession);
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
      else if (key == "session")  g_sessionId = val;
      else { Serial.printf("[cfg] unknown key '%s'\n", key.c_str()); continue; }
      if ((key == "player" || key == "session") && !ft_id_valid(val.c_str())) {
        Serial.printf("[cfg] warning: '%s' is not topic-safe ([A-Za-z0-9._-]{1,64}) — save will refuse it\n", val.c_str());
      }
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
  h += F("<br><label>Session ID</label><br>");
  h += "<input name=session value='" + htmlEscape(g_sessionId) + "' style='width:100%;padding:8px;margin:4px 0'>";
  h += F("<br><br><button type=submit style='width:100%;padding:12px;font-size:16px'>Save &amp; reboot</button>"
         "</form></body></html>");
  g_web.send(200, "text/html", h);
  WiFi.scanDelete();
}

// POST /save: validate the required fields (+ topic-safe ids, F-3), write NVS, reboot into normal operation.
static void portalSave() {
  String ssid = g_web.arg("ssid"), wifipass = g_web.arg("wifipass");
  String player = g_web.arg("player"), mqttpass = g_web.arg("mqttpass"), host = g_web.arg("host");
  String session = g_web.arg("session");
  if (!ssid.length() || !wifipass.length() || !player.length() || !mqttpass.length()) {
    g_web.send(400, "text/html",
               F("<p>SSID, Wi-Fi password, player and MQTT password are required. <a href=/>back</a></p>"));
    return;
  }
  if (!ft_id_valid(player.c_str()) || (session.length() && !ft_id_valid(session.c_str()))) {
    g_web.send(400, "text/html",
               F("<p>Player/session ids must match [A-Za-z0-9._-]{1,64} — no '/', '+', '#' or spaces. <a href=/>back</a></p>"));
    return;
  }
  if (!host.length()) host = MQTT_HOST;
  if (!session.length()) session = SESSION_ID;
  Preferences p; p.begin(NVS_NS, false);
  if (p.getString("session_id", SESSION_ID) != session) {
    Serial.println("[portal] session changed — wiping the pending backlog (it belongs to the old session)");
    backlogWipe();
  }
  p.putString("wifi_ssid", ssid);
  p.putString("wifi_pass", wifipass);
  p.putString("player_id", player);
  p.putString("mqtt_pass", mqttpass);
  p.putString("mqtt_host", host);
  p.putString("session_id", session);
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

// Non-blocking: lets an operator type `enroll` / `portal` / `wipe` over serial during normal
// operation (re-provisioning, PSK rotation, lost-device privacy wipe — ADR-0013 playbook).
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
      else if (line == "wipe") backlogWipe();   // F-5: erase every stashed fix from flash
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
  Serial2.setRxBufferSize(GPS_RX_BUFFER);   // MUST precede begin(); rides out the ~3 s TCP connect stall
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

// ----------------------- fix handling -----------------------
static void handleFix(bool connected) {
  int fixType = gnss.getFixType();   // 0=none 2=2D 3=3D
  int siv     = gnss.getSIV();
  g_lastFix   = fixType;             // remembered for the .../status frame
  g_lastSats  = siv;

  // GPS-UTC time of THIS fix (F-2). Valid only once the receiver has date+time; 0 until then —
  // the server then falls back to arrival time, exactly like pre-Phase-4 packets.
  uint64_t gts = 0;
  if (gnss.getTimeValid() && gnss.getDateValid()) {
    uint32_t us = 0;
    uint32_t epoch = gnss.getUnixEpoch(us);
    gts = (uint64_t)epoch * 1000ULL + us / 1000ULL;
    g_lastGtsMs = gts;
    g_lastGtsAtMs = millis();
  }

  uint32_t seq;
  if (ft_seq_take(&g_seq, &seq)) {
    nvsPutU32("seq_hw", g_seq.hw);   // persist the new ceiling BEFORE the seq is used (crash safety)
  }

  // u-blox NAV-PVT gSpeed and headMot are SIGNED (near-stationary noise can dip gSpeed below 0;
  // headMot's wire type allows negatives) — the server hard-rejects spd<0 / hdg outside [0,360],
  // so clamp/normalise HERE, at the source, rather than lose whole fixes (checker finding).
  int32_t gspd = gnss.getGroundSpeed();
  if (gspd < 0) gspd = 0;
  double hdg = gnss.getHeading() / 1e5;   // deg
  while (hdg < 0) hdg += 360.0;
  while (hdg >= 360.0) hdg -= 360.0;

  JsonDocument doc;
  doc["id"]   = g_clientId;
  doc["pl"]   = g_playerId;
  doc["ts"]   = millis();                                          // device clock (ordering only)
  doc["lat"]  = serialized(String(gnss.getLatitude()  / 1e7, 7)); // 7 dp ~1cm
  doc["lon"]  = serialized(String(gnss.getLongitude() / 1e7, 7));
  doc["spd"]  = gspd / 1000.0;                                    // mm/s -> m/s, clamped >= 0
  doc["hdg"]  = hdg;
  doc["fix"]  = fixType;
  doc["sats"] = siv;
  doc["pdop"] = gnss.getPDOP() / 100.0;
  doc["sq"]   = seq;                                              // F-1: server dedupes replays on this
  doc["gts"]  = gts;                                              // F-2: the fix's real (GPS-UTC) time, ms

  char buf[384];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  if (n == 0 || n >= sizeof(buf)) return;   // never publish/stash a truncated frame

  // Only POSITION fixes (2=2D, 3=3D, 4=GNSS+DR) are worth flash: the server drops everything else
  // as no_fix, and pre-match indoor no-fix churn at 10 Hz (~2 KB/s) used to evict real stashed
  // fixes under drop-oldest (checker finding). Live no-fix publishes still go out when connected —
  // the server's drop counter is a useful bring-up diagnostic.
  bool positionFix = fixType >= 2 && fixType <= 4;
  if (connected && mqtt.publish(g_topic.c_str(), buf)) {
    g_pubCount++;
  } else if (positionFix) {
    backlogAppend(buf);    // offline -> stash to flash, replayed paced+deduped later
  }
}

// ----------------------- main -----------------------
void setup() {
  Serial.begin(115200);
  delay(200);
  LittleFS.begin(true);   // format on first boot if needed

  // F-4: who rebooted us, and how often. A climbing boot count with short uptimes is a
  // brownout/watchdog loop — visible on /metrics via the status frame instead of invisible.
  g_resetReason = (int)esp_reset_reason();
  g_bootCount = nvsGetU32("boot_count", 0) + 1;
  nvsPutU32("boot_count", g_bootCount);
  Serial.printf("[boot] %s boot=%lu reset_reason=%d\n", FW_VERSION, (unsigned long)g_bootCount, g_resetReason);

  // F-4: hardware watchdog — a wedged loop reboots (and says so in `rst`) instead of dying
  // silently on a child's ankle until someone power-cycles it.
  esp_task_wdt_init(WDT_TIMEOUT_S, true);
  esp_task_wdt_add(NULL);

  // Secrets come from NVS, not source. If this device has never been enrolled (or NVS was
  // wiped, or an id is not topic-safe — F-3), refuse to run — block in the enrollment console
  // until a valid set is saved, which then reboots into normal operation.
  if (!configLoad()) {
    Serial.println("[cfg] no/invalid credentials in NVS — starting Wi-Fi setup (phone portal + serial console)");
    startPortal();
    enrollConsole();
  }

  // F-1: resume the sequence ABOVE everything possibly used before the reboot, and persist
  // the new ceiling before the first fix can publish. A device with NO stored high water (fresh
  // NVS after a full erase/reflash) starts from a RANDOM 2^20-aligned base instead of 0: the
  // server dedupes on (player_id, device_id, seq), and a re-flashed device restarting at 0 would
  // collide with its own retained rows and be silently swallowed for up to 30 days.
  uint32_t storedHw = nvsGetU32("seq_hw", 0);
  if (storedHw == 0) storedHw = ((esp_random() & 0x3FF) + 1) << 20;   // 1..1024 Mi-aligned base
  g_seq = ft_seq_boot_resume(storedHw);
  nvsPutU32("seq_hw", g_seq.hw);

  bkAdoptLegacy();
  bkReconcile();

  buildIds();
  gpsBegin();
  Serial.printf("[net] client=%s topic=%s backlog=%u B\n", g_clientId, g_topic.c_str(), (unsigned)backlogBytes());
}

void loop() {
  esp_task_wdt_reset();
  mqtt.loop();
  pollSerialCommands();   // honour `enroll` / `portal` / `wipe` typed over serial

  // Non-blocking connectivity: never stalls the GPS drain below for more than one bounded
  // TCP attempt; failures back off with jitter.
  bool connected = netTick();

  // Drain EVERY queued PVT solution (the RX buffer holds ~8 s of them) — one fix, one packet.
  int drained = 0;
  while (gnss.getPVT() && drained++ < GPS_DRAIN_MAX) {
    handleFix(connected);
  }

  // F-5: once GPS time is valid, purge any stashed fixes that outlived the replay window.
  if (!g_bootPurgeDone && g_lastGtsMs != 0) backlogBootPurge();

  // Paced backlog replay: ONE record per pass, ~30/s — the server's cap (50/s) fits this
  // plus live 10 Hz. The cursor makes it crash-safe; the server's sq dedupe makes re-sends free.
  backlogFlushTick();

  // Low-rate device-health heartbeat (best-effort).
  static uint32_t lastStatus = 0;
  if (connected && millis() - lastStatus >= STATUS_INTERVAL_MS) {
    publishStatus();
    lastStatus = millis();
  }
}
