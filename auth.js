'use strict';
let jwt, bcrypt;
try { jwt = require('jsonwebtoken'); } catch(e) {}
try { bcrypt = require('bcrypt'); } catch(e) {}
const { query } = require('../../config/database');
const logger = require('../../utils/logger');

async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    if (!jwt) return next(); // demo mode
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'demo-secret');
    req.user = { user_id: decoded.user_id, role: decoded.role, username: decoded.username };
    next();
  } catch(err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: `Requires role: ${roles.join(' or ')}` });
    next();
  };
}

async function authenticateDevice(imei) {
  try {
    const r = await query('SELECT vehicle_id, fleet_number, status FROM vehicles WHERE tracker_imei=$1',[imei]);
    if (!r.rows.length || r.rows[0].status==='decommissioned') return null;
    return r.rows[0];
  } catch(e) { return null; }
}

module.exports = { authenticate, requireRole, authenticateDevice };
