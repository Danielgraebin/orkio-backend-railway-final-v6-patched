import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { checkConnection, checkPgVector } from './db/index.js';

// Import routes
import authRoutes from './routes/auth.js';
import usersRoutes from './routes/users.js';
import agentsRoutes from './routes/agents.js';
import collectionsRoutes from './routes/collections.js';
import documentsRoutes from './routes/documents.js';
import chatRoutes from './routes/chat.js';
import logsRoutes from './routes/logs.js';
import llmProvidersRoutes from './routes/llm-providers.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// CORS configuration
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
}));

// Compression
app.use(compression());

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Trust proxy for rate limiting behind reverse proxy
app.set('trust proxy', 1);

// Global rate limiter
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'), // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'),
  message: { success: false, error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Login rate limiter (stricter)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.LOGIN_RATE_LIMIT_MAX || '5'),
  message: { success: false, error: 'Too many login attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Chat rate limiter
const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: parseInt(process.env.CHAT_RATE_LIMIT_MAX || '30'),
  message: { success: false, error: 'Too many chat requests, please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply global rate limiter
app.use('/api', globalLimiter);

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    const dbConnected = await checkConnection();
    const pgVectorAvailable = await checkPgVector();
    
    res.json({
      success: true,
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || '6.0.0',
      database: dbConnected ? 'connected' : 'disconnected',
      pgVector: pgVectorAvailable ? 'available' : 'fallback',
      environment: process.env.NODE_ENV || 'development',
    });
  } catch (error) {
    res.status(503).json({
      success: false,
      status: 'unhealthy',
      error: (error as Error).message,
    });
  }
});

// API Routes
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/agents', agentsRoutes);
app.use('/api/collections', collectionsRoutes);
app.use('/api/documents', documentsRoutes);
app.use('/api/chat', chatLimiter, chatRoutes);
app.use('/api/logs', logsRoutes);
app.use('/api/llm-providers', llmProvidersRoutes);

// 404 handler
app.use('/api/*', (req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found' });
});

// Global error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  
  // Handle multer errors
  if (err.name === 'MulterError') {
    if (err.message === 'File too large') {
      return res.status(400).json({ success: false, error: 'File size exceeds limit' });
    }
    return res.status(400).json({ success: false, error: err.message });
  }
  
  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' 
      ? 'Internal server error' 
      : err.message,
  });
});

// Start server
async function start() {
  try {
    // Check database connection
    const dbConnected = await checkConnection();
    if (!dbConnected) {
      console.error('❌ Failed to connect to database');
      process.exit(1);
    }
    console.log('✅ Database connected');
    
    // Check pgvector
    const pgVectorAvailable = await checkPgVector();
    if (pgVectorAvailable) {
      console.log('✅ pgvector extension available');
    } else {
      console.log('⚠️  pgvector not available, using JavaScript fallback for similarity search');
    }
    
    app.listen(PORT, () => {
      console.log(`
🚀 Orkio Backend v6.0.0
   Server running on port ${PORT}
   Environment: ${process.env.NODE_ENV || 'development'}
   API: http://localhost:${PORT}/api
   Health: http://localhost:${PORT}/api/health
      `);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
