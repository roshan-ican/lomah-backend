# LOMAH virtual-range backend

This Compose setup runs a **test-only** NestJS backend plus four stateful,
virtual WiFi targets. Its SQLite database is stored in Docker volume
`lomah-range-test-data`, never in Electron's app-data directory or this
repository.

From `lomah-nest`, start it with:

```powershell
docker compose -f docker/compose.yml up --build
```

The Docker backend's HTTP API and Socket.IO server are available at
`http://localhost:3301` and `http://localhost:3001`. It deliberately does not
package the React UI.

To control the virtual range from the normal frontend with no source-code
changes, open a second terminal in `frontend` and run:

```powershell
$env:DEV_BACKEND_PORT = '3301'
npm run dev:web
```

Open the browser UI at `http://localhost:3000`. Vite proxies its REST API and
Socket.IO traffic to the Docker backend on port 3301, so the admin board sees
the Docker-created lanes exactly as if they were physical targets on the LAN.

`range-seed` creates four virtual lanes and targets automatically. Sign in with
`superadmin` / `changeme123`, create and start one session for each lane, and
the corresponding simulator will echo PLAY and send its scenario shots.

The first lane reproduces the important real-shot recovery case you supplied:
normal hits, a `(0,0)` no-detection shot, missing bullet numbers, delayed
read-shot recovery, and a read request that is deliberately ignored once.
Lanes 2–4 fire independent normal/miss sequences concurrently. Their schedules
are deliberately staggered across lane 1's replay window, so a bulk start
produces interleaved shots from several lanes instead of one lane finishing
before another begins. The backend
receives simulated target UDP frames on host port `14555` and advertises
discovery beacons on UDP `5002`.

Every simulator begins its sequence only when its session sends PLAY, stops
immediately on STOP, and replays on the next session start. You do not click
anything per bullet. Lane 1's timing is taken from the supplied real log;
Compose uses `TIME_SCALE=0.1` so it is ten times faster for development. Change
that value to `1` on a target service to replay at real elapsed time. Read-shot
answers deliberately keep their real 600–700 ms delay: making them faster
would turn a real `(0,0)` response into a protocol echo rather than testing the
recovery path.

## Two shooter devices on the LAN

Keep the frontend dev server running as described above. Find the LAN IPv4
address of the computer running Docker and Vite (for example `192.168.1.20`).
On each shooter tablet, while connected to the same WiFi, open:

```text
http://192.168.1.20:3000/station/unassigned
```

The waiting screen contacts the Docker backend at the same computer on its
standard port `3001`, registers that tablet as an unassigned device, and waits.
Log in to the admin board on the computer as `admin` / `admin123`, open the
Shooter Devices / Lane Assignment panel, and assign each listed device to a
different virtual lane. Each tablet moves automatically to its lane display.

Do not use `localhost` on a tablet: it means the tablet itself, not the
computer running the virtual range. If Windows asks about firewall access for
Docker or Vite, allow it on private networks only.

To stop it, press `Ctrl+C` and run:

```powershell
docker compose -f docker/compose.yml down
```

To remove only the disposable simulation database as well:

```powershell
docker compose -f docker/compose.yml down -v
```

## Adding target simulators

Each simulated target joins `range-lan` with a unique fixed address and sends
its normal UDP hit/telemetry frames to `172.30.0.10:14555`. The seeder configures
the matching target record automatically, so the backend uses the same
source-IP target resolution and command traffic as it does with physical boards.

The backend sends PLAY/STOP/read-shot commands to each target on UDP `14550`.
The simulator stores shots and answers read-shot requests, while acknowledging
PLAY, so `SENSOR_REQUIRE_ACK` remains intentionally enabled.
