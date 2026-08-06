const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  try {
    for (const t of ["lanes", "sessions", "shooters", "shots", "users"]) {
      const r = await p.$queryRawUnsafe(`SELECT COUNT(*) AS c FROM "${t}"`);
      console.log(t, "=>", r[0].c);
    }
  } catch (e) {
    console.error("ERR:", e.message);
  } finally {
    await p.$disconnect();
  }
})();
