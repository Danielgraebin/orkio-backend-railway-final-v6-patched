import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JWTPayload, UserRole } from '../types/index.js';

export function authenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }
  
  const token = authHeader.split(' ')[1];
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JWTPayload;
    req.user = decoded;
    req.tenantId = decoded.tenantId;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

export function authorize(...allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    
    if (!allowedRoles.includes(req.user.role as UserRole)) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions' });
    }
    
    next();
  };
}

export function requireApproval(req: Request, res: Response, next: NextFunction) {
  // This will be checked in the route handler with database query
  // For now, just pass through
  next();
}

export function tenantIsolation(req: Request, res: Response, next: NextFunction) {
  if (!req.user || !req.tenantId) {
    return res.status(401).json({ success: false, error: 'Tenant context required' });
  }
  next();
}
