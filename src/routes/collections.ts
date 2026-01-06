import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/index.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { collectionSchema } from '../utils/index.js';
import { logAdminAction } from '../services/logging.js';

const router = Router();

// Get all collections
router.get('/', authenticate, async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT c.*, 
              COUNT(d.id) as document_count,
              COALESCE(SUM(d.file_size), 0) as total_size
       FROM collections c
       LEFT JOIN documents d ON c.id = d.collection_id AND d.status = 'completed'
       WHERE c.tenant_id = $1
       GROUP BY c.id
       ORDER BY c.is_global DESC, c.created_at DESC`,
      [req.tenantId]
    );
    
    res.json({
      success: true,
      data: result.rows.map(c => ({
        id: c.id,
        name: c.name,
        description: c.description,
        isGlobal: c.is_global,
        documentCount: parseInt(c.document_count),
        totalSize: parseInt(c.total_size),
        createdAt: c.created_at,
        updatedAt: c.updated_at,
      })),
    });
  } catch (error) {
    console.error('Get collections error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Get single collection with documents
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const collectionResult = await pool.query(
      'SELECT * FROM collections WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    
    if (collectionResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Collection not found' });
    }
    
    const documentsResult = await pool.query(
      `SELECT id, name, mime_type, file_size, status, version, created_at, updated_at
       FROM documents WHERE collection_id = $1 ORDER BY created_at DESC`,
      [req.params.id]
    );
    
    const c = collectionResult.rows[0];
    res.json({
      success: true,
      data: {
        id: c.id,
        name: c.name,
        description: c.description,
        isGlobal: c.is_global,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        documents: documentsResult.rows.map(d => ({
          id: d.id,
          name: d.name,
          mimeType: d.mime_type,
          fileSize: d.file_size,
          status: d.status,
          version: d.version,
          createdAt: d.created_at,
          updatedAt: d.updated_at,
        })),
      },
    });
  } catch (error) {
    console.error('Get collection error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Create collection (admin only)
router.post('/', authenticate, authorize('master_admin', 'tenant_admin'), async (req: Request, res: Response) => {
  try {
    const validation = collectionSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ success: false, error: validation.error.errors[0].message });
    }
    
    const data = validation.data;
    const collectionId = uuidv4();
    
    await pool.query(
      `INSERT INTO collections (id, tenant_id, name, description, is_global)
       VALUES ($1, $2, $3, $4, $5)`,
      [collectionId, req.tenantId, data.name, data.description || null, data.is_global]
    );
    
    await logAdminAction(req, 'create_collection', 'collection', collectionId, { name: data.name, isGlobal: data.is_global });
    
    res.status(201).json({
      success: true,
      data: { id: collectionId, name: data.name },
    });
  } catch (error) {
    console.error('Create collection error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Update collection (admin only)
router.put('/:id', authenticate, authorize('master_admin', 'tenant_admin'), async (req: Request, res: Response) => {
  try {
    const validation = collectionSchema.partial().safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ success: false, error: validation.error.errors[0].message });
    }
    
    const data = validation.data;
    
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;
    
    if (data.name !== undefined) { updates.push(`name = $${paramIndex++}`); values.push(data.name); }
    if (data.description !== undefined) { updates.push(`description = $${paramIndex++}`); values.push(data.description); }
    if (data.is_global !== undefined) { updates.push(`is_global = $${paramIndex++}`); values.push(data.is_global); }
    
    updates.push(`updated_at = NOW()`);
    
    values.push(req.params.id, req.tenantId);
    
    const result = await pool.query(
      `UPDATE collections SET ${updates.join(', ')} WHERE id = $${paramIndex++} AND tenant_id = $${paramIndex} RETURNING *`,
      values
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Collection not found' });
    }
    
    await logAdminAction(req, 'update_collection', 'collection', req.params.id, data);
    
    res.json({ success: true, message: 'Collection updated successfully' });
  } catch (error) {
    console.error('Update collection error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Delete collection (admin only)
router.delete('/:id', authenticate, authorize('master_admin', 'tenant_admin'), async (req: Request, res: Response) => {
  try {
    // Check if collection has documents
    const docsResult = await pool.query(
      'SELECT COUNT(*) as count FROM documents WHERE collection_id = $1',
      [req.params.id]
    );
    
    if (parseInt(docsResult.rows[0].count) > 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Cannot delete collection with documents. Delete documents first.' 
      });
    }
    
    const result = await pool.query(
      'DELETE FROM collections WHERE id = $1 AND tenant_id = $2 RETURNING name',
      [req.params.id, req.tenantId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Collection not found' });
    }
    
    await logAdminAction(req, 'delete_collection', 'collection', req.params.id, { name: result.rows[0].name });
    
    res.json({ success: true, message: 'Collection deleted successfully' });
  } catch (error) {
    console.error('Delete collection error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
