'use strict';
require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const { healthCheck } = require('./config/database');
const logger     = require('./utils/logger');
const CrossCheck = require('./crosscheck/engine');

const authRoutes  = require('./api/routes/auth');
const opsRoutes   = require('./api/routes/operations');
const adminRoutes = require('./api/routes/administration');
const mgmtRoutes  = require('./api/routes/management');

const app  = express();
const PORT = parseInt(process.env.PORT || '3000');

app.use(helmet({ contentSecurityPolicy: false }));

const origins = (process.env.ALLOWED_ORIGINS || '*').split(',');
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || origins.includes('*') || origins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: ${origin} not allowed`));
  },
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logger
app.use((req, res, next) => {
  res.on('finish', () => {
    const lvl = res.statusCode>=500?'error':res.statusCode>=400?'warn':'debug';
    logger[lvl]('HTTP', { method:req.method, path:req.path, status:res.statusCode });
  });
  next();
});

// Routes
app.use('/api/auth',  authRoutes);
app.use('/api/ops',   opsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/mgmt',  mgmtRoutes);

// Health
app.get('/health', async (req, res) => {
  const db = await healthCheck();
  res.status(db.ok?200:200).json({
    status: db.ok ? 'healthy' : 'running (no database)',
    service: 'fleetos-api', version: '1.0.0',
    database: db.ok ? 'connected' : db.error,
    mode: db.ok ? 'live' : 'demo',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// API index
app.get('/api', (req, res) => res.json({
  service: 'FleetOS API', version: '1.0.0',
  mode: process.env.DATABASE_URL ? 'live' : 'demo',
  endpoints: {
    auth:  ['/api/auth/login', '/api/auth/me'],
    ops:   ['/api/ops/fleet', '/api/ops/queue', '/api/ops/loads', '/api/ops/alerts', '/api/ops/summary'],
    admin: ['/api/admin/audit-log', '/api/admin/trip-costs', '/api/admin/pay-periods', '/api/admin/payroll/calculate'],
    mgmt:  ['/api/mgmt/cpk', '/api/mgmt/maintenance', '/api/mgmt/crosscheck', '/api/mgmt/dashboard-summary']
  }
}));

app.use((req, res) => res.status(404).json({ error: `Not found: ${req.method} ${req.path}` }));
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

async function start() {
  const db = await healthCheck();
  if (db.ok) {
    logger.info('Database connected', { time: db.db_time });
  } else {
    logger.warn('No database — starting in DEMO MODE', { reason: db.error });
    logger.warn('Set DATABASE_URL in .env to connect a real database');
  }
  CrossCheck.startScheduler();
  app.listen(PORT, () => {
    logger.info(`FleetOS API running on http://localhost:${PORT}`);
    logger.info(`Health:    http://localhost:${PORT}/health`);
    logger.info(`API index: http://localhost:${PORT}/api`);
    logger.info(`Mode: ${db.ok ? 'LIVE (database connected)' : 'DEMO (no database)'}`);
  });
}

process.on('SIGTERM', () => { logger.info('Shutting down'); process.exit(0); });
process.on('SIGINT',  () => { logger.info('Shutting down'); process.exit(0); });
process.on('unhandledRejection', r => logger.error('Unhandled rejection', { reason: String(r) }));

start();
module.exports = app;
