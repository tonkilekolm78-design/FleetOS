// ============================================================
//  FleetOS — Main API Server
//  src/server.js
//
//  Starts the Express API server.
//  Boots the Cross-Check Engine scheduler.
//  The GPS TCP Listener runs as a separate process (npm run gps).
// ============================================================
'use strict';

require('dotenv').config();

const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const { healthCheck } = require('./config/database');
const logger          = require('./utils/logger');
const CrossCheck      = require('./crosscheck/engine');

// ── Route imports ────────────────────────────────────────────
const authRoutes   = require('./api/routes/auth');
const opsRoutes    = require('./api/routes/operations');
const adminRoutes  = require('./api/routes/administration');
const mgmtRoutes   = require('./api/routes/management');

const app  = express();
const PORT = parseInt(process.env.PORT || '3000');

// ── Security middleware ──────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false // Disable for API server
}));

// ── CORS ─────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5500').split(',');
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      logger.warn('CORS: blocked origin', { origin });
      callback(new Error(`CORS: ${origin} not allowed`));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// ── Rate limiting ────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  message: { error: 'Too many requests — please try again later' },
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', limiter);

// Stricter limit on auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts — please wait 15 minutes' }
});
app.use('/api/auth/login', authLimiter);

// ── Body parsing ─────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Request logger ───────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
    logger[level]('HTTP', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: duration,
      ip: req.ip
    });
  });
  next();
});

// ── API Routes ───────────────────────────────────────────────
app.use('/api/auth',  authRoutes);
app.use('/api/ops',   opsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/mgmt',  mgmtRoutes);

// ── Health check endpoint (Render uses this) ─────────────────
app.get('/health', async (req, res) => {
  const db = await healthCheck();
  const status = db.ok ? 200 : 503;
  res.status(status).json({
    status  : db.ok ? 'healthy' : 'degraded',
    service : 'fleetos-api',
    version : '1.0.0',
    db      : db,
    uptime  : Math.floor(process.uptime()),
    memory  : process.memoryUsage(),
    timestamp: new Date().toISOString()
  });
});

// ── API root ─────────────────────────────────────────────────
app.get('/api', (req, res) => {
  res.json({
    service: 'FleetOS API',
    version: '1.0.0',
    engines: {
      operations    : '/api/ops',
      administration: '/api/admin',
      management    : '/api/mgmt'
    },
    docs: 'https://docs.fleetos.co.za'
  });
});

// ── GPS status endpoint ──────────────────────────────────────
app.get('/api/gps/status', (req, res) => {
  try {
    // Only available if GPS listener is running in same process
    // In production, GPS runs as separate Render Background Worker
    res.json({
      ok: true,
      note: 'GPS listener runs as a separate Background Worker on Render',
      tcp_port: process.env.GPS_TCP_PORT || '8080'
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── 404 handler ──────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ── Global error handler ─────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    path: req.path
  });

  if (err.message?.includes('CORS')) {
    return res.status(403).json({ error: err.message });
  }
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start server ─────────────────────────────────────────────
async function start() {
  try {
    // Verify DB connection before starting
    const db = await healthCheck();
    if (!db.ok) {
      logger.error('Cannot connect to database — exiting', { error: db.error });
      process.exit(1);
    }
    logger.info('Database connected', { db_time: db.db_time });

    // Start the cross-check engine scheduler
    CrossCheck.startScheduler();

    // Start HTTP server
    app.listen(PORT, () => {
      logger.info('FleetOS API Server started', {
        port: PORT,
        env : process.env.NODE_ENV || 'development',
        engines: ['Operations', 'Administration', 'Management', 'CrossCheck']
      });
      logger.info('GPS TCP Listener: start separately with: npm run gps');
    });

  } catch (err) {
    logger.error('Fatal startup error', { error: err.message });
    process.exit(1);
  }
}

// ── Graceful shutdown ────────────────────────────────────────
process.on('SIGTERM', () => {
  logger.info('SIGTERM received — shutting down gracefully');
  process.exit(0);
});
process.on('SIGINT', () => {
  logger.info('SIGINT received — shutting down');
  process.exit(0);
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: String(reason) });
});

start();

module.exports = app;
