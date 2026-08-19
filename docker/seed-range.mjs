const backend = process.env.BACKEND_URL ?? 'http://backend:3001';
const username = process.env.LOMAH_BOOTSTRAP_USER ?? 'superadmin';
const password = process.env.LOMAH_BOOTSTRAP_PASSWORD ?? 'changeme123';

await waitForHealth();
const login = await json('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ username, password }),
});
const token = login.accessToken;
if (!token) throw new Error('login response did not include an access token');

const targets = [
  { laneName: 'Virtual Lane 1', label: '100M', ipAddress: '172.30.0.21' },
  { laneName: 'Virtual Lane 2', label: '100M', ipAddress: '172.30.0.22' },
  { laneName: 'Virtual Lane 3', label: '100M', ipAddress: '172.30.0.23' },
  { laneName: 'Virtual Lane 4', label: '100M', ipAddress: '172.30.0.24' },
];

let lanes = await json('/api/lanes', { token });
let existingTargets = await json('/api/targets', { token });

for (const spec of targets) {
  let lane = lanes.find((candidate) => candidate.name === spec.laneName);
  if (!lane) {
    lane = await json('/api/lanes', {
      token,
      method: 'POST',
      body: JSON.stringify({ name: spec.laneName, siteName: 'Docker virtual range' }),
    });
    lanes = [...lanes, lane];
    console.log(`created ${spec.laneName}`);
  }

  if (!existingTargets.some((target) => target.ipAddress === spec.ipAddress)) {
    const target = await json('/api/targets', {
      token,
      method: 'POST',
      body: JSON.stringify({
        laneId: lane.id,
        label: spec.label,
        distanceM: 100,
        positionIndex: 0,
        ipAddress: spec.ipAddress,
        profileType: 'FIGURE',
      }),
    });
    existingTargets = [...existingTargets, target];
    console.log(`commissioned ${spec.laneName} target at ${spec.ipAddress}`);
  }
}

console.log('virtual range ready: 4 lanes and 4 targets');

async function waitForHealth() {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      const response = await fetch(`${backend}/health`);
      if (response.ok) return;
    } catch {
      // The backend may still be applying its SQLite migrations.
    }
    await delay(500);
  }
  throw new Error(`backend did not become healthy at ${backend}`);
}

async function json(path, options = {}) {
  const headers = { 'content-type': 'application/json' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(`${backend}${path}`, { ...options, headers });
  const body = await response.text();
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${path} failed (${response.status}): ${body}`);
  return body ? JSON.parse(body) : undefined;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
