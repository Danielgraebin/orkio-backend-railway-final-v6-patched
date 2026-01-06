import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/index.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { logAdminAction } from '../services/logging.js';

const router = Router();

// Get all users (admin only)
router.get('/', authenticate, authorize('master_admin', 'tenant_admin'), async (req: Request, res: Response) => {
  try {
    const { status, role } = req.query;
    
    let query = `
      SELECT u.id, u.email, u.role, u.is_approved, u.is_active, u.created_at, u.updated_at,
             t.name as tenant_name, t.slug as tenant_slug
      FROM users u
      JOIN tenants t ON u.tenant_id = t.id
      WHERE u.tenant_id = $1
    `;
    const params: any[] = [req.tenantId];
    
    if (status === 'pending') {
      query += ' AND u.is_approved = false';
    } else if (status === 'approved') {
      query += ' AND u.is_approved = true';
    }
    
    if (role) {
      params.push(role);
      query += ` AND u.role = $${params.length}`;
    }
    
    query += ' ORDER BY u.created_at DESC';
    
    const result = await pool.query(query, params);
    
    res.json({
      success: true,
      data: result.rows.map(u => ({
        id: u.id,
        email: u.email,
        role: u.role,
        isApproved: u.is_approved,
        isActive: u.is_active,
        tenantName: u.tenant_name,
        tenantSlug: u.tenant_slug,
        createdAt: u.created_at,
        updatedAt: u.updated_at,
      })),
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Get single user
router.get('/:id', authenticate, authorize('master_admin', 'tenant_admin'), async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT u.*, t.name as tenant_name, t.slug as tenant_slug
       FROM users u JOIN tenants t ON u.tenant_id = t.id
       WHERE u.id = $1 AND u.tenant_id = $2`,
      [req.params.id, req.tenantId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    const u = result.rows[0];
    res.json({
      success: true,
      data: {
        id: u.id,
        email: u.email,
        role: u.role,
        isApproved: u.is_approved,
        isActive: u.is_active,
        tenantName: u.tenant_name,
        tenantSlug: u.tenant_slug,
        createdAt: u.created_at,
        updatedAt: u.updated_at,
      },
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Approve user
router.post('/:id/approve', authenticate, authorize('master_admin', 'tenant_admin'), async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      'UPDATE users SET is_approved = true, updated_at = NOW() WHERE id = $1 AND tenant_id = $2 RETURNING *',
      [req.params.id, req.tenantId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    await logAdminAction(req, 'approve_user', 'user', req.params.id, { approved: true });
    
    res.json({ success: true, message: 'User approved successfully' });
  } catch (error) {
    console.error('Approve user error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Reject/Deactivate user
router.post('/:id/deactivate', authenticate, authorize('master_admin', 'tenant_admin'), async (req: Request, res: Response) => {
  try {
    // Prevent self-deactivation
    if (req.params.id === req.user!.userId) {
      return res.status(400).json({ success: false, error: 'Cannot deactivate yourself' });
    }
    
    const result = await pool.query(
      'UPDATE users SET is_active = false, updated_at = NOW() WHERE id = $1 AND tenant_id = $2 RETURNING *',
      [req.params.id, req.tenantId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    await logAdminAction(req, 'deactivate_user', 'user', req.params.id, { active: false });
    
    res.json({ success: true, message: 'User deactivated successfully' });
  } catch (error) {
    console.error('Deactivate user error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Reactivate user
router.post('/:id/activate', authenticate, authorize('master_admin', 'tenant_admin'), async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      'UPDATE users SET is_active = true, updated_at = NOW() WHERE id = $1 AND tenant_id = $2 RETURNING *',
      [req.params.id, req.tenantId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    await logAdminAction(req, 'activate_user', 'user', req.params.id, { active: true });
    
    res.json({ success: true, message: 'User activated successfully' });
  } catch (error) {
    console.error('Activate user error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Update user role (master_admin only)
router.patch('/:id/role', authenticate, authorize('master_admin'), async (req: Request, res: Response) => {
  try {
    const { role } = req.body;
    
    if (!['user', 'tenant_admin'].includes(role)) {
      return res.status(400).json({ success: false, error: 'Invalid role. Must be user or tenant_admin' });
    }
    
    // Prevent changing own role
    if (req.params.id === req.user!.userId) {
      return res.status(400).json({ success: false, error: 'Cannot change your own role' });
    }
    
    const result = await pool.query(
      'UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3 RETURNING *',
      [role, req.params.id, req.tenantId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    await logAdminAction(req, 'change_role', 'user', req.params.id, { newRole: role });
    
    res.json({ success: true, message: 'User role updated successfully' });
  } catch (error) {
    console.error('Update role error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Create user (admin)
router.post('/', authenticate, authorize('master_admin', 'tenant_admin'), async (req: Request, res: Response) => {
  try {
    const { email, password, role = 'user' } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password required' });
    }
    
    // tenant_admin can only create users, not other admins
    if (req.user!.role === 'tenant_admin' && role !== 'user') {
      return res.status(403).json({ success: false, error: 'Tenant admins can only create regular users' });
    }
    
    // Check if email exists
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ success: false, error: 'Email already exists' });
    }
    
    const passwordHash = await bcrypt.hash(password, 12);
    const userId = uuidv4();
    
    await pool.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, role, is_approved, is_active)
       VALUES ($1, $2, $3, $4, $5, true, true)`,
      [userId, req.tenantId, email, passwordHash, role]
    );
    
    await logAdminAction(req, 'create_user', 'user', userId, { email, role });
    
    res.status(201).json({
      success: true,
      data: { id: userId, email, role },
    });
  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Delete user
router.delete('/:id', authenticate, authorize('master_admin'), async (req: Request, res: Response) => {
  try {
    if (req.params.id === req.user!.userId) {
      return res.status(400).json({ success: false, error: 'Cannot delete yourself' });
    }
    
    const result = await pool.query(
      'DELETE FROM users WHERE id = $1 AND tenant_id = $2 RETURNING email',
      [req.params.id, req.tenantId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    await logAdminAction(req, 'delete_user', 'user', req.params.id, { email: result.rows[0].email });
    
    res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
