# LOMAH NestJS rewrite — migration status

Honest gap analysis of `lomah-nest` against the Express backend it is meant to
replace. Updated 2026-08-03.

**Headline: the foundation is done, the feature surface is roughly half.** Every
architectural decision that is expensive to change later has been made and
built. What remains is mostly breadth — endpoints and lifecycle states that are
individually straightforward.

---

## Done

| Area | State |
|---|---|
| Domain model | Prisma schema, redesigned. Lane → Target[] → Session → SessionStage[] → Shot |
| Transport layer | `TargetTransport` interface, `WifiUdpTransport`, `TransportRegistry` |
| Wire protocol | `frame.codec.ts` ported verbatim, `SequenceTracker` with rollover handling + tests |
| Command/handshake | `TargetCommandService` — keyed by target id, fixes the original singleton-ack bug |
| Auth | JWT login, global guard, `@Roles`/`@Public`/`@CurrentUser`, bcrypt |
| Lanes | Full CRUD + `setActiveTarget` |
| Targets | Full CRUD, calibration offsets, resolver cache invalidation |
| Sessions | create / start / advance / stop, stage sequencing, lane-target validation |
| Ingestion | `SensorService` — resolve → dedup → score → persist, per-target serialisation |
| Scoring | `scoring.ts` pure + unit tests (sentinel handling, sign correction, offsets) |
| Session lifecycle | pause / resume / end / feedback / reset-stage, `totalPausedMs` wired |
| Stage timing | `StageMonitorService` — polls and auto-advances on expiry, pause-aware |
| Bullet limit | Reaching the limit now ends the stage, not just rejects the shot |
| Crash recovery | `SessionRecoveryService` — reconciles interrupted sessions on boot |
| Transactions | `start`/`advance`/`stop`/`end` atomic; hardware I/O kept outside |
| Shooters | Full CRUD, delete refused once session history exists |
| Realtime | Rooms (`admin`, `lane:N`), handshake JWT auth, `join-lane`/`leave-lane` |

### Architectural wins over the old system

These are the reasons the rewrite was worth doing, and they are already banked:

- **Multi-target lanes.** The old schema had one target per lane and calibration
  offsets stored on the *lane*, silently applying one target's mounting error to
  every other. Now offsets live on the hardware they describe.
- **Handshake concurrency.** The old code held a single module-level ack
  resolver, so arming a second lane inside the ack window resolved the first
  lane's promise off the wrong echo. Now keyed per target.
- **No global sensor host fallback.** `resolveSensorHost()` fell back to a shared
  `ESP_HOST`, so an unprovisioned lane fired commands at another lane's board.
  Now it fails loudly.
- **Stage-scoped scoring profile.** Re-facing a target can no longer retroactively
  rescore a stage that already happened.

---

## Missing

Ordered by how much they block a real deployment.

### 1. Calibration workflow — BLOCKING for commissioning

Old backend: `calibrateShot`, `calibrateLane`, `setLaneOffset`, plus
`shot:calibrated` / `lane:calibrated` broadcasts. None of this is ported. The
`offsetXmm`/`offsetYmm` columns exist and can only be set by hand via the
targets endpoint.

### 2. Reports — needed by the frontend

`GET /reports/sessions`, `/reports/session/:id`, `/reports/shooters/:username`,
`/reports/shooters/:username/shots`. Nothing ported.

### 3. Shooter-facing auth

Roster CRUD is done. Still missing: `shooter-login`, `register`, `connect`,
`connected-shooters`, and lane assignment.

### 4. Realtime lifecycle events

Rooms and auth are in. `shot` is still the only event emitted. Missing:
`session:created`, `session:started`, `session:paused`, `session:resumed`,
`session:completed`, `session:cancelled`, `session:reviewed`,
`session:shots_reset`, `shot:calibrated`, `lane:calibrated`, `sensor:gate`,
`shooter:unassigned`, `user:assigned`, `lane:disconnected`.

The wiring pattern is established — `SessionsService` needs its own event
subject that the gateway subscribes to, mirroring `SensorService.shots$`.

### 5. Sensor gate

`setAdminHeld` / `isSensorAcceptingHits` — the admin's "stop accepting hits"
control. Not ported.

### 6. Discovery and provisioning

UDP beacon so tablets find the server unaided, plus `/system/info`,
`/system/lanes/sensors`, `sensor-ip`, `client-ip`, `client-devices/assign`. The
`ClientDevice` model exists; nothing uses it.

### 7. Smaller gaps

- `/health` endpoint (excluded from the global prefix in `main.ts`, never written)
- Debug routes (`/simulate-shot`) — partly covered by `scripts/simulate-shots.ts`
- Shot buffer / write-through on crash
- Telemetry `rssi` decode (payload layout unconfirmed against firmware)
- Pre-flight "target is online" check before arming a stage — deliberately
  deferred, depends on telemetry `lastSeenAt` which now exists

---

## Decided

**Frontend.** Backend is finished against the new architecture first; the
frontend is then modified to match. No compatibility layer — the old
`/session/:laneId` shape assumed one target per lane, which is the premise the
rewrite exists to remove, so serving it would mean preserving the bug in the
API.

---

## Remaining order

1. Session lifecycle WS events — the frontend needs these to be rebuilt against
2. Calibration
3. Reports
4. Shooter-facing auth + lane assignment
5. Discovery + sensor gate
