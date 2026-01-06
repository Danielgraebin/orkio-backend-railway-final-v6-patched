import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';
import { pool } from '../db/index.js';
import { authenticate } from '../middleware/auth.js';
import { chat, chatWithDocument } from '../services/chat.js';
import { chatSchema } from '../utils/index.js';

const router = Router();

// Configure multer for chat file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = './uploads/chat';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    cb(null, `${uniqueSuffix}-${file.originalname}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 16 * 1024 * 1024 }, // 16MB
});

// Send chat message
router.post('/', authenticate, async (req: Request, res: Response) => {
  try {
    // Check if user is approved
    const userResult = await pool.query(
      'SELECT is_approved FROM users WHERE id = $1',
      [req.user!.userId]
    );
    
    if (userResult.rows.length === 0 || !userResult.rows[0].is_approved) {
      return res.status(403).json({ 
        success: false, 
        error: 'Your account is pending approval. Please wait for an administrator to approve your access.' 
      });
    }
    
    const validation = chatSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ success: false, error: validation.error.errors[0].message });
    }
    
    const { message, agentId, conversationId } = validation.data;
    
    const result = await chat(
      message,
      agentId,
      req.user!.userId,
      req.tenantId!,
      conversationId
    );
    
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// Chat with uploaded document
router.post('/upload', authenticate, upload.single('file'), async (req: Request, res: Response) => {
  try {
    // Check if user is approved
    const userResult = await pool.query(
      'SELECT is_approved FROM users WHERE id = $1',
      [req.user!.userId]
    );
    
    if (userResult.rows.length === 0 || !userResult.rows[0].is_approved) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(403).json({ 
        success: false, 
        error: 'Your account is pending approval.' 
      });
    }
    
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }
    
    const { message, agentId } = req.body;
    
    if (!message || !agentId) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, error: 'Message and agentId are required' });
    }
    
    // Extract text from document
    let documentContent = '';
    const ext = path.extname(req.file.originalname).toLowerCase();
    
    try {
      if (ext === '.docx') {
        const result = await mammoth.extractRawText({ path: req.file.path });
        documentContent = result.value;
      } else if (ext === '.pdf') {
        const dataBuffer = fs.readFileSync(req.file.path);
        const data = await pdfParse(dataBuffer);
        documentContent = data.text;
      } else if (ext === '.txt' || ext === '.md') {
        documentContent = fs.readFileSync(req.file.path, 'utf-8');
      } else {
        // Try to read as text
        documentContent = fs.readFileSync(req.file.path, 'utf-8');
      }
    } catch (extractError) {
      console.error('Document extraction error:', extractError);
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, error: 'Failed to extract text from document' });
    }
    
    // Clean up file
    fs.unlinkSync(req.file.path);
    
    if (!documentContent || documentContent.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'No text content found in document' });
    }
    
    const result = await chatWithDocument(
      message,
      documentContent,
      agentId,
      req.user!.userId,
      req.tenantId!
    );
    
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error('Chat upload error:', error);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// Get conversations
router.get('/conversations', authenticate, async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT c.*, a.name as agent_name,
              (SELECT content FROM chat_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message
       FROM conversations c
       JOIN agents a ON c.agent_id = a.id
       WHERE c.user_id = $1 AND c.tenant_id = $2
       ORDER BY c.updated_at DESC
       LIMIT 50`,
      [req.user!.userId, req.tenantId]
    );
    
    res.json({
      success: true,
      data: result.rows.map(c => ({
        id: c.id,
        title: c.title,
        agentId: c.agent_id,
        agentName: c.agent_name,
        lastMessage: c.last_message,
        isActive: c.is_active,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
      })),
    });
  } catch (error) {
    console.error('Get conversations error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Get conversation messages
router.get('/conversations/:id/messages', authenticate, async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT * FROM chat_messages 
       WHERE conversation_id = $1 AND user_id = $2 AND tenant_id = $3
       ORDER BY created_at ASC`,
      [req.params.id, req.user!.userId, req.tenantId]
    );
    
    res.json({
      success: true,
      data: result.rows.map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
        tokensUsed: m.tokens_used,
        latencyMs: m.latency_ms,
        evidence: m.evidence,
        createdAt: m.created_at,
      })),
    });
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Delete conversation
router.delete('/conversations/:id', authenticate, async (req: Request, res: Response) => {
  try {
    // Delete messages
    await pool.query(
      'DELETE FROM chat_messages WHERE conversation_id = $1 AND user_id = $2',
      [req.params.id, req.user!.userId]
    );
    
    // Delete conversation
    await pool.query(
      'DELETE FROM conversations WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user!.userId]
    );
    
    res.json({ success: true, message: 'Conversation deleted' });
  } catch (error) {
    console.error('Delete conversation error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
