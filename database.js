'use strict';
const logger = require('../utils/logger');
let pool;
try {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL || null,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
  pool.on('error', err => logger.error('DB pool error', { error: err.message }));
} catch(e) {
  logger.warn('pg not available — running in demo mode');
}

async function query(sql, params=[]) {
  if (!pool) return { rows: [], rowCount: 0 };
  try { return await pool.query(sql, params); }
  catch(err) { logger.error('DB query error', { error: err.message, sql: sql.substring(0,60) }); throw err; }
}

async function withTransaction(fn) {
  if (!pool) return fn({ query: async()=>({rows:[]}) });
  const client = await pool.connect();
  try { await client.query('BEGIN'); const r = await fn(client); await client.query('COMMIT'); return r; }
  catch(err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
}

async function healthCheck() {
  if (!pool) return { ok: false, error: 'No DATABASE_URL set — running in demo mode' };
  try { const r = await pool.query('SELECT NOW() AS t'); return { ok: true, db_time: r.rows[0].t }; }
  catch(err) { return { ok: false, error: err.message }; }
}

module.exports = { query, withTransaction, healthCheck };
