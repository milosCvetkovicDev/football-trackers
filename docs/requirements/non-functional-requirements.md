# Non-Functional Requirements

| ID | Requirement | Target / note |
|---|---|---|
| NFR-RT-1 | End-to-end live latency | < 1 s (fix age + WiFi + broker + backend + WS) |
| NFR-RATE-1 | GPS sample rate | 10 Hz (NEO-M8N/M9N); **not** NEO-6M (~1 Hz smears sprints) |
| NFR-RATE-2 | IMU rate (physical) | 50–100 Hz |
| NFR-RATE-3 | IMU rate (technical / shot detection) | ≥200 Hz, ideally 500 Hz (ball contact ~5–15 ms) |
| NFR-COV-1 | Field coverage | One outdoor 2.4 GHz AP, line-of-sight ~100 m, 10 devices |
| NFR-ACC-1 | Positional accuracy | ~2–5 m (consumer GPS) — adequate for youth trends |
| NFR-RES-1 | Connectivity resilience | Buffer fixes to flash (LittleFS) on WiFi drop, replay on reconnect; stale frames flagged so the live view ignores them |
| NFR-RES-2 | Telemetry loss tolerance | QoS 0 — a dropped frame at 10 Hz is invisible |
| NFR-SCALE-1 | Throughput | 10 players × 10 Hz ≈ 100 msg/s (trivial) |
| NFR-PWR-1 | Battery endurance | ≥ one ~90-min session; 1S LiPo ~1000–1350 mAh @ ~150–250 mA → 6–8 h |
| NFR-DURA-1 | Wearable durability | Sweat is the main enemy — conformal coating / sealed enclosure |
| NFR-COST-1 | Build cost | ~€30–50/unit → ~€300–500 for 10; one-time, no subscription |
| NFR-OWN-1 | Data ownership | Local storage, full export, no vendor lock-in |
| NFR-TIME-1 | Timestamp authority | Server-stamp on receipt (WiFi latency ~ms) — avoid device clock sync |

See [system-architecture.md](../architecture/system-architecture.md) for how these are met.
