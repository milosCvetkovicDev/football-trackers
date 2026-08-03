# Broker config (authenticated)

The broker runs `allow_anonymous false` with a per-device ACL ([ADR-0007](../../docs/decisions/0007-mqtt-security.md)).
Children's live positions must never be readable by an anonymous client on the LAN.

**This directory is also the DEV broker now.** `docker-compose.yml` mounts it read-only at
`/mosquitto/config`, so the bench stack runs the same authenticated config as the field — it used to load a
separate `allow_anonymous true` file, which meant any host on the Wi-Fi could subscribe to every child's 10 Hz
feed or publish forged telemetry the server accepted and persisted as authoritative (audit §4.6, proven live).
The paths inside [`mosquitto.conf`](mosquitto.conf) are therefore the **container** paths; running the broker
directly on a host means pointing them somewhere else.

## 0. Local dev: one command

For the Docker stack, skip the manual steps below — this generates the accounts, sets file modes, and writes
the `.env` compose reads:

```sh
./server/mosquitto/dev-provision.sh 01 02     # server 'ingest' account + wearables 01 and 02
```

It prints each wearable's password **once** (that is what you enroll into the device, §3 below) and refuses to
overwrite an existing `ft.passwd` without `--force`. Passwords are generated, not typed, and land on a
`mosquitto_passwd -b` command line — acceptable for a laptop bench, which is why the field accounts below are
created interactively instead. Re-running it rotates the credentials, so follow with `docker compose up -d`;
`docker compose restart` does **not** re-read `.env`, and the server would keep the old password and fail to
subscribe (which looks like a broker fault, not a stale secret).

## 1. Create the password file (field / manual)

One server account + one account per wearable (**username = the device's `PLAYER_ID`**, so the
`%u` pattern in [`ft.acl`](ft.acl) scopes each device to its own topic):

```sh
cd server/mosquitto
mosquitto_passwd -c ft.passwd ingest    # server ingest account (prompts for a strong password)
mosquitto_passwd    ft.passwd 01        # wearable PLAYER_ID 01 (unique password per device)
mosquitto_passwd    ft.passwd 02        # wearable PLAYER_ID 02
# ... one line per device
```

`ft.passwd` holds hashed passwords — but still keep it out of git and readable only by the broker.

## 2. Start the broker

```sh
mosquitto -c mosquitto.conf       # adjust the password_file/acl_file paths in the conf as needed
```

## 3. Point the server and the wearables at it

- **Server** (reads everything): set env `MQTT_USERNAME=ingest` and `MQTT_PASSWORD=<ingest pw>`
  (the server falls back to anonymous only if `MQTT_USERNAME` is unset, for local dev).
- **Firmware**: the MQTT username **is** the device's `PLAYER_ID` and the password is that device's unique
  secret — both live in **NVS, not source** ([ADR-0014](../../docs/decisions/0014-firmware-secret-provisioning.md)),
  set once over serial with the `enroll` console (`set player <id>` / `set mqttpass <pw>` / `save`). Provision a
  different password per device; the `<id>` must match an account you created with `mosquitto_passwd` above.

## Lost / stolen wearable

Revoke just that device without touching the others:

```sh
mosquitto_passwd -D ft.passwd 07   # delete player 07's account
# then restart the broker (or reload). Re-issue with a new password when the device returns.
```

If the shared WiFi PSK was on the lost device, also rotate the field-AP PSK before the next session
(see [ADR-0013](../../docs/decisions/0013-field-network-security.md)).
