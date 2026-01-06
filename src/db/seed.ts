import 'dotenv/config';
import { Pool } from 'pg';
import bcrypt from 'bcrypt';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

function slugify(input: string) {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

async function seed() {
  const client = await pool.connect();

  try {
    console.log('Starting database seed...');

    // 1) Ensure default tenant exists
    const tenantName = process.env.DEFAULT_TENANT_NAME || 'Default Tenant';
    const tenantSlug = process.env.DEFAULT_TENANT_SLUG || slugify(tenantName) || 'default';

    const tenantUpsert = await client.query(
      `
      INSERT INTO tenants (name, slug, is_active)
      VALUES ($1, $2, true)
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()
      RETURNING id
      `,
      [tenantName, tenantSlug]
    );
    const tenantId: string = tenantUpsert.rows[0].id;

    // 2) Ensure master admin exists
    const adminEmail = (process.env.ADMIN_EMAIL || 'admin@orkio.ai').toLowerCase();
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    const adminName = process.env.ADMIN_NAME || 'Master Admin';

    const existing = await client.query(
      `SELECT id FROM users WHERE email = $1 LIMIT 1`,
      [adminEmail]
    );

    if (existing.rows.length === 0) {
      const passwordHash = await bcrypt.hash(adminPassword, 12);

      await client.query(
        `
        INSERT INTO users (tenant_id, email, password_hash, role, is_approved, is_active, name)
        VALUES ($1, $2, $3, 'master_admin', true, true, $4)
        `,
        [tenantId, adminEmail, passwordHash, adminName]
      );

      console.log(`✓ Master admin created: ${adminEmail}`);
      console.log('  (Password set from ADMIN_PASSWORD env var; change it after first login)');
    } else {
      console.log(`✓ Master admin already exists: ${adminEmail}`);
    }

    // 3) Optional default agent if none exists
    try {
      const agentsCount = await client.query(
        `SELECT COUNT(*)::int AS c FROM agents WHERE tenant_id = $1`,
        [tenantId]
      );

      if ((agentsCount.rows[0]?.c ?? 0) === 0) {
        await client.query(
          `
          INSERT INTO agents (
            tenant_id, name, description, system_prompt,
            model, temperature, mode, is_active, kill_switch, max_cost_per_session
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,true,false,$8)
          `,
          [
            tenantId,
            'Agente Orkio',
            'Agente central de orquestração estratégica com governança, evidência e controle.',
            'You are Orkio, a governed decision orchestrator. Follow agent contract. In INTERNAL mode, require evidence; otherwise refuse.',
            process.env.OPENAI_MODEL_DEFAULT || 'gpt-4o-mini',
            0.2,
            'HYBRID',
            2.0,
          ]
        );
        console.log('✓ Default agent created (Agente Orkio)');
      } else {
        console.log('✓ Agents already exist, skipping default agent seed.');
      }
    } catch {
      console.log('ℹ Skipping default agent seed (agents table may not exist yet).');
    }

    console.log('✓ Seed completed.');
  } catch (error) {
    console.error('Seed failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});
