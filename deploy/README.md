# deploy/

Local development deployment assets for the Docker Compose dev stack (broker + server).

**There is no separate dev broker config any more.** `deploy/mosquitto/mosquitto.conf` used to hold an
`allow_anonymous true` broker for the bench stack, and `docker-compose.yml` mounted it — so any host on
the Wi-Fi could subscribe to every child's 10 Hz feed, or publish forged telemetry the server accepted,
server-stamped and persisted as authoritative (audit §4.6, proven live). It has been deleted rather than
left lying around for the next copy-paste; the stack now mounts the **authenticated** config that was
already in the repo — [`server/mosquitto/`](../server/mosquitto/README.md) (`allow_anonymous false` +
per-device ACLs, [ADR-0007](../docs/decisions/0007-mqtt-security.md)) — so dev and field run the same
auth path and a bench run exercises it every time.

The stack itself is [`../docker-compose.yml`](../docker-compose.yml). To run the whole pipeline with a real
wearable on your Mac, follow [docs/dev/local-bench-runbook.md](../docs/dev/local-bench-runbook.md)
([ADR-0021](../docs/decisions/0021-local-dev-docker-stack.md)).

```sh
./server/mosquitto/dev-provision.sh   # once: broker accounts + .env (ft.passwd is gitignored)
docker compose up -d                  # broker + server
# coach view runs on the host (not in the stack — see the runbook):
cd client && VITE_PROXY_TARGET=http://127.0.0.1:3007 bun run dev
```

`127.0.0.1:3007`, not `localhost:3007`: the server's published port is pinned to the IPv4 loopback
(the live view needs no login on this stack, so it must not be LAN-reachable), and `localhost` can
resolve to `::1` first.
