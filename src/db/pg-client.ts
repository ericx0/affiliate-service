import { Pool, PoolClient } from "pg";
import { env } from "../config.js";
import { logger } from "../utils/logger.js";

/**
 * Direct Postgres connection pool — bypasses PostgREST schema cache.
 *
 * Use for queries that involve tables/views PostgREST hasn't cached yet
 * (e.g. after schema changes in Supabase Cloud where the API cache
 * reload is delayed or unreliable).
 *
 * Service role auth is handled at the DB level (the `postgres` user
 * has full superuser access, equivalent to Supabase service_role).
 */
let _pool: Pool | null = null;

export function pgPool(): Pool {
  if (_pool) return _pool;

  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL not set — required for direct PG queries (Phase A1)");
  }

  _pool = new Pool({
    connectionString: env.DATABASE_URL,
    ssl: env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  _pool.on("error", (err) => {
    logger.error({ err }, "Postgres pool error");
  });

  logger.info("Postgres pool initialized");
  return _pool;
}

export async function pgQuery<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await pgPool().query<T>(text, params);
  return result.rows;
}

export async function pgQueryOne<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await pgQuery<T>(text, params);
  return rows[0] ?? null;
}

export async function withPgClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pgPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
