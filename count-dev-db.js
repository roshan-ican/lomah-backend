const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  try {
    const tables = await p.$queryRawUnsafe(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    console.log("TABLES:", tables.map((t) => t.name).join(", "));
    for (const t of tables) {
      const r = await p.$queryRawUnsafe(`SELECT COUNT(*) AS c FROM "${t.name}"`);
      console.log(t.name, "=>", r[0].c);
    }
  } catch (e) {
    console.error("ERR:", e.message);
  } finally {
    await p.$disconnect();
  }
})();
