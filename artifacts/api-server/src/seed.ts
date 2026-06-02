import bcrypt from "bcryptjs";
import { db, adminUsersTable, workersTable, productsTable, batchesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./lib/logger";

async function seed() {
  logger.info("Seeding database...");

  // Admin user
  const existing = await db.select().from(adminUsersTable).where(eq(adminUsersTable.username, "admin"));
  if (existing.length === 0) {
    const passwordHash = await bcrypt.hash("admin123", 10);
    await db.insert(adminUsersTable).values({
      username: "admin",
      passwordHash,
      role: "admin",
    });
    logger.info("Created admin user (admin / admin123)");
  }

  // Sample workers
  const workers = [
    { name: "Aziz Karimov", prefix: "AZ", phone: "+998901234567", role: "worker" },
    { name: "Gulnora Rashidova", prefix: "GL", phone: "+998901234568", role: "worker" },
    { name: "Sherzod Nazarov", prefix: "SH", phone: "+998901234569", role: "worker" },
  ];
  for (const w of workers) {
    await db.insert(workersTable).values(w).onConflictDoNothing();
  }
  logger.info("Workers seeded");

  // Sample products
  const products = [
    { name: "Arqon 6mm", rateType: "per_kg", rate: "1500" },
    { name: "Arqon 8mm", rateType: "per_kg", rate: "1800" },
    { name: "Arqon 10mm", rateType: "per_piece", rate: "2500" },
  ];
  for (const p of products) {
    await db.insert(productsTable).values(p).onConflictDoNothing();
  }
  logger.info("Products seeded");

  // Sample batches (last 14 days)
  const now = new Date();
  const workerNames = ["Aziz Karimov", "Gulnora Rashidova", "Sherzod Nazarov"];
  const productData = [
    { name: "Arqon 6mm", weightPerPiece: 0.5, rate: 1500, rateType: "per_kg" },
    { name: "Arqon 8mm", weightPerPiece: 0.8, rate: 1800, rateType: "per_kg" },
    { name: "Arqon 10mm", weightPerPiece: 1.0, rate: 2500, rateType: "per_piece" },
  ];

  const existingBatches = await db.select({ id: batchesTable.id }).from(batchesTable).limit(1);
  if (existingBatches.length === 0) {
    for (let d = 13; d >= 0; d--) {
      const date = new Date(now);
      date.setDate(date.getDate() - d);
      const batchCount = 2 + Math.floor(Math.random() * 4);
      for (let i = 0; i < batchCount; i++) {
        const worker = workerNames[Math.floor(Math.random() * workerNames.length)];
        const product = productData[Math.floor(Math.random() * productData.length)];
        const qty = 10 + Math.floor(Math.random() * 40);
        const weightKg = (qty * product.weightPerPiece).toFixed(3);
        const earnings = product.rateType === "per_kg"
          ? (Number(weightKg) * product.rate).toFixed(2)
          : (qty * product.rate).toFixed(2);
        const prefix = worker.substring(0, 2).toUpperCase();
        const dateStr = date.toISOString().slice(2, 10).replace(/-/g, "");
        const batchCode = `${prefix}-${dateStr}-${String(i + 1).padStart(2, "0")}`;

        await db.insert(batchesTable).values({
          batchCode,
          worker,
          product: product.name,
          quantity: qty,
          weightKg,
          earnings,
          createdAt: date,
        });
      }
    }
    logger.info("Sample batches seeded");
  }

  logger.info("Seed complete");
  process.exit(0);
}

seed().catch((err) => {
  logger.error(err, "Seed failed");
  process.exit(1);
});
