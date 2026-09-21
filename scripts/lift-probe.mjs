const ip = process.argv[2];
const pin = process.argv[3] ?? '2';
const durationMs = Number(process.argv[4] ?? 5000);
const intervalMs = 50;

if (!ip) {
  console.error('usage: node scripts/lift-probe.mjs <ip> [pin=2] [durationMs=5000]');
  process.exit(1);
}

const get = async (path) => {
  const res = await fetch(`http://${ip}${path}`, { signal: AbortSignal.timeout(2500) });
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
  return res;
};

const status = async () => {
  const body = await (await get('/gpio_status')).json();
  return `d1=${body.d1 ? 'ON' : 'off'} d2=${body.d2 ? 'ON' : 'off'}`;
};

console.log(`before: ${await status()}`);
const t0 = performance.now();
await get(`/toggle?pin=${pin}`);
console.log(`toggle pin ${pin} sent (${Math.round(performance.now() - t0)} ms)`);

let last = '';
while (performance.now() - t0 < durationMs) {
  const s = await status();
  if (s !== last) {
    console.log(`${String(Math.round(performance.now() - t0)).padStart(5)} ms  ${s}`);
    last = s;
  }
  await new Promise((r) => setTimeout(r, intervalMs));
}
console.log('done — watch the target and compare its travel time with the log');
