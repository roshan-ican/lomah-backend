import dgram from 'node:dgram';
import { readFile } from 'node:fs/promises';

const HEADER = 0x24;
const TRAILER = 0x23;
const CMD_PLAY = 0x50;
const CMD_STOP = 0x53;
const CMD_HIT = 0x4c;
const CMD_TELEMETRY = 0x3a;

const name = required('TARGET_NAME');
const scenarioPath = process.env.SCENARIO_FILE ?? '/scenarios/real-shot.json';
const commandPort = integerEnv('TARGET_COMMAND_PORT', 14550);
const backendPort = integerEnv('BACKEND_UDP_PORT', 14555);
const telemetryEveryMs = integerEnv('TELEMETRY_INTERVAL_MS', 5000);
const timeScale = positiveNumberEnv('TIME_SCALE', 1);

const scenario = JSON.parse(await readFile(scenarioPath, 'utf8'));
const target = scenario.targets?.[name];
if (!target) {
  throw new Error(`No target named "${name}" in ${scenarioPath}`);
}

const socket = dgram.createSocket('udp4');
let armed = false;
let ranScenario = false;
let backendHost = process.env.BACKEND_HOST ?? '';
let timers = [];
const readAttempts = new Map();

socket.on('error', (error) => {
  console.error(`[${name}] UDP error: ${error.message}`);
});

socket.on('message', (message, remote) => {
  if (message.length < 9 || message[0] !== HEADER || message[8] !== TRAILER) return;
  if (!validCrc(message)) {
    console.warn(`[${name}] ignored command with invalid CRC from ${remote.address}`);
    return;
  }

  backendHost = remote.address;
  const command = message[1];
  if (command === CMD_PLAY) {
    armed = true;
    sendFrame(buildFrame(CMD_PLAY), remote.address, remote.port);
    console.log(`[${name}] PLAY echoed; target armed`);
    if (!ranScenario || target.repeatOnPlay === true) runScenario();
    return;
  }

  if (command === CMD_STOP) {
    armed = false;
    clearTimers();
    sendFrame(buildFrame(CMD_STOP), remote.address, remote.port);
    console.log(`[${name}] STOP echoed; target disarmed`);
    return;
  }

  // The real protocol uses an L frame with an empty coordinate payload to ask
  // the board to replay a stored bullet. It is intentionally the same opcode
  // as an ordinary hit.
  if (command === CMD_HIT && message[3] === 0 && message[4] === 0 && message[5] === 0 && message[6] === 0) {
    handleReadRequest(message[2], remote.address, remote.port);
    return;
  }

  // Other diagnostic commands are safely echoed, which makes this simulator
  // useful for commissioning checks too.
  sendFrame(buildFrame(command, [...message.subarray(2, 7)]), remote.address, remote.port);
});

socket.bind(commandPort, '0.0.0.0', () => {
  const address = socket.address();
  console.log(`[${name}] virtual target listening on ${address.address}:${address.port}`);
});

if (telemetryEveryMs > 0) {
  setInterval(() => {
    if (backendHost) sendFrame(buildFrame(CMD_TELEMETRY), backendHost, backendPort);
  }, telemetryEveryMs).unref();
}

function runScenario() {
  clearTimers();
  ranScenario = true;
  readAttempts.clear();
  console.log(`[${name}] starting scenario with ${(target.shots ?? []).length} live frames`);

  for (const shot of target.shots ?? []) {
    const delay = Number(shot.afterMs);
    if (!Number.isFinite(delay) || delay < 0) {
      throw new Error(`[${name}] every shot needs a non-negative afterMs`);
    }
    const timer = setTimeout(() => {
      if (!armed) return;
      sendHit(shot, backendHost, backendPort);
    }, scaledDelay(delay));
    timers.push(timer);
  }
}

function handleReadRequest(bulletCounter, host, port) {
  const attempt = (readAttempts.get(bulletCounter) ?? 0) + 1;
  readAttempts.set(bulletCounter, attempt);
  const stored = (target.storedShots ?? []).find((shot) => shot.bulletCounter === bulletCounter);
  if (!stored) {
    console.log(`[${name}] READ #${bulletCounter}, but no stored response exists`);
    return;
  }
  if (attempt <= (stored.ignoreReadAttempts ?? 0)) {
    console.log(`[${name}] READ #${bulletCounter} attempt ${attempt} deliberately ignored`);
    return;
  }

  const delay = Number(stored.replyAfterReadMs ?? 700);
  console.log(
    `[${name}] READ #${bulletCounter} attempt ${attempt}; replaying in ${delay}ms`,
  );
  // Do not scale read replies. The backend classifies a zero-coordinate reply
  // received inside 120 ms as the board echoing its command, rather than as a
  // genuine answer. Keeping the physical ~600–700 ms lookup delay makes the
  // no-detection recovery path faithful even when live shots are accelerated.
  const timer = setTimeout(() => sendHit(stored, host, port), delay);
  timers.push(timer);
}

function sendHit(shot, host, port) {
  if (!host) return;
  const frame = buildHitFrame(shot.wireX, shot.wireY, shot.bulletCounter);
  sendFrame(frame, host, port);
  console.log(
    `[${name}] HIT #${shot.bulletCounter} wire=(${shot.wireX}, ${shot.wireY}) -> ${host}:${port}`,
  );
}

function sendFrame(frame, host, port) {
  socket.send(frame, port, host, (error) => {
    if (error) console.error(`[${name}] UDP send failed: ${error.message}`);
  });
}

function buildHitFrame(x, y, bulletCounter) {
  const x16 = signed16(x);
  const y16 = signed16(y);
  return buildFrame(CMD_HIT, [bulletCounter, x16 >> 8, x16, y16 >> 8, y16]);
}

function buildFrame(command, data = [0, 0, 0, 0, 0]) {
  const frame = Buffer.alloc(9);
  frame[0] = HEADER;
  frame[1] = command & 0xff;
  for (let index = 0; index < 5; index += 1) frame[index + 2] = data[index] & 0xff;
  frame[7] = crc(frame[1], [...frame.subarray(2, 7)]);
  frame[8] = TRAILER;
  return frame;
}

function validCrc(frame) {
  return frame[7] === crc(frame[1], [...frame.subarray(2, 7)]);
}

function crc(command, data) {
  return (0x24 + command + data.reduce((sum, byte) => sum + (byte & 0xff), 0)) & 0xff;
}

function signed16(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < -32768 || number > 65535) {
    throw new Error(`[${name}] wire coordinates must be 16-bit integers; received ${value}`);
  }
  return number & 0xffff;
}

function required(key) {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function integerEnv(key, fallback) {
  const value = Number(process.env[key] ?? fallback);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`${key} must be a valid port or interval`);
  }
  return value;
}

function positiveNumberEnv(key, fallback) {
  const value = Number(process.env[key] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive number`);
  }
  return value;
}

function scaledDelay(milliseconds) {
  return Math.round(milliseconds * timeScale);
}

function clearTimers() {
  for (const timer of timers) clearTimeout(timer);
  timers = [];
}

process.on('SIGTERM', () => {
  clearTimers();
  socket.close();
});
