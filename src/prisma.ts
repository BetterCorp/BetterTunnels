import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/index.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import type { Observable } from "@bsb/base";

let prismaClient: PrismaClient | undefined;
let configuredConnectionString: string | undefined;
let migrationConnectionString: string | undefined;
let migrationPromise: Promise<void> | undefined;

const MIGRATION_LOCK_ID = 836466020763084328n;

export async function initializePrisma(connectionString: string, obs?: Observable): Promise<PrismaClient> {
  await runPrismaMigrations(connectionString, obs);
  return configurePrisma(connectionString);
}

export function configurePrisma(connectionString: string): PrismaClient {
  if (!connectionString) {
    throw new Error("Prisma connection string is required");
  }
  if (prismaClient) {
    if (configuredConnectionString !== connectionString) {
      throw new Error("Prisma has already been configured with a different connection string");
    }
    return prismaClient;
  }

  configuredConnectionString = connectionString;
  prismaClient = new PrismaClient({
    adapter: new PrismaPg({ connectionString })
  });
  return prismaClient;
}

async function runPrismaMigrations(connectionString: string, obs?: Observable): Promise<void> {
  if (!connectionString) {
    throw new Error("Prisma connection string is required");
  }
  if (migrationPromise) {
    if (migrationConnectionString !== connectionString) {
      throw new Error("Prisma migrations have already been configured with a different connection string");
    }
    return migrationPromise;
  }

  migrationConnectionString = connectionString;
  migrationPromise = applyPrismaMigrations(connectionString, obs);
  return migrationPromise;
}

async function applyPrismaMigrations(connectionString: string, obs?: Observable): Promise<void> {
  const migrationsDir = findMigrationsDir();
  const migrationNames = (await readdir(migrationsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID.toString()]);
    await ensurePrismaMigrationsTable(client);
    const applied = await loadAppliedMigrations(client);

    for (const migrationName of migrationNames) {
      const sql = await readFile(join(migrationsDir, migrationName, "migration.sql"), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = applied.get(migrationName);
      if (existing) {
        if (!existing.finishedAt && !existing.rolledBackAt) {
          throw new Error(`Prisma migration ${migrationName} was started but not completed`);
        }
        if (existing.checksum !== checksum) {
          throw new Error(`Prisma migration ${migrationName} checksum does not match the applied migration`);
        }
        continue;
      }

      obs?.log?.info?.("Applying Prisma migration {migration}", { migration: migrationName });
      await client.query("BEGIN");
      try {
        const id = randomUUID();
        await client.query(
          `INSERT INTO "_prisma_migrations"
             (id, checksum, migration_name, started_at, applied_steps_count)
           VALUES ($1, $2, $3, now(), 0)`,
          [id, checksum, migrationName]
        );
        if (sql.trim()) {
          await client.query(sql);
        }
        await client.query(
          `UPDATE "_prisma_migrations"
           SET finished_at = now(), applied_steps_count = 1
           WHERE migration_name = $1`,
          [migrationName]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID.toString()]).catch(() => undefined);
    await client.end();
  }
}

function findMigrationsDir(): string {
  const start = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(start, "..", "prisma", "migrations"),
    join(start, "..", "..", "prisma", "migrations")
  ];
  const migrationsDir = candidates.find((candidate) => existsSync(candidate));
  if (!migrationsDir) {
    throw new Error(`Prisma migrations directory was not found from ${start}`);
  }
  return migrationsDir;
}

async function ensurePrismaMigrationsTable(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      id VARCHAR(36) PRIMARY KEY NOT NULL,
      checksum VARCHAR(64) NOT NULL,
      finished_at TIMESTAMPTZ,
      migration_name VARCHAR(255) NOT NULL,
      logs TEXT,
      rolled_back_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_steps_count INTEGER NOT NULL DEFAULT 0
    )
  `);
}

async function loadAppliedMigrations(client: Client): Promise<Map<string, { checksum: string; finishedAt: Date | null; rolledBackAt: Date | null }>> {
  const result = await client.query<{
    migration_name: string;
    checksum: string;
    finished_at: Date | null;
    rolled_back_at: Date | null;
  }>(`SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations"`);
  return new Map(result.rows.map((row) => [
    row.migration_name,
    {
      checksum: row.checksum,
      finishedAt: row.finished_at,
      rolledBackAt: row.rolled_back_at
    }
  ]));
}

export function getPrisma(): PrismaClient {
  if (!prismaClient) {
    throw new Error("Prisma is not configured. Configure it from BSB service config before use.");
  }
  return prismaClient;
}

export const prisma = new Proxy({} as PrismaClient, {
  get(_target, property) {
    const client = getPrisma() as unknown as Record<PropertyKey, unknown>;
    const value = client[property];
    return typeof value === "function" ? value.bind(client) : value;
  }
});
