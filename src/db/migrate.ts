import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function migrate() {
  const client = await pool.connect();
  
  try {
    console.log('Starting database migration...');
    
    // Try to enable required extensions (pgcrypto for gen_random_uuid, pgvector optional)
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      console.log('✓ pgcrypto extension enabled');
    } catch (e) {
      console.log('⚠ pgcrypto not available — gen_random_uuid() requires pgcrypto. Enable pgcrypto on the database.');
      throw e;
    }

    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      console.log('✓ pgvector extension enabled');
    } catch (e) {
      console.log('⚠ pgvector not available, using JSON fallback for embeddings');
    }
// Create tables
    await client.query(`
      -- Tenants Table
      CREATE TABLE IF NOT EXISTS tenants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(100) NOT NULL UNIQUE,
        is_active BOOLEAN DEFAULT true NOT NULL,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW() NOT NULL
      );

      -- Users Table
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role VARCHAR(50) NOT NULL DEFAULT 'user',
        is_approved BOOLEAN DEFAULT false NOT NULL,
        is_active BOOLEAN DEFAULT true NOT NULL,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW() NOT NULL
      );
      CREATE INDEX IF NOT EXISTS users_tenant_idx ON users(tenant_id);
      CREATE INDEX IF NOT EXISTS users_email_idx ON users(email);

      -- Agents Table
      CREATE TABLE IF NOT EXISTS agents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        name VARCHAR(255) NOT NULL,
        description TEXT,
        system_prompt TEXT,
        model VARCHAR(100) DEFAULT 'gpt-4o' NOT NULL,
        temperature REAL DEFAULT 0.7 NOT NULL,
        mode VARCHAR(20) DEFAULT 'HYBRID' NOT NULL,
        allowed_topics JSONB DEFAULT '[]' NOT NULL,
        forbidden_topics JSONB DEFAULT '[]' NOT NULL,
        cost_limit_daily REAL DEFAULT 10.0 NOT NULL,
        cost_used_today REAL DEFAULT 0 NOT NULL,
        kill_switch BOOLEAN DEFAULT false NOT NULL,
        enable_rag BOOLEAN DEFAULT true NOT NULL,
        is_active BOOLEAN DEFAULT true NOT NULL,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW() NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agents_tenant_idx ON agents(tenant_id);

      -- Collections Table
      CREATE TABLE IF NOT EXISTS collections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        name VARCHAR(255) NOT NULL,
        description TEXT,
        is_global BOOLEAN DEFAULT false NOT NULL,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW() NOT NULL
      );
      CREATE INDEX IF NOT EXISTS collections_tenant_idx ON collections(tenant_id);

      -- Documents Table
      CREATE TABLE IF NOT EXISTS documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        collection_id UUID NOT NULL REFERENCES collections(id),
        name VARCHAR(500) NOT NULL,
        file_path TEXT NOT NULL,
        mime_type VARCHAR(100) NOT NULL,
        file_size INTEGER NOT NULL,
        status VARCHAR(20) DEFAULT 'pending' NOT NULL,
        error_message TEXT,
        version INTEGER DEFAULT 1 NOT NULL,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW() NOT NULL
      );
      CREATE INDEX IF NOT EXISTS documents_tenant_idx ON documents(tenant_id);
      CREATE INDEX IF NOT EXISTS documents_collection_idx ON documents(collection_id);
      CREATE INDEX IF NOT EXISTS documents_status_idx ON documents(status);

      -- Embeddings Table
      CREATE TABLE IF NOT EXISTS embeddings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        chunk_text TEXT NOT NULL,
        embedding JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );
      CREATE INDEX IF NOT EXISTS embeddings_document_idx ON embeddings(document_id);

      -- Agent Collections (Many-to-Many)
      CREATE TABLE IF NOT EXISTS agent_collections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        UNIQUE(agent_id, collection_id)
      );
      CREATE INDEX IF NOT EXISTS agent_collections_agent_idx ON agent_collections(agent_id);
      CREATE INDEX IF NOT EXISTS agent_collections_collection_idx ON agent_collections(collection_id);

      -- LLM Providers Table
      CREATE TABLE IF NOT EXISTS llm_providers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        name VARCHAR(100) NOT NULL,
        base_url TEXT,
        api_key_encrypted TEXT NOT NULL,
        models JSONB DEFAULT '[]' NOT NULL,
        is_default BOOLEAN DEFAULT false NOT NULL,
        is_active BOOLEAN DEFAULT true NOT NULL,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW() NOT NULL
      );
      CREATE INDEX IF NOT EXISTS llm_providers_tenant_idx ON llm_providers(tenant_id);

      -- Conversations Table
      CREATE TABLE IF NOT EXISTS conversations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        user_id UUID NOT NULL REFERENCES users(id),
        agent_id UUID NOT NULL REFERENCES agents(id),
        title VARCHAR(255),
        is_active BOOLEAN DEFAULT true NOT NULL,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW() NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversations_tenant_idx ON conversations(tenant_id);
      CREATE INDEX IF NOT EXISTS conversations_user_idx ON conversations(user_id);

      -- Chat Messages Table
      CREATE TABLE IF NOT EXISTS chat_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        user_id UUID NOT NULL REFERENCES users(id),
        agent_id UUID NOT NULL REFERENCES agents(id),
        conversation_id UUID NOT NULL,
        role VARCHAR(20) NOT NULL,
        content TEXT NOT NULL,
        tokens_used INTEGER DEFAULT 0 NOT NULL,
        latency_ms INTEGER DEFAULT 0 NOT NULL,
        evidence JSONB,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chat_messages_tenant_idx ON chat_messages(tenant_id);
      CREATE INDEX IF NOT EXISTS chat_messages_user_idx ON chat_messages(user_id);
      CREATE INDEX IF NOT EXISTS chat_messages_conversation_idx ON chat_messages(conversation_id);

      -- Decision Logs Table (Append-Only)
      CREATE TABLE IF NOT EXISTS decision_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        user_id UUID NOT NULL REFERENCES users(id),
        agent_id UUID NOT NULL REFERENCES agents(id),
        action VARCHAR(100) NOT NULL,
        decision VARCHAR(20) NOT NULL,
        reason TEXT NOT NULL,
        input_preview TEXT NOT NULL,
        output_preview TEXT,
        metadata JSONB DEFAULT '{}' NOT NULL,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );
      CREATE INDEX IF NOT EXISTS decision_logs_tenant_idx ON decision_logs(tenant_id);
      CREATE INDEX IF NOT EXISTS decision_logs_user_idx ON decision_logs(user_id);
      CREATE INDEX IF NOT EXISTS decision_logs_agent_idx ON decision_logs(agent_id);
      CREATE INDEX IF NOT EXISTS decision_logs_created_idx ON decision_logs(created_at);

      -- Admin Action Logs Table (Append-Only)
      CREATE TABLE IF NOT EXISTS admin_action_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        admin_id UUID NOT NULL REFERENCES users(id),
        action VARCHAR(100) NOT NULL,
        target_type VARCHAR(50) NOT NULL,
        target_id UUID,
        changes JSONB DEFAULT '{}' NOT NULL,
        ip_address VARCHAR(45),
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );
      CREATE INDEX IF NOT EXISTS admin_action_logs_tenant_idx ON admin_action_logs(tenant_id);
      CREATE INDEX IF NOT EXISTS admin_action_logs_admin_idx ON admin_action_logs(admin_id);
      CREATE INDEX IF NOT EXISTS admin_action_logs_created_idx ON admin_action_logs(created_at);
    `);

    console.log('✓ All tables created successfully');
    
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(console.error);
