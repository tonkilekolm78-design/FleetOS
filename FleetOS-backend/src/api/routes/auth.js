'use strict';
const express = require('express');
const router  = express.Router();
const { query } = require('../../config/database');
const { authenticate } = require('../middleware/auth');
const logger = require('../../utils/logger');
let jwt, bcrypt;
try { jwt = require('jsonwebtoken'); } catch(e) {}
try { bcrypt = require('bcrypt'); } catch(e) {}

// DEMO users when no DB
const DEMO_USERS = [
  { user_id:'1', username:'admin', password:'admin123', full_name:'System Administrator', role:'superadmin', is_active:true },
    { user_id:'2', username:'manager', password:'manager123', full_name:'Fleet Manager', role:'manager', is_active:true },
      { user_id:'3', username:'dispatcher', password:'dispatch123', full_name:'Dispatcher', role:'dispatcher', is_active:true },
      ];

      router.post('/login', async (req, res) => {
        const { username, password } = req.body;
          if (!username || !password) return res.status(400).json({ error: 'username and password required' });
            try {
                let user;
                    // Try DB first
                        try {
                              const r = await query('SELECT * FROM users WHERE username=$1 OR email=$1',[username.toLowerCase().trim()]);
                                    if (r.rows.length) {
                                            user = r.rows[0];
                                                    if (!user.is_active) return res.status(403).json({ error: 'Account inactive' });
                                                            if (bcrypt) {
                                                                      const valid = await bcrypt.compare(password, user.password_hash);
                                                                                if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
                                                                                        }
                                                                                              }
                                                                                                  } catch(e) {
                                                                                                        // Fall through to demo mode
                                                                                                            }

                                                                                                                // Demo mode fallback
                                                                                                                    if (!user) {
                                                                                                                          user = DEMO_USERS.find(u => u.username === username && u.password === password);
                                                                                                                                if (!user) return res.status(401).json({ error: 'Invalid credentials' });
                                                                                                                                    }

                                                                                                                                        const secret = process.env.JWT_SECRET || 'fleetos-demo-secret-key';
                                                                                                                                            const token = jwt
                                                                                                                                                  ? jwt.sign({ user_id: user.user_id, role: user.role, username: user.username }, secret, { expiresIn: '8h' })
                                                                                                                                                        : Buffer.from(JSON.stringify({ user_id: user.user_id, role: user.role })).toString('base64');

                                                                                                                                                            logger.info('AUTH: login', { username: user.username, role: user.role });
                                                                                                                                                                res.json({ ok: true, token, user: { user_id: user.user_id, username: user.username, full_name: user.full_name, role: user.role } });
                                                                                                                                                                  } catch(err) {
                                                                                                                                                                      logger.error('AUTH: login error', { error: err.message });
                                                                                                                                                                          res.status(500).json({ error: 'Login failed' });
                                                                                                                                                                            }
                                                                                                                                                                            });

                                                                                                                                                                            router.get('/me', authenticate, (req, res) => res.json({ ok: true, user: req.user }));

                                                                                                                                                                            module.exports = router;
                                                                                                                                                                            