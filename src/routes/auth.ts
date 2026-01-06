import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/index.js';
import { loginSchema, registerSchema } from '../utils/index.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { JWTPayload } from '../types/index.js';

const router = Router();

// Login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const validation = loginSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ success: false, error: validation.error.errors[0].message });
    }
    
    const { email, password } = validation.data;
    
    const result = await pool.query(
      'SELECT u.*, t.slug as tenant_slug FROM users u JOIN tenants t ON u.tenant_id = t.id WHERE u.email = $1 AND u.is_active = true',
      [email]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    
    const user = result.rows[0];
    
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    
    const payload: JWTPayload = {
      userId: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenant_id,
    };
    
    const expiresIn = process.env.JWT_EXPIRES_IN || '24h';
    const token = jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn } as jwt.SignOptions);
    
    res.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          tenantId: user.tenant_id,
          tenantSlug: user.tenant_slug,
          isApproved: user.is_approved,
        },
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Register (creates pending user)
router.post('/register', async (req: Request, res: Response) => {
  try {
    const validation = registerSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ success: false, error: validation.error.errors[0].message });
    }
    
    const { email, password } = validation.data;
    
    // Check if email already exists
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ success: false, error: 'Email already registered' });
    }
    
    // Get default tenant
    const tenantResult = await pool.query("SELECT id FROM tenants WHERE slug = 'default'");
    if (tenantResult.rows.length === 0) {
      return res.status(500).json({ success: false, error: 'Default tenant not found. Please run migrations.' });
    }
    const tenantId = tenantResult.rows[0].id;
    
    // Hash password with bcrypt (cost factor 12)
    const passwordHash = await bcrypt.hash(password, 12);
    
    // Create user (pending approval)
    const userId = uuidv4();
    await pool.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, role, is_approved, is_active)
       VALUES ($1, $2, $3, $4, 'user', false, true)`,
      [userId, tenantId, email, passwordHash]
    );
    
    res.status(201).json({
      success: true,
      message: 'Registration successful. Please wait for admin approval.',
      data: { userId, email, status: 'pending_approval' },
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Get current user
router.get('/me', authenticate, async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.role, u.is_approved, u.is_active, u.tenant_id, t.name as tenant_name, t.slug as tenant_slug
       FROM users u JOIN tenants t ON u.tenant_id = t.id
       WHERE u.id = $1`,
      [req.user!.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    const user = result.rows[0];
    res.json({
      success: true,
      data: {
        id: user.id,
        email: user.email,
        role: user.role,
        isApproved: user.is_approved,
        isActive: user.is_active,
        tenantId: user.tenant_id,
        tenantName: user.tenant_name,
        tenantSlug: user.tenant_slug,
      },
    });
  } catch (error) {
    console.error('Get me error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Change password
router.post('/change-password', authenticate, async (req: Request, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, error: 'Current and new password required' });
    }
    
    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, error: 'New password must be at least 8 characters' });
    }
    
    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user!.userId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    const validPassword = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
    if (!validPassword) {
      return res.status(401).json({ success: false, error: 'Current password is incorrect' });
    }
    
    const newHash = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [newHash, req.user!.userId]);
    
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
