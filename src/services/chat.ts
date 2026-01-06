import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/index.js';
import { retrieveContext } from './rag.js';
import { logDecision } from './logging.js';
import { decrypt, truncateText } from '../utils/index.js';
import { Agent, ChatResponse, RAGEvidence, AgentMode } from '../types/index.js';

// Check if message violates agent contract
function checkContract(
  message: string,
  agent: Agent
): { allowed: boolean; reason?: string } {
  const messageLower = message.toLowerCase();
  
  // Check forbidden topics
  const forbiddenTopics = agent.forbidden_topics as string[];
  for (const topic of forbiddenTopics) {
    if (messageLower.includes(topic.toLowerCase())) {
      return {
        allowed: false,
        reason: `Message contains forbidden topic: "${topic}"`,
      };
    }
  }
  
  // Check allowed topics (if specified, message must match at least one)
  const allowedTopics = agent.allowed_topics as string[];
  if (allowedTopics.length > 0) {
    const matchesAllowed = allowedTopics.some(topic => 
      messageLower.includes(topic.toLowerCase())
    );
    
    if (!matchesAllowed) {
      return {
        allowed: false,
        reason: 'Message does not match any allowed topics',
      };
    }
  }
  
  return { allowed: true };
}

// Check if agent can respond based on mode and evidence
function checkModeRequirements(
  mode: AgentMode,
  evidence: RAGEvidence[]
): { allowed: boolean; reason?: string } {
  if (mode === 'INTERNAL') {
    // INTERNAL mode requires evidence from documents
    if (evidence.length === 0) {
      return {
        allowed: false,
        reason: 'INTERNAL mode requires document evidence. No relevant documents found.',
      };
    }
    
    // Check if evidence has sufficient similarity
    const maxSimilarity = Math.max(...evidence.map(e => e.similarity_score));
    if (maxSimilarity < 0.5) {
      return {
        allowed: false,
        reason: 'INTERNAL mode requires high-confidence evidence. Available evidence has low similarity scores.',
      };
    }
  }
  
  // HYBRID and FREE modes don't require evidence
  return { allowed: true };
}

// Get LLM client for tenant
async function getLLMClient(tenantId: string): Promise<OpenAI> {
  // Try to get tenant's default provider
  const providerResult = await pool.query(
    'SELECT * FROM llm_providers WHERE tenant_id = $1 AND is_default = true AND is_active = true LIMIT 1',
    [tenantId]
  );
  
  if (providerResult.rows.length > 0) {
    const provider = providerResult.rows[0];
    const apiKey = decrypt(provider.api_key_encrypted);
    
    return new OpenAI({
      apiKey,
      baseURL: provider.base_url || undefined,
    });
  }
  
  // Fallback to environment variable
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

// Main chat function
export async function chat(
  message: string,
  agentId: string,
  userId: string,
  tenantId: string,
  conversationId?: string
): Promise<ChatResponse> {
  const startTime = Date.now();
  
  // Get agent
  const agentResult = await pool.query(
    'SELECT * FROM agents WHERE id = $1 AND tenant_id = $2 AND is_active = true',
    [agentId, tenantId]
  );
  
  if (agentResult.rows.length === 0) {
    throw new Error('Agent not found or inactive');
  }
  
  const agent = agentResult.rows[0] as Agent;
  
  // Check kill switch
  if (agent.kill_switch) {
    await logDecision(tenantId, userId, agentId, 'chat', 'blocked', 'Agent kill switch is enabled', message);
    
    return {
      response: 'This agent is currently disabled. Please contact an administrator.',
      conversationId: conversationId || uuidv4(),
      tokensUsed: 0,
      latencyMs: Date.now() - startTime,
      blocked: true,
      blockReason: 'Agent kill switch is enabled',
    };
  }
  
  // Check daily cost limit
  if (agent.cost_used_today >= agent.cost_limit_daily) {
    await logDecision(tenantId, userId, agentId, 'chat', 'blocked', 'Daily cost limit exceeded', message);
    
    return {
      response: 'This agent has reached its daily usage limit. Please try again tomorrow.',
      conversationId: conversationId || uuidv4(),
      tokensUsed: 0,
      latencyMs: Date.now() - startTime,
      blocked: true,
      blockReason: 'Daily cost limit exceeded',
    };
  }
  
  // Check contract (allowed/forbidden topics)
  const contractCheck = checkContract(message, agent);
  if (!contractCheck.allowed) {
    await logDecision(tenantId, userId, agentId, 'chat', 'blocked', contractCheck.reason!, message);
    
    return {
      response: 'I cannot respond to this request as it falls outside my allowed scope.',
      conversationId: conversationId || uuidv4(),
      tokensUsed: 0,
      latencyMs: Date.now() - startTime,
      blocked: true,
      blockReason: contractCheck.reason,
    };
  }
  
  // Retrieve RAG context if enabled
  let context = '';
  let evidence: RAGEvidence[] = [];
  
  if (agent.enable_rag) {
    const ragResult = await retrieveContext(message, agentId, tenantId);
    context = ragResult.context;
    evidence = ragResult.evidence;
  }
  
  // Check mode requirements
  const modeCheck = checkModeRequirements(agent.mode as AgentMode, evidence);
  if (!modeCheck.allowed) {
    await logDecision(tenantId, userId, agentId, 'chat', 'blocked', modeCheck.reason!, message);
    
    return {
      response: 'I cannot answer this question as I don\'t have sufficient information in my knowledge base.',
      conversationId: conversationId || uuidv4(),
      tokensUsed: 0,
      latencyMs: Date.now() - startTime,
      blocked: true,
      blockReason: modeCheck.reason,
      evidence: [],
    };
  }
  
  // Build system prompt
  let systemPrompt = agent.system_prompt || 'You are a helpful AI assistant.';
  
  if (context) {
    systemPrompt += `\n\n## Knowledge Base Context\nUse the following information to answer the user's question. Always cite your sources by mentioning the document name.\n\n${context}`;
  }
  
  if (agent.mode === 'INTERNAL') {
    systemPrompt += '\n\nIMPORTANT: You must ONLY answer based on the provided context. If the context does not contain relevant information, say so clearly.';
  } else if (agent.mode === 'HYBRID') {
    systemPrompt += '\n\nPrefer using information from the provided context when available, but you may supplement with your general knowledge when appropriate.';
  }
  
  // Get conversation history
  const convId = conversationId || uuidv4();
  let messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: systemPrompt },
  ];
  
  if (conversationId) {
    const historyResult = await pool.query(
      `SELECT role, content FROM chat_messages 
       WHERE conversation_id = $1 
       ORDER BY created_at ASC 
       LIMIT 20`,
      [conversationId]
    );
    
    for (const msg of historyResult.rows) {
      messages.push({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      });
    }
  }
  
  messages.push({ role: 'user', content: message });
  
  // Call LLM
  const openai = await getLLMClient(tenantId);
  
  const completion = await openai.chat.completions.create({
    model: agent.model || 'gpt-4o',
    messages,
    temperature: agent.temperature || 0.7,
    max_tokens: 2000,
  });
  
  const response = completion.choices[0]?.message?.content || 'No response generated.';
  const tokensUsed = completion.usage?.total_tokens || 0;
  
  // Estimate cost (rough estimate: $0.01 per 1000 tokens for GPT-4)
  const estimatedCost = (tokensUsed / 1000) * 0.01;
  
  // Update agent cost
  await pool.query(
    'UPDATE agents SET cost_used_today = cost_used_today + $1, updated_at = NOW() WHERE id = $2',
    [estimatedCost, agentId]
  );
  
  // Save messages to database
  const latencyMs = Date.now() - startTime;
  
  // Save user message
  await pool.query(
    `INSERT INTO chat_messages (tenant_id, user_id, agent_id, conversation_id, role, content, tokens_used, latency_ms)
     VALUES ($1, $2, $3, $4, 'user', $5, 0, 0)`,
    [tenantId, userId, agentId, convId, message]
  );
  
  // Save assistant message with evidence
  await pool.query(
    `INSERT INTO chat_messages (tenant_id, user_id, agent_id, conversation_id, role, content, tokens_used, latency_ms, evidence)
     VALUES ($1, $2, $3, $4, 'assistant', $5, $6, $7, $8)`,
    [tenantId, userId, agentId, convId, response, tokensUsed, latencyMs, JSON.stringify(evidence)]
  );
  
  // Log decision
  await logDecision(
    tenantId, userId, agentId, 'chat', 'allowed', 
    `Response generated with ${evidence.length} evidence sources`,
    truncateText(message, 200),
    truncateText(response, 200),
    { tokensUsed, evidenceCount: evidence.length, mode: agent.mode }
  );
  
  return {
    response,
    conversationId: convId,
    tokensUsed,
    latencyMs,
    evidence,
  };
}

// Chat with uploaded document (one-time context)
export async function chatWithDocument(
  message: string,
  documentContent: string,
  agentId: string,
  userId: string,
  tenantId: string
): Promise<ChatResponse> {
  const startTime = Date.now();
  
  // Get agent
  const agentResult = await pool.query(
    'SELECT * FROM agents WHERE id = $1 AND tenant_id = $2 AND is_active = true',
    [agentId, tenantId]
  );
  
  if (agentResult.rows.length === 0) {
    throw new Error('Agent not found or inactive');
  }
  
  const agent = agentResult.rows[0] as Agent;
  
  // Check kill switch
  if (agent.kill_switch) {
    return {
      response: 'This agent is currently disabled.',
      conversationId: uuidv4(),
      tokensUsed: 0,
      latencyMs: Date.now() - startTime,
      blocked: true,
      blockReason: 'Agent kill switch is enabled',
    };
  }
  
  // Build prompt with document content
  const systemPrompt = `${agent.system_prompt || 'You are a helpful AI assistant.'}\n\n## Uploaded Document Content\n${documentContent.slice(0, 10000)}`;
  
  const openai = await getLLMClient(tenantId);
  
  const completion = await openai.chat.completions.create({
    model: agent.model || 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message },
    ],
    temperature: agent.temperature || 0.7,
    max_tokens: 2000,
  });
  
  const response = completion.choices[0]?.message?.content || 'No response generated.';
  const tokensUsed = completion.usage?.total_tokens || 0;
  
  return {
    response,
    conversationId: uuidv4(),
    tokensUsed,
    latencyMs: Date.now() - startTime,
    evidence: [{
      document_id: 'uploaded',
      document_name: 'Uploaded Document',
      document_version: 1,
      chunk_text: documentContent.slice(0, 500) + '...',
      chunk_index: 0,
      similarity_score: 1.0,
    }],
  };
}
