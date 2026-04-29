// ============================================================
//  FleetOS — Auth Middleware
//  src/api/middleware/auth.js
// ============================================================
'use strict';

const jwt    = require('jsonwebtoken');
const { query } = require('../../config/database');
const logger = require('../../utils/logger');

// ── Verify JWT token ─────────────────────────────────────────
async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token   = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Confirm user still exists and is active
    const result = await query(
      `SELECT user_id, username, full_name, role, is_active
       FROM users WHERE user_id = $1`,
      [decoded.user_id]
    );

    if (!result.rows.length || !result.rows[0].is_active) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }

    req.user = result.rows[0];
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired — please log in again' });
    }
    logger.warn('Auth: invalid token', { error: err.message, ip: req.ip });
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ── Role-based access guard ──────────────────────────────────
// Usage: router.get('/admin', authenticate, requireRole('manager','superadmin'), handler)
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    if (!roles.includes(req.user.role)) {
      logger.warn('Auth: insufficient role', {
        user: req.user.username,
        required: roles,
        actual: req.user.role
      });
      return res.status(403).json({
        error: `Access denied — requires role: ${roles.join(' or ')}`
      });
    }
    next();
  };
}

// ── GPS Listener auth (IMEI-based, not JWT) ──────────────────
async function authenticateDevice(imei) {
  const result = await query(
    `SELECT vehicle_id, fleet_number, status
     FROM vehicles WHERE tracker_imei = $1`,
    [imei]
  );
  if (!result.rows.length) return null;
  if (result.rows[0].status === 'decommissioned') return null;
  return result.rows[0];
}

module.exports = { authenticate, requireRole, authenticateDevice };
