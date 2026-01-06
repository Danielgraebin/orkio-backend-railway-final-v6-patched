import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/index.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { agentSchema } from '../utils/index.js';
import { logAdminAction } from '../services/logging.js';

const router = Router();

// Get all agents
router.get('/', authenticate, async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT a.*, 
              COALESCE(json_agg(DISTINCT ac.collection_id) FILTER (WHERE ac.collection_id IS NOT NULL), '[]') as collection_ids
       FROM agents a
       LEFT JOIN agent_collections ac ON a.id = ac.agent_id
       WHERE a.tenant_id = $1 AND a.is_active = true
       GROUP BY a.id
       ORDER BY a.created_at DESC`,
      [req.tenantId]
    );
    
    res.json({
      success: true,
      data: result.rows.map(a => ({
        id: a.id,
        name: a.name,
        description: a.description,
        systemPrompt: a.system_prompt,
        model: a.model,
        temperature: a.temperature,
        mode: a.mode,
        allowedTopics: a.allowed_topics,
        forbiddenTopics: a.forbidden_topics,
        costLimitDaily: a.cost_limit_daily,
        costUsedToday: a.cost_used_today,
        killSwitch: a.kill_switch,
        enableRag: a.enable_rag,
        collectionIds: a.collection_ids,
        createdAt: a.created_at,
        updatedAt: a.updated_at,
      })),
    });
  } catch (error) {
    console.error('Get agents error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Get single agent
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT a.*, 
              COALESCE(json_agg(DISTINCT ac.collection_id) FILTER (WHERE ac.collection_id IS NOT NULL), '[]') as collection_ids
       FROM agents a
       LEFT JOIN agent_collections ac ON a.id = ac.agent_id
       WHERE a.id = $1 AND a.tenant_id = $2
       GROUP BY a.id`,
      [req.params.id, req.tenantId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }
    
    const a = result.rows[0];
    res.json({
      success: true,
      data: {
        id: a.id,
        name: a.name,
        description: a.description,
        systemPrompt: a.system_prompt,
        model: a.model,
        temperature: a.temperature,
        mode: a.mode,
        allowedTopics: a.allowed_topics,
        forbiddenTopics: a.forbidden_topics,
        costLimitDaily: a.cost_limit_daily,
        costUsedToday: a.cost_used_today,
        killSwitch: a.kill_switch,
        enableRag: a.enable_rag,
        collectionIds: a.collection_ids,
        createdAt: a.created_at,
        updatedAt: a.updated_at,
      },
    });
  } catch (error) {
    console.error('Get agent error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Create agent (admin only)
router.post('/', authenticate, authorize('master_admin', 'tenant_admin'), async (req: Request, res: Response) => {
  try {
    const validation = agentSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ success: false, error: validation.error.errors[0].message });
    }
    
    const data = validation.data;
    const agentId = uuidv4();
    
    await pool.query(
      `INSERT INTO agents (id, tenant_id, name, description, system_prompt, model, temperature, mode, 
                           allowed_topics, forbidden_topics, cost_limit_daily, kill_switch, enable_rag)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        agentId, req.tenantId, data.name, data.description || null, data.system_prompt || null,
        data.model, data.temperature, data.mode,
        JSON.stringify(data.allowed_topics), JSON.stringify(data.forbidden_topics),
        data.cost_limit_daily, data.kill_switch, data.enable_rag
      ]
    );
    
    // Link collections if provided
    if (req.body.collectionIds && Array.isArray(req.body.collectionIds)) {
      for (const collectionId of req.body.collectionIds) {
        await pool.query(
          'INSERT INTO agent_collections (agent_id, collection_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [agentId, collectionId]
        );
      }
    }
    
    await logAdminAction(req, 'create_agent', 'agent', agentId, { name: data.name, mode: data.mode });
    
    res.status(201).json({
      success: true,
      data: { id: agentId, name: data.name },
    });
  } catch (error) {
    console.error('Create agent error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Update agent (admin only)
router.put('/:id', authenticate, authorize('master_admin', 'tenant_admin'), async (req: Request, res: Response) => {
  try {
    const validation = agentSchema.partial().safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ success: false, error: validation.error.errors[0].message });
    }
    
    const data = validation.data;
    
    // Build dynamic update query
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;
    
    if (data.name !== undefined) { updates.push(`name = $${paramIndex++}`); values.push(data.name); }
    if (data.description !== undefined) { updates.push(`description = $${paramIndex++}`); values.push(data.description); }
    if (data.system_prompt !== undefined) { updates.push(`system_prompt = $${paramIndex++}`); values.push(data.system_prompt); }
    if (data.model !== undefined) { updates.push(`model = $${paramIndex++}`); values.push(data.model); }
    if (data.temperature !== undefined) { updates.push(`temperature = $${paramIndex++}`); values.push(data.temperature); }
    if (data.mode !== undefined) { updates.push(`mode = $${paramIndex++}`); values.push(data.mode); }
    if (data.allowed_topics !== undefined) { updates.push(`allowed_topics = $${paramIndex++}`); values.push(JSON.stringify(data.allowed_topics)); }
    if (data.forbidden_topics !== undefined) { updates.push(`forbidden_topics = $${paramIndex++}`); values.push(JSON.stringify(data.forbidden_topics)); }
    if (data.cost_limit_daily !== undefined) { updates.push(`cost_limit_daily = $${paramIndex++}`); values.push(data.cost_limit_daily); }
    if (data.kill_switch !== undefined) { updates.push(`kill_switch = $${paramIndex++}`); values.push(data.kill_switch); }
    if (data.enable_rag !== undefined) { updates.push(`enable_rag = $${paramIndex++}`); values.push(data.enable_rag); }
    
    updates.push(`updated_at = NOW()`);
    
    values.push(req.params.id, req.tenantId);
    
    const result = await pool.query(
      `UPDATE agents SET ${updates.join(', ')} WHERE id = $${paramIndex++} AND tenant_id = $${paramIndex} RETURNING *`,
      values
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }
    
    // Update collections if provided
    if (req.body.collectionIds !== undefined) {
      await pool.query('DELETE FROM agent_collections WHERE agent_id = $1', [req.params.id]);
      
      if (Array.isArray(req.body.collectionIds)) {
        for (const collectionId of req.body.collectionIds) {
          await pool.query(
            'INSERT INTO agent_collections (agent_id, collection_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [req.params.id, collectionId]
          );
        }
      }
    }
    
    await logAdminAction(req, 'update_agent', 'agent', req.params.id, data);
    
    res.json({ success: true, message: 'Agent updated successfully' });
  } catch (error) {
    console.error('Update agent error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Toggle kill switch
router.post('/:id/kill-switch', authenticate, authorize('master_admin', 'tenant_admin'), async (req: Request, res: Response) => {
  try {
    const { enabled } = req.body;
    
    const result = await pool.query(
      'UPDATE agents SET kill_switch = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3 RETURNING *',
      [enabled === true, req.params.id, req.tenantId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }
    
    await logAdminAction(req, 'toggle_kill_switch', 'agent', req.params.id, { enabled });
    
    res.json({ success: true, message: `Kill switch ${enabled ? 'enabled' : 'disabled'}` });
  } catch (error) {
    console.error('Toggle kill switch error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Reset daily cost
router.post('/:id/reset-cost', authenticate, authorize('master_admin', 'tenant_admin'), async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      'UPDATE agents SET cost_used_today = 0, updated_at = NOW() WHERE id = $1 AND tenant_id = $2 RETURNING *',
      [req.params.id, req.tenantId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }
    
    await logAdminAction(req, 'reset_cost', 'agent', req.params.id, {});
    
    res.json({ success: true, message: 'Daily cost reset successfully' });
  } catch (error) {
    console.error('Reset cost error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Delete agent (soft delete)
router.delete('/:id', authenticate, authorize('master_admin', 'tenant_admin'), async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      'UPDATE agents SET is_active = false, updated_at = NOW() WHERE id = $1 AND tenant_id = $2 RETURNING name',
      [req.params.id, req.tenantId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }
    
    await logAdminAction(req, 'delete_agent', 'agent', req.params.id, { name: result.rows[0].name });
    
    res.json({ success: true, message: 'Agent deleted successfully' });
  } catch (error) {
    console.error('Delete agent error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
