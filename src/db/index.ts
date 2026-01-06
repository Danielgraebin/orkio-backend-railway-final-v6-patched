import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

export const db = drizzle(pool, { schema });

export async function checkConnection(): Promise<boolean> {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    return true;
  } catch (error) {
    console.error('Database connection failed:', error);
    return false;
  }
}

export async function checkPgVector(): Promise<boolean> {
  try {
    const client = await pool.connect();
    const result = await client.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
    client.release();
    return result.rows.length > 0;
  } catch (error) {
    return false;
  }
}

export { pool };
