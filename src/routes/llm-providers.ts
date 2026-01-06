import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/index.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { encrypt, decrypt, llmProviderSchema } from '../utils/index.js';
import { logAdminAction } from '../services/logging.js';

const router = Router();

// Get all LLM providers
router.get('/', authenticate, authorize('master_admin', 'tenant_admin'), async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT * FROM llm_providers WHERE tenant_id = $1 ORDER BY is_default DESC, created_at DESC',
      [req.tenantId]
    );
    
    res.json({
      success: true,
      data: result.rows.map(p => ({
        id: p.id,
        name: p.name,
        baseUrl: p.base_url,
        models: p.models,
        isDefault: p.is_default,
        isActive: p.is_active,
        hasApiKey: !!p.api_key_encrypted,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
      })),
    });
  } catch (error) {
    console.error('Get LLM providers error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Create LLM provider
router.post('/', authenticate, authorize('master_admin', 'tenant_admin'), async (req: Request, res: Response) => {
  try {
    const validation = llmProviderSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ success: false, error: validation.error.errors[0].message });
    }
    
    const data = validation.data;
    const providerId = uuidv4();
    
    // Encrypt API key
    const apiKeyEncrypted = encrypt(data.api_key);
    
    // If this is set as default, unset other defaults
    if (data.is_default) {
      await pool.query(
        'UPDATE llm_providers SET is_default = false WHERE tenant_id = $1',
        [req.tenantId]
      );
    }
    
    await pool.query(
      `INSERT INTO llm_providers (id, tenant_id, name, base_url, api_key_encrypted, models, is_default, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
      [
        providerId,
        req.tenantId,
        data.name,
        data.base_url || null,
        apiKeyEncrypted,
        JSON.stringify(data.models),
        data.is_default,
      ]
    );
    
    await logAdminAction(req, 'create_llm_provider', 'llm_provider', providerId, { name: data.name });
    
    res.status(201).json({
      success: true,
      data: { id: providerId, name: data.name },
    });
  } catch (error) {
    console.error('Create LLM provider error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Update LLM provider
router.put('/:id', authenticate, authorize('master_admin', 'tenant_admin'), async (req: Request, res: Response) => {
  try {
    const { name, base_url, api_key, models, is_default, is_active } = req.body;
    
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;
    
    if (name !== undefined) { updates.push(`name = $${paramIndex++}`); values.push(name); }
    if (base_url !== undefined) { updates.push(`base_url = $${paramIndex++}`); values.push(base_url || null); }
    if (api_key !== undefined) { updates.push(`api_key_encrypted = $${paramIndex++}`); values.push(encrypt(api_key)); }
    if (models !== undefined) { updates.push(`models = $${paramIndex++}`); values.push(JSON.stringify(models)); }
    if (is_active !== undefined) { updates.push(`is_active = $${paramIndex++}`); values.push(is_active); }
    
    // Handle default flag
    if (is_default === true) {
      await pool.query(
        'UPDATE llm_providers SET is_default = false WHERE tenant_id = $1',
        [req.tenantId]
      );
      updates.push(`is_default = $${paramIndex++}`);
      values.push(true);
    } else if (is_default === false) {
      updates.push(`is_default = $${paramIndex++}`);
      values.push(false);
    }
    
    updates.push(`updated_at = NOW()`);
    
    values.push(req.params.id, req.tenantId);
    
    const result = await pool.query(
      `UPDATE llm_providers SET ${updates.join(', ')} WHERE id = $${paramIndex++} AND tenant_id = $${paramIndex} RETURNING *`,
      values
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'LLM provider not found' });
    }
    
    await logAdminAction(req, 'update_llm_provider', 'llm_provider', req.params.id, { name });
    
    res.json({ success: true, message: 'LLM provider updated successfully' });
  } catch (error) {
    console.error('Update LLM provider error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Delete LLM provider
router.delete('/:id', authenticate, authorize('master_admin', 'tenant_admin'), async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      'DELETE FROM llm_providers WHERE id = $1 AND tenant_id = $2 RETURNING name',
      [req.params.id, req.tenantId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'LLM provider not found' });
    }
    
    await logAdminAction(req, 'delete_llm_provider', 'llm_provider', req.params.id, { name: result.rows[0].name });
    
    res.json({ success: true, message: 'LLM provider deleted successfully' });
  } catch (error) {
    console.error('Delete LLM provider error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Test LLM provider connection
router.post('/:id/test', authenticate, authorize('master_admin', 'tenant_admin'), async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT * FROM llm_providers WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'LLM provider not found' });
    }
    
    const provider = result.rows[0];
    const apiKey = decrypt(provider.api_key_encrypted);
    
    // Test with OpenAI-compatible API
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({
      apiKey,
      baseURL: provider.base_url || undefined,
    });
    
    const completion = await client.chat.completions.create({
      model: provider.models[0] || 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: 'Say "test successful" in exactly two words.' }],
      max_tokens: 10,
    });
    
    res.json({
      success: true,
      message: 'Connection successful',
      response: completion.choices[0]?.message?.content,
    });
  } catch (error) {
    console.error('Test LLM provider error:', error);
    res.status(400).json({ success: false, error: `Connection failed: ${(error as Error).message}` });
  }
});

export default router;
