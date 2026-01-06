import { Router, Request, Response } from 'express';
import { authenticate, authorize } from '../middleware/auth.js';
import { getDecisionLogs, getAdminActionLogs } from '../services/logging.js';

const router = Router();

// Get decision logs (admin only)
router.get('/decisions', authenticate, authorize('master_admin', 'tenant_admin'), async (req: Request, res: Response) => {
  try {
    const { userId, agentId, decision, startDate, endDate, limit = '100', offset = '0' } = req.query;
    
    const logs = await getDecisionLogs(req.tenantId!, {
      userId: userId as string,
      agentId: agentId as string,
      decision: decision as string,
      startDate: startDate ? new Date(startDate as string) : undefined,
      endDate: endDate ? new Date(endDate as string) : undefined,
      limit: parseInt(limit as string),
      offset: parseInt(offset as string),
    });
    
    res.json({
      success: true,
      data: logs.map(l => ({
        id: l.id,
        userId: l.user_id,
        userEmail: l.user_email,
        agentId: l.agent_id,
        agentName: l.agent_name,
        action: l.action,
        decision: l.decision,
        reason: l.reason,
        inputPreview: l.input_preview,
        outputPreview: l.output_preview,
        metadata: l.metadata,
        createdAt: l.created_at,
      })),
    });
  } catch (error) {
    console.error('Get decision logs error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Get admin action logs (admin only)
router.get('/admin-actions', authenticate, authorize('master_admin', 'tenant_admin'), async (req: Request, res: Response) => {
  try {
    const { adminId, action, targetType, startDate, endDate, limit = '100', offset = '0' } = req.query;
    
    const logs = await getAdminActionLogs(req.tenantId!, {
      adminId: adminId as string,
      action: action as string,
      targetType: targetType as string,
      startDate: startDate ? new Date(startDate as string) : undefined,
      endDate: endDate ? new Date(endDate as string) : undefined,
      limit: parseInt(limit as string),
      offset: parseInt(offset as string),
    });
    
    res.json({
      success: true,
      data: logs.map(l => ({
        id: l.id,
        adminId: l.admin_id,
        adminEmail: l.admin_email,
        action: l.action,
        targetType: l.target_type,
        targetId: l.target_id,
        changes: l.changes,
        ipAddress: l.ip_address,
        userAgent: l.user_agent,
        createdAt: l.created_at,
      })),
    });
  } catch (error) {
    console.error('Get admin action logs error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Export decision logs as JSON
router.get('/decisions/export', authenticate, authorize('master_admin', 'tenant_admin'), async (req: Request, res: Response) => {
  try {
    const { startDate, endDate } = req.query;
    
    const logs = await getDecisionLogs(req.tenantId!, {
      startDate: startDate ? new Date(startDate as string) : undefined,
      endDate: endDate ? new Date(endDate as string) : undefined,
      limit: 10000, // Max export size
    });
    
    const exportData = {
      exportedAt: new Date().toISOString(),
      tenantId: req.tenantId,
      totalRecords: logs.length,
      filters: { startDate, endDate },
      logs: logs.map(l => ({
        id: l.id,
        userId: l.user_id,
        userEmail: l.user_email,
        agentId: l.agent_id,
        agentName: l.agent_name,
        action: l.action,
        decision: l.decision,
        reason: l.reason,
        inputPreview: l.input_preview,
        outputPreview: l.output_preview,
        metadata: l.metadata,
        createdAt: l.created_at,
      })),
    };
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=decision-logs-${new Date().toISOString().split('T')[0]}.json`);
    res.json(exportData);
  } catch (error) {
    console.error('Export decision logs error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Export admin action logs as JSON
router.get('/admin-actions/export', authenticate, authorize('master_admin', 'tenant_admin'), async (req: Request, res: Response) => {
  try {
    const { startDate, endDate } = req.query;
    
    const logs = await getAdminActionLogs(req.tenantId!, {
      startDate: startDate ? new Date(startDate as string) : undefined,
      endDate: endDate ? new Date(endDate as string) : undefined,
      limit: 10000,
    });
    
    const exportData = {
      exportedAt: new Date().toISOString(),
      tenantId: req.tenantId,
      totalRecords: logs.length,
      filters: { startDate, endDate },
      logs: logs.map(l => ({
        id: l.id,
        adminId: l.admin_id,
        adminEmail: l.admin_email,
        action: l.action,
        targetType: l.target_type,
        targetId: l.target_id,
        changes: l.changes,
        ipAddress: l.ip_address,
        userAgent: l.user_agent,
        createdAt: l.created_at,
      })),
    };
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=admin-action-logs-${new Date().toISOString().split('T')[0]}.json`);
    res.json(exportData);
  } catch (error) {
    console.error('Export admin action logs error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Get log statistics
router.get('/stats', authenticate, authorize('master_admin', 'tenant_admin'), async (req: Request, res: Response) => {
  try {
    const { pool } = await import('../db/index.js');
    
    // Decision stats
    const decisionStats = await pool.query(
      `SELECT decision, COUNT(*) as count 
       FROM decision_logs 
       WHERE tenant_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
       GROUP BY decision`,
      [req.tenantId]
    );
    
    // Daily activity
    const dailyActivity = await pool.query(
      `SELECT DATE(created_at) as date, COUNT(*) as count
       FROM decision_logs
       WHERE tenant_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
       GROUP BY DATE(created_at)
       ORDER BY date DESC`,
      [req.tenantId]
    );
    
    // Top blocked reasons
    const topBlockedReasons = await pool.query(
      `SELECT reason, COUNT(*) as count
       FROM decision_logs
       WHERE tenant_id = $1 AND decision = 'blocked' AND created_at >= NOW() - INTERVAL '30 days'
       GROUP BY reason
       ORDER BY count DESC
       LIMIT 10`,
      [req.tenantId]
    );
    
    res.json({
      success: true,
      data: {
        decisionBreakdown: decisionStats.rows,
        dailyActivity: dailyActivity.rows,
        topBlockedReasons: topBlockedReasons.rows,
      },
    });
  } catch (error) {
    console.error('Get log stats error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
