// ============================================================
//  FleetOS — Database Connection Pool
//  src/config/database.js
// ============================================================
'use strict';

const { Pool } = require('pg');
const logger   = require('../utils/logger');

// ── Connection Pool ──────────────────────────────────────────
const pool = new Pool({
  connectionString : process.env.DATABASE_URL,
  ssl              : process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  min              : parseInt(process.env.DB_POOL_MIN  || '2'),
  max              : parseInt(process.env.DB_POOL_MAX  || '10'),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Log pool events
pool.on('connect',   ()  => logger.debug('DB: new client connected'));
pool.on('error', (err)   => logger.error('DB: idle client error', { error: err.message }));

// ── Query Helper ─────────────────────────────────────────────
// Wraps pool.query with logging and timing
async function query(sql, params = []) {
  const start = Date.now();
  try {
    const result = await pool.query(sql, params);
    const duration = Date.now() - start;
    if (duration > 500) {
      // Log slow queries (>500ms) for tuning
      logger.warn('DB: slow query', { duration, sql: sql.substring(0, 80) });
    }
    return result;
  } catch (err) {
    logger.error('DB: query error', { error: err.message, sql: sql.substring(0, 80) });
    throw err;
  }
}

// ── Transaction Helper ───────────────────────────────────────
// Usage: await withTransaction(async (client) => { ... })
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('DB: transaction rolled back', { error: err.message });
    throw err;
  } finally {
    client.release();
  }
}

// ── Health Check ─────────────────────────────────────────────
async function healthCheck() {
  try {
    const result = await query('SELECT NOW() AS db_time, version() AS version');
    return { ok: true, db_time: result.rows[0].db_time };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { pool, query, withTransaction, healthCheck };
