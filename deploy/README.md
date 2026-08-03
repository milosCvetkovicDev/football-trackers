# deploy/

Local development deployment assets for the Docker Compose dev stack (broker + server).

- [`mosquitto/mosquitto.conf`](mosquitto/mosquitto.conf) — mosquitto config mounted into the `eclipse-mosquitto`
  container. **Anonymous, isolated-LAN dev only** (no auth); production uses the field AP broker with per-device
  auth + ACLs (see [`server/mosquitto/`](../server/mosquitto/README.md), [ADR-0007](../docs/decisions/0007-mqtt-security.md)).

The stack itself is [`../docker-compose.yml`](../docker-compose.yml). To run the whole pipeline with a real
wearable on your Mac, follow [docs/dev/local-bench-runbook.md](../docs/dev/local-bench-runbook.md)
([ADR-0021](../docs/decisions/0021-local-dev-docker-stack.md)).

```sh
docker compose up -d            # broker + server
# coach view runs on the host (not in the stack — see the runbook):
cd client && VITE_PROXY_TARGET=http://localhost:3007 bun run dev
```
