const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  try {
    const tables = await p.$queryRawUnsafe(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    console.log("TABLES:", JSON.stringify(tables));
    const migs = await p.$queryRawUnsafe(
      "SELECT migration_name, started_at, finished_at FROM _prisma_migrations ORDER BY started_at",
    );
    console.log("MIGRATIONS:", JSON.stringify(migs, null, 2));
  } catch (e) {
    console.error("ERR:", e.message);
  } finally {
    await p.$disconnect();
  }
})();
