import { Request } from 'express';
import { pool } from '../db/index.js';

// Log a decision (append-only)
export async function logDecision(
  tenantId: string,
  userId: string,
  agentId: string,
  action: string,
  decision: 'allowed' | 'blocked' | 'modified',
  reason: string,
  inputPreview: string,
  outputPreview?: string,
  metadata: Record<string, any> = {}
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO decision_logs (tenant_id, user_id, agent_id, action, decision, reason, input_preview, output_preview, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [tenantId, userId, agentId, action, decision, reason, inputPreview, outputPreview || null, JSON.stringify(metadata)]
    );
  } catch (error) {
    console.error('Error logging decision:', error);
    // Don't throw - logging should not break the main flow
  }
}

// Log an admin action (append-only)
export async function logAdminAction(
  req: Request,
  action: string,
  targetType: string,
  targetId: string | null,
  changes: Record<string, any> = {}
): Promise<void> {
  try {
    const ipAddress = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    
    await pool.query(
      `INSERT INTO admin_action_logs (tenant_id, admin_id, action, target_type, target_id, changes, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        req.tenantId,
        req.user!.userId,
        action,
        targetType,
        targetId,
        JSON.stringify(changes),
        typeof ipAddress === 'string' ? ipAddress : ipAddress[0],
        userAgent
      ]
    );
  } catch (error) {
    console.error('Error logging admin action:', error);
    // Don't throw - logging should not break the main flow
  }
}

// Get decision logs
export async function getDecisionLogs(
  tenantId: string,
  filters: {
    userId?: string;
    agentId?: string;
    decision?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  } = {}
): Promise<any[]> {
  let query = `
    SELECT dl.*, u.email as user_email, a.name as agent_name
    FROM decision_logs dl
    JOIN users u ON dl.user_id = u.id
    JOIN agents a ON dl.agent_id = a.id
    WHERE dl.tenant_id = $1
  `;
  const params: any[] = [tenantId];
  let paramIndex = 2;
  
  if (filters.userId) {
    query += ` AND dl.user_id = $${paramIndex++}`;
    params.push(filters.userId);
  }
  
  if (filters.agentId) {
    query += ` AND dl.agent_id = $${paramIndex++}`;
    params.push(filters.agentId);
  }
  
  if (filters.decision) {
    query += ` AND dl.decision = $${paramIndex++}`;
    params.push(filters.decision);
  }
  
  if (filters.startDate) {
    query += ` AND dl.created_at >= $${paramIndex++}`;
    params.push(filters.startDate);
  }
  
  if (filters.endDate) {
    query += ` AND dl.created_at <= $${paramIndex++}`;
    params.push(filters.endDate);
  }
  
  query += ' ORDER BY dl.created_at DESC';
  
  if (filters.limit) {
    query += ` LIMIT $${paramIndex++}`;
    params.push(filters.limit);
  }
  
  if (filters.offset) {
    query += ` OFFSET $${paramIndex++}`;
    params.push(filters.offset);
  }
  
  const result = await pool.query(query, params);
  return result.rows;
}

// Get admin action logs
export async function getAdminActionLogs(
  tenantId: string,
  filters: {
    adminId?: string;
    action?: string;
    targetType?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  } = {}
): Promise<any[]> {
  let query = `
    SELECT aal.*, u.email as admin_email
    FROM admin_action_logs aal
    JOIN users u ON aal.admin_id = u.id
    WHERE aal.tenant_id = $1
  `;
  const params: any[] = [tenantId];
  let paramIndex = 2;
  
  if (filters.adminId) {
    query += ` AND aal.admin_id = $${paramIndex++}`;
    params.push(filters.adminId);
  }
  
  if (filters.action) {
    query += ` AND aal.action = $${paramIndex++}`;
    params.push(filters.action);
  }
  
  if (filters.targetType) {
    query += ` AND aal.target_type = $${paramIndex++}`;
    params.push(filters.targetType);
  }
  
  if (filters.startDate) {
    query += ` AND aal.created_at >= $${paramIndex++}`;
    params.push(filters.startDate);
  }
  
  if (filters.endDate) {
    query += ` AND aal.created_at <= $${paramIndex++}`;
    params.push(filters.endDate);
  }
  
  query += ' ORDER BY aal.created_at DESC';
  
  if (filters.limit) {
    query += ` LIMIT $${paramIndex++}`;
    params.push(filters.limit);
  }
  
  if (filters.offset) {
    query += ` OFFSET $${paramIndex++}`;
    params.push(filters.offset);
  }
  
  const result = await pool.query(query, params);
  return result.rows;
}
