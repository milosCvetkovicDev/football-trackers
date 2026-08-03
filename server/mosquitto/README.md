# Broker config (authenticated)

The broker runs `allow_anonymous false` with a per-device ACL ([ADR-0007](../../docs/decisions/0007-mqtt-security.md)).
Children's live positions must never be readable by an anonymous client on the LAN.

## 1. Create the password file

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
