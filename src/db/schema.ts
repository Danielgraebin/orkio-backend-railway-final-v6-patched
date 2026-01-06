import { pgTable, text, timestamp, boolean, integer, real, jsonb, uuid, varchar, index } from 'drizzle-orm/pg-core';

// Tenants Table
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  is_active: boolean('is_active').default(true).notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
});

// Users Table
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: uuid('tenant_id').references(() => tenants.id).notNull(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  password_hash: text('password_hash').notNull(),
  role: varchar('role', { length: 50 }).notNull().default('user'),
  is_approved: boolean('is_approved').default(false).notNull(),
  is_active: boolean('is_active').default(true).notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  tenantIdx: index('users_tenant_idx').on(table.tenant_id),
  emailIdx: index('users_email_idx').on(table.email),
}));

// Agents Table
export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: uuid('tenant_id').references(() => tenants.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  system_prompt: text('system_prompt'),
  model: varchar('model', { length: 100 }).default('gpt-4o').notNull(),
  temperature: real('temperature').default(0.7).notNull(),
  mode: varchar('mode', { length: 20 }).default('HYBRID').notNull(),
  allowed_topics: jsonb('allowed_topics').default([]).notNull(),
  forbidden_topics: jsonb('forbidden_topics').default([]).notNull(),
  cost_limit_daily: real('cost_limit_daily').default(10.0).notNull(),
  cost_used_today: real('cost_used_today').default(0).notNull(),
  kill_switch: boolean('kill_switch').default(false).notNull(),
  enable_rag: boolean('enable_rag').default(true).notNull(),
  is_active: boolean('is_active').default(true).notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  tenantIdx: index('agents_tenant_idx').on(table.tenant_id),
}));

// Collections Table
export const collections = pgTable('collections', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: uuid('tenant_id').references(() => tenants.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  is_global: boolean('is_global').default(false).notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  tenantIdx: index('collections_tenant_idx').on(table.tenant_id),
}));

// Documents Table
export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: uuid('tenant_id').references(() => tenants.id).notNull(),
  collection_id: uuid('collection_id').references(() => collections.id).notNull(),
  name: varchar('name', { length: 500 }).notNull(),
  file_path: text('file_path').notNull(),
  mime_type: varchar('mime_type', { length: 100 }).notNull(),
  file_size: integer('file_size').notNull(),
  status: varchar('status', { length: 20 }).default('pending').notNull(),
  error_message: text('error_message'),
  version: integer('version').default(1).notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  tenantIdx: index('documents_tenant_idx').on(table.tenant_id),
  collectionIdx: index('documents_collection_idx').on(table.collection_id),
  statusIdx: index('documents_status_idx').on(table.status),
}));

// Embeddings Table
export const embeddings = pgTable('embeddings', {
  id: uuid('id').primaryKey().defaultRandom(),
  document_id: uuid('document_id').references(() => documents.id, { onDelete: 'cascade' }).notNull(),
  chunk_index: integer('chunk_index').notNull(),
  chunk_text: text('chunk_text').notNull(),
  embedding: jsonb('embedding').notNull(), // Store as JSON array, convert to pgvector if available
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  documentIdx: index('embeddings_document_idx').on(table.document_id),
}));

// Agent Collections (Many-to-Many)
export const agentCollections = pgTable('agent_collections', {
  id: uuid('id').primaryKey().defaultRandom(),
  agent_id: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }).notNull(),
  collection_id: uuid('collection_id').references(() => collections.id, { onDelete: 'cascade' }).notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  agentIdx: index('agent_collections_agent_idx').on(table.agent_id),
  collectionIdx: index('agent_collections_collection_idx').on(table.collection_id),
}));

// LLM Providers Table
export const llmProviders = pgTable('llm_providers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: uuid('tenant_id').references(() => tenants.id).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  base_url: text('base_url'),
  api_key_encrypted: text('api_key_encrypted').notNull(),
  models: jsonb('models').default([]).notNull(),
  is_default: boolean('is_default').default(false).notNull(),
  is_active: boolean('is_active').default(true).notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  tenantIdx: index('llm_providers_tenant_idx').on(table.tenant_id),
}));

// Chat Messages Table
export const chatMessages = pgTable('chat_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: uuid('tenant_id').references(() => tenants.id).notNull(),
  user_id: uuid('user_id').references(() => users.id).notNull(),
  agent_id: uuid('agent_id').references(() => agents.id).notNull(),
  conversation_id: uuid('conversation_id').notNull(),
  role: varchar('role', { length: 20 }).notNull(),
  content: text('content').notNull(),
  tokens_used: integer('tokens_used').default(0).notNull(),
  latency_ms: integer('latency_ms').default(0).notNull(),
  evidence: jsonb('evidence'),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  tenantIdx: index('chat_messages_tenant_idx').on(table.tenant_id),
  userIdx: index('chat_messages_user_idx').on(table.user_id),
  conversationIdx: index('chat_messages_conversation_idx').on(table.conversation_id),
}));

// Decision Logs Table (Append-Only)
export const decisionLogs = pgTable('decision_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: uuid('tenant_id').references(() => tenants.id).notNull(),
  user_id: uuid('user_id').references(() => users.id).notNull(),
  agent_id: uuid('agent_id').references(() => agents.id).notNull(),
  action: varchar('action', { length: 100 }).notNull(),
  decision: varchar('decision', { length: 20 }).notNull(),
  reason: text('reason').notNull(),
  input_preview: text('input_preview').notNull(),
  output_preview: text('output_preview'),
  metadata: jsonb('metadata').default({}).notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  tenantIdx: index('decision_logs_tenant_idx').on(table.tenant_id),
  userIdx: index('decision_logs_user_idx').on(table.user_id),
  agentIdx: index('decision_logs_agent_idx').on(table.agent_id),
  createdIdx: index('decision_logs_created_idx').on(table.created_at),
}));

// Admin Action Logs Table (Append-Only)
export const adminActionLogs = pgTable('admin_action_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: uuid('tenant_id').references(() => tenants.id).notNull(),
  admin_id: uuid('admin_id').references(() => users.id).notNull(),
  action: varchar('action', { length: 100 }).notNull(),
  target_type: varchar('target_type', { length: 50 }).notNull(),
  target_id: uuid('target_id'),
  changes: jsonb('changes').default({}).notNull(),
  ip_address: varchar('ip_address', { length: 45 }),
  user_agent: text('user_agent'),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  tenantIdx: index('admin_action_logs_tenant_idx').on(table.tenant_id),
  adminIdx: index('admin_action_logs_admin_idx').on(table.admin_id),
  createdIdx: index('admin_action_logs_created_idx').on(table.created_at),
}));

// Conversations Table
export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: uuid('tenant_id').references(() => tenants.id).notNull(),
  user_id: uuid('user_id').references(() => users.id).notNull(),
  agent_id: uuid('agent_id').references(() => agents.id).notNull(),
  title: varchar('title', { length: 255 }),
  is_active: boolean('is_active').default(true).notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  tenantIdx: index('conversations_tenant_idx').on(table.tenant_id),
  userIdx: index('conversations_user_idx').on(table.user_id),
}));
