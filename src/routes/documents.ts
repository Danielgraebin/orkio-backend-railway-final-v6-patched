import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/index.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { processDocument } from '../services/rag.js';
import { logAdminAction } from '../services/logging.js';
import { sanitizeFilename, formatBytes } from '../utils/index.js';

const router = Router();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = process.env.UPLOAD_DIR || './uploads';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${uuidv4().slice(0, 8)}`;
    const sanitized = sanitizeFilename(file.originalname);
    cb(null, `${uniqueSuffix}-${sanitized}`);
  },
});

const fileFilter = (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedTypes = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/markdown',
  ];
  
  const allowedExtensions = ['.pdf', '.docx', '.txt', '.md'];
  const ext = path.extname(file.originalname).toLowerCase();
  
  if (allowedTypes.includes(file.mimetype) || allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Allowed: PDF, DOCX, TXT, MD'));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB || '16')) * 1024 * 1024,
  },
});

// Get all documents
router.get('/', authenticate, async (req: Request, res: Response) => {
  try {
    const { collectionId, status } = req.query;
    
    let query = `
      SELECT d.*, c.name as collection_name
      FROM documents d
      JOIN collections c ON d.collection_id = c.id
      WHERE d.tenant_id = $1
    `;
    const params: any[] = [req.tenantId];
    
    if (collectionId) {
      params.push(collectionId);
      query += ` AND d.collection_id = $${params.length}`;
    }
    
    if (status) {
      params.push(status);
      query += ` AND d.status = $${params.length}`;
    }
    
    query += ' ORDER BY d.created_at DESC';
    
    const result = await pool.query(query, params);
    
    res.json({
      success: true,
      data: result.rows.map(d => ({
        id: d.id,
        name: d.name,
        collectionId: d.collection_id,
        collectionName: d.collection_name,
        mimeType: d.mime_type,
        fileSize: d.file_size,
        fileSizeFormatted: formatBytes(d.file_size),
        status: d.status,
        errorMessage: d.error_message,
        version: d.version,
        createdAt: d.created_at,
        updatedAt: d.updated_at,
      })),
    });
  } catch (error) {
    console.error('Get documents error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Get single document
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT d.*, c.name as collection_name,
              (SELECT COUNT(*) FROM embeddings WHERE document_id = d.id) as chunk_count
       FROM documents d
       JOIN collections c ON d.collection_id = c.id
       WHERE d.id = $1 AND d.tenant_id = $2`,
      [req.params.id, req.tenantId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Document not found' });
    }
    
    const d = result.rows[0];
    res.json({
      success: true,
      data: {
        id: d.id,
        name: d.name,
        collectionId: d.collection_id,
        collectionName: d.collection_name,
        mimeType: d.mime_type,
        fileSize: d.file_size,
        fileSizeFormatted: formatBytes(d.file_size),
        status: d.status,
        errorMessage: d.error_message,
        version: d.version,
        chunkCount: parseInt(d.chunk_count),
        createdAt: d.created_at,
        updatedAt: d.updated_at,
      },
    });
  } catch (error) {
    console.error('Get document error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Upload document (admin only)
router.post('/upload', authenticate, authorize('master_admin', 'tenant_admin'), upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }
    
    const { collectionId } = req.body;
    
    if (!collectionId) {
      // Delete uploaded file
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, error: 'Collection ID is required' });
    }
    
    // Verify collection exists and belongs to tenant
    const collectionResult = await pool.query(
      'SELECT id FROM collections WHERE id = $1 AND tenant_id = $2',
      [collectionId, req.tenantId]
    );
    
    if (collectionResult.rows.length === 0) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ success: false, error: 'Collection not found' });
    }
    
    // Create document record
    const documentId = uuidv4();
    await pool.query(
      `INSERT INTO documents (id, tenant_id, collection_id, name, file_path, mime_type, file_size, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
      [
        documentId,
        req.tenantId,
        collectionId,
        req.file.originalname,
        req.file.path,
        req.file.mimetype,
        req.file.size,
      ]
    );
    
    await logAdminAction(req, 'upload_document', 'document', documentId, {
      name: req.file.originalname,
      size: req.file.size,
      collectionId,
    });
    
    // Process document asynchronously
    processDocument(documentId).catch(error => {
      console.error('Background document processing failed:', error);
    });
    
    res.status(201).json({
      success: true,
      data: {
        id: documentId,
        name: req.file.originalname,
        status: 'pending',
        message: 'Document uploaded and queued for processing',
      },
    });
  } catch (error) {
    console.error('Upload document error:', error);
    
    // Clean up file if it exists
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Reprocess document
router.post('/:id/reprocess', authenticate, authorize('master_admin', 'tenant_admin'), async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT * FROM documents WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Document not found' });
    }
    
    const doc = result.rows[0];
    
    // Check if file still exists
    if (!fs.existsSync(doc.file_path)) {
      return res.status(400).json({ success: false, error: 'Document file not found on disk' });
    }
    
    // Increment version
    await pool.query(
      "UPDATE documents SET status = 'pending', version = version + 1, error_message = NULL, updated_at = NOW() WHERE id = $1",
      [req.params.id]
    );
    
    // Reprocess
    processDocument(req.params.id).catch(error => {
      console.error('Background document reprocessing failed:', error);
    });
    
    await logAdminAction(req, 'reprocess_document', 'document', req.params.id, { name: doc.name });
    
    res.json({
      success: true,
      message: 'Document queued for reprocessing',
    });
  } catch (error) {
    console.error('Reprocess document error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Delete document
router.delete('/:id', authenticate, authorize('master_admin', 'tenant_admin'), async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT * FROM documents WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Document not found' });
    }
    
    const doc = result.rows[0];
    
    // Delete embeddings (cascade should handle this, but be explicit)
    await pool.query('DELETE FROM embeddings WHERE document_id = $1', [req.params.id]);
    
    // Delete document record
    await pool.query('DELETE FROM documents WHERE id = $1', [req.params.id]);
    
    // Delete file from disk
    if (fs.existsSync(doc.file_path)) {
      fs.unlinkSync(doc.file_path);
    }
    
    await logAdminAction(req, 'delete_document', 'document', req.params.id, { name: doc.name });
    
    res.json({ success: true, message: 'Document deleted successfully' });
  } catch (error) {
    console.error('Delete document error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Get document chunks (for debugging/admin)
router.get('/:id/chunks', authenticate, authorize('master_admin', 'tenant_admin'), async (req: Request, res: Response) => {
  try {
    const docResult = await pool.query(
      'SELECT id FROM documents WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    
    if (docResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Document not found' });
    }
    
    const chunksResult = await pool.query(
      'SELECT id, chunk_index, chunk_text, created_at FROM embeddings WHERE document_id = $1 ORDER BY chunk_index',
      [req.params.id]
    );
    
    res.json({
      success: true,
      data: chunksResult.rows.map(c => ({
        id: c.id,
        index: c.chunk_index,
        text: c.chunk_text,
        createdAt: c.created_at,
      })),
    });
  } catch (error) {
    console.error('Get chunks error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
