import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

/**
 * Bench seed — enough of a range to actually run a relay by hand.
 *
 * Everything is upserted, so re-running (`npm run db:seed`) is safe and never
 * fails on a duplicate.
 *
 * Addressing follows 10.0.<laneId>.<n>, so a target's IP says which lane it
 * belongs to at a glance. Lane 1's first target is the exception: it is
 * 127.0.0.1 so `npx tsx scripts/simulate-shots.ts` — which sends real UDP
 * frames from this machine and therefore arrives as loopback — is attributed
 * to it. Attribution is BY SOURCE IP, so without that row a simulated shot is
 * correctly logged as unassigned and dropped.
 */

const LANES = [
  { id: 1, name: 'Lane 1', siteName: 'Bench' },
  { id: 2, name: 'Lane 2', siteName: 'Bench' },
  { id: 3, name: 'Lane 3', siteName: 'Range A' },
  { id: 4, name: 'Lane 4', siteName: 'Range A' },
];

/**
 * Desired targets. `positionIndex` is NOT specified here on purpose: it is
 * allocated against whatever is already in the database.
 *
 * `Target` has two independent unique constraints — `ipAddress`, and
 * `[laneId, positionIndex]` — so a naive upsert on a database that already has
 * targets will violate the second one (e.g. seeding lane 1 slot 0 when slot 0
 * is already held by a different address). Positions are therefore resolved at
 * run time, which is what makes this safe to run against an existing range.
 */
const TARGETS = [
  // 127.0.0.1 is the simulator target — see the note at the top of this file.
  { laneId: 1, label: 'Bench (sim)', distanceM: 50, ipAddress: '127.0.0.1', profileType: 'FIGURE' },
  { laneId: 1, label: '100m', distanceM: 100, ipAddress: '10.0.1.2', profileType: 'FIGURE' },

  // Lane 2 gets two so the multi-stage flow can be exercised.
  { laneId: 2, label: '100m', distanceM: 100, ipAddress: '10.0.2.1', profileType: 'FIGURE' },
  { laneId: 2, label: '300m', distanceM: 300, ipAddress: '10.0.2.2', profileType: 'CIRCULAR' },

  { laneId: 3, label: '300m', distanceM: 300, ipAddress: '10.0.3.1', profileType: 'CIRCULAR' },
  { laneId: 4, label: '500m', distanceM: 500, ipAddress: '10.0.4.1', profileType: 'CIRCULAR' },
] as const;

const SHOOTERS = [
  { name: 'Iqbal', rank: 'Sergeant', badgeNumber: 'B-1001' },
  { name: 'James', rank: 'Constable', badgeNumber: 'B-1002' },
  { name: 'Kareem', rank: 'Corporal', badgeNumber: 'B-1003' },
  { name: 'Samir', rank: 'Constable', badgeNumber: 'B-1004' },
  { name: 'Muhammad', rank: 'Recruit', badgeNumber: 'B-1005' },
];

async function main() {
  // ── Accounts ───────────────────────────────────────────────────────────────
  // Bench credentials only. Hashing is what makes putting them in a seed
  // acceptable; a plaintext password column would not be.
  const [superAdmin, admin] = await Promise.all([
    prisma.user.upsert({
      where: { username: 'superadmin' },
      update: {},
      create: {
        username: 'superadmin',
        passwordHash: await bcrypt.hash('changeme123', 10),
        role: 'SUPER_ADMIN',
      },
    }),
    prisma.user.upsert({
      where: { username: 'admin' },
      // update, not {}: re-running should repair the password if it drifted.
      update: { passwordHash: await bcrypt.hash('admin123', 10), role: 'ADMIN' },
      create: {
        username: 'admin',
        passwordHash: await bcrypt.hash('admin123', 10),
        role: 'ADMIN',
      },
    }),
  ]);

  // ── Lanes ──────────────────────────────────────────────────────────────────
  for (const lane of LANES) {
    await prisma.lane.upsert({
      where: { id: lane.id },
      update: { name: lane.name, siteName: lane.siteName },
      create: lane,
    });
  }

  // ── Targets ────────────────────────────────────────────────────────────────
  for (const target of TARGETS) {
    const existing = await prisma.target.findUnique({
      where: { ipAddress: target.ipAddress },
    });

    if (existing) {
      // Already commissioned. Only refresh the descriptive fields — moving it
      // to another lane or slot could collide with a target already there, and
      // more importantly it would silently re-point shots that are attributed
      // by this address.
      await prisma.target.update({
        where: { id: existing.id },
        data: {
          label: target.label,
          distanceM: target.distanceM,
          profileType: target.profileType,
        },
      });
      continue;
    }

    // Next free slot on the lane, so a seed on a populated range appends
    // rather than fighting [laneId, positionIndex].
    const taken = await prisma.target.findMany({
      where: { laneId: target.laneId },
      select: { positionIndex: true },
    });
    const used = new Set(taken.map((t) => t.positionIndex));
    let positionIndex = 0;
    while (used.has(positionIndex)) positionIndex += 1;

    await prisma.target.create({ data: { ...target, positionIndex } });
  }

  // ── Shooter roster ─────────────────────────────────────────────────────────
  // Scoring records, NOT accounts — shooters never log in.
  for (const shooter of SHOOTERS) {
    await prisma.shooter.upsert({
      where: { name: shooter.name },
      update: { rank: shooter.rank, badgeNumber: shooter.badgeNumber },
      create: shooter,
    });
  }

  const targetCount = await prisma.target.count();

  console.log('\n─── LOMAH bench seed ───────────────────────────────────');
  console.log(`  Lanes    : ${LANES.length}`);
  console.log(`  Targets  : ${targetCount}`);
  console.log(`  Shooters : ${SHOOTERS.length}`);
  console.log('\n  Log in as:');
  console.log(`    ${admin.username} / admin123        (ADMIN — run sessions)`);
  console.log(`    ${superAdmin.username} / changeme123   (SUPER_ADMIN — hardware setup)`);
  console.log('\n  Lane 1 / "50m" is bound to 127.0.0.1 so the shot simulator');
  console.log('  is attributed to it:  npx tsx scripts/simulate-shots.ts');
  console.log('\n  No hardware attached? Starting a session requires the target');
  console.log('  to acknowledge PLAY. Set SENSOR_REQUIRE_ACK=false in .env to');
  console.log('  bypass that while testing.');
  console.log('────────────────────────────────────────────────────────\n');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
