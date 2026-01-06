// User Roles
export type UserRole = 'master_admin' | 'tenant_admin' | 'user';

// Agent Modes
export type AgentMode = 'INTERNAL' | 'HYBRID' | 'FREE';

// Document Status
export type DocumentStatus = 'pending' | 'processing' | 'completed' | 'failed';

// User Interface
export interface User {
  id: string;
  email: string;
  password_hash: string;
  role: UserRole;
  tenant_id: string;
  is_approved: boolean;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

// Tenant Interface
export interface Tenant {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

// Agent Interface
export interface Agent {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  system_prompt: string;
  model: string;
  temperature: number;
  mode: AgentMode;
  allowed_topics: string[];
  forbidden_topics: string[];
  cost_limit_daily: number;
  cost_used_today: number;
  kill_switch: boolean;
  enable_rag: boolean;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

// Collection Interface
export interface Collection {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  is_global: boolean;
  created_at: Date;
  updated_at: Date;
}

// Document Interface
export interface Document {
  id: string;
  tenant_id: string;
  collection_id: string;
  name: string;
  file_path: string;
  mime_type: string;
  file_size: number;
  status: DocumentStatus;
  error_message?: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

// Embedding Interface
export interface Embedding {
  id: string;
  document_id: string;
  chunk_index: number;
  chunk_text: string;
  embedding: number[];
  created_at: Date;
}

// LLM Provider Interface
export interface LLMProvider {
  id: string;
  tenant_id: string;
  name: string;
  base_url: string;
  api_key_encrypted: string;
  models: string[];
  is_default: boolean;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

// Chat Message Interface
export interface ChatMessage {
  id: string;
  tenant_id: string;
  user_id: string;
  agent_id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tokens_used: number;
  latency_ms: number;
  evidence?: RAGEvidence[];
  created_at: Date;
}

// RAG Evidence Interface
export interface RAGEvidence {
  document_id: string;
  document_name: string;
  document_version: number;
  chunk_text: string;
  chunk_index: number;
  similarity_score: number;
}

// Decision Log Interface
export interface DecisionLog {
  id: string;
  tenant_id: string;
  user_id: string;
  agent_id: string;
  action: string;
  decision: 'allowed' | 'blocked' | 'modified';
  reason: string;
  input_preview: string;
  output_preview?: string;
  metadata: Record<string, any>;
  created_at: Date;
}

// Admin Action Log Interface
export interface AdminActionLog {
  id: string;
  tenant_id: string;
  admin_id: string;
  action: string;
  target_type: string;
  target_id: string;
  changes: Record<string, any>;
  ip_address: string;
  user_agent: string;
  created_at: Date;
}

// JWT Payload
export interface JWTPayload {
  userId: string;
  email: string;
  role: UserRole;
  tenantId: string;
}

// API Response
export interface APIResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

// Chat Request
export interface ChatRequest {
  message: string;
  agentId: string;
  conversationId?: string;
}

// Chat Response
export interface ChatResponse {
  response: string;
  conversationId: string;
  tokensUsed: number;
  latencyMs: number;
  evidence?: RAGEvidence[];
  blocked?: boolean;
  blockReason?: string;
}

// Express Request Extension
declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload;
      tenantId?: string;
    }
  }
}
