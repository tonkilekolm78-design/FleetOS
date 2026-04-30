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
                                                                                                                                    'use strict';
                                                                                                                                    const { query } = require('../config/database');
                                                                                                                                    const logger = require('../utils/logger');
                                                                                                                                    let zonesCache = [], zonesCachedAt = 0;

                                                                                                                                    function haversineMetres(lat1,lon1,lat2,lon2) {
                                                                                                                                      const R=6371000, p1=lat1*Math.PI/180, p2=lat2*Math.PI/180;
                                                                                                                                        const dp=(lat2-lat1)*Math.PI/180, dl=(lon2-lon1)*Math.PI/180;
                                                                                                                                          const a=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
                                                                                                                                            return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
                                                                                                                                            }

                                                                                                                                            async function loadZones() {
                                                                                                                                              if (zonesCache.length && Date.now()-zonesCachedAt < 300000) return zonesCache;
                                                                                                                                                try {
                                                                                                                                                    const r = await query('SELECT zone_id,zone_code,zone_name,zone_type,latitude,longitude,radius_metres FROM zones WHERE is_active=TRUE');
                                                                                                                                                        zonesCache=r.rows; zonesCachedAt=Date.now();
                                                                                                                                                          } catch(e) { logger.warn('Geofence: could not load zones from DB'); }
                                                                                                                                                            return zonesCache;
                                                                                                                                                            }

                                                                                                                                                            const vehicleZoneState = new Map();

                                                                                                                                                            async function processPing(ping) {
                                                                                                                                                              try {
                                                                                                                                                                  const zones = await loadZones();
                                                                                                                                                                      if (!zones.length) return;
                                                                                                                                                                          const {vehicle_id,latitude,longitude,timestamp,ping_id} = ping;
                                                                                                                                                                              const currentZone = zones.find(z => haversineMetres(latitude,longitude,z.latitude,z.longitude) <= z.radius_metres) || null;
                                                                                                                                                                                  const prev = vehicleZoneState.get(vehicle_id)||null;
                                                                                                                                                                                      const sameZone = prev&&currentZone&&prev.zone_id===currentZone.zone_id;
                                                                                                                                                                                          if (!sameZone) {
                                                                                                                                                                                                if (prev) await handleExit(vehicle_id,prev,ping,ping_id);
                                                                                                                                                                                                      if (currentZone) await handleEntry(vehicle_id,currentZone,ping,ping_id);
                                                                                                                                                                                                          }
                                                                                                                                                                                                              vehicleZoneState.set(vehicle_id, currentZone ? {zone_id:currentZone.zone_id,zone_name:currentZone.zone_name,entered_at:sameZone?prev.entered_at:Date.now()} : null);
                                                                                                                                                                                                                  if (currentZone) await query('UPDATE gps_pings SET current_zone_id=$1 WHERE ping_id=$2',[currentZone.zone_id,ping_id]).catch(()=>{});
                                                                                                                                                                                                                    } catch(e) { logger.error('Geofence: processPing error',{error:e.message}); }
                                                                                                                                                                                                                    }

                                                                                                                                                                                                                    async function handleEntry(vehicleId,zone,ping,pingId) {
                                                                                                                                                                                                                      logger.info('Geofence: ZONE ENTRY',{fleet:vehicleId,zone:zone.zone_name});
                                                                                                                                                                                                                        try {
                                                                                                                                                                                                                            await query('INSERT INTO geofence_events(vehicle_id,zone_id,event_type,event_time,ping_id,latitude,longitude,speed_kmh,auto_note) VALUES($1,$2,\'zone_entry\',$3,$4,$5,$6,$7,$8)',
                                                                                                                                                                                                                                  [vehicleId,zone.zone_id,ping.timestamp,pingId,ping.latitude,ping.longitude,ping.speed_kmh,`Entered ${zone.zone_name}`]);
                                                                                                                                                                                                                                      const tripRes = await query('SELECT t.trip_id,t.trip_ref,t.dest_zone_id,t.driver_id,t.trip_status FROM trips t JOIN driver_checkins dc ON dc.driver_id=t.driver_id AND dc.vehicle_id=$1 AND dc.shift_date=CURRENT_DATE WHERE t.trip_status=\'in_transit\' ORDER BY t.created_at DESC LIMIT 1',[vehicleId]);
                                                                                                                                                                                                                                          if (tripRes.rows.length && tripRes.rows[0].dest_zone_id===zone.zone_id) {
                                                                                                                                                                                                                                                const trip=tripRes.rows[0];
                                                                                                                                                                                                                                                      await query('UPDATE trips SET trip_status=\'completed\',arrived_at=$1 WHERE trip_id=$2',[ping.timestamp,trip.trip_id]);
                                                                                                                                                                                                                                                            await query('UPDATE driver_checkins SET checkin_status=\'checked_in\' WHERE driver_id=$1 AND shift_date=CURRENT_DATE',[trip.driver_id]);
                                                                                                                                                                                                                                                                  await query('UPDATE loads SET load_status=\'delivered\' WHERE load_id=(SELECT load_id FROM trips WHERE trip_id=$1)',[trip.trip_id]);
                                                                                                                                                                                                                                                                        await query('INSERT INTO audit_log(event_source,event_type,entity_type,entity_id,description,vehicle_id,driver_id,trip_id) VALUES(\'geofence\',\'TRIP_COMPLETED\',\'trip\',$1,$2,$3,$4,$5)',
                                                                                                                                                                                                                                                                                [trip.trip_id,`Trip ${trip.trip_ref} completed at ${zone.zone_name}`,vehicleId,trip.driver_id,trip.trip_id]);
                                                                                                                                                                                                                                                                                      logger.info('Geofence: TRIP COMPLETED',{trip_ref:trip.trip_ref});
                                                                                                                                                                                                                                                                                          }
                                                                                                                                                                                                                                                                                            } catch(e){ logger.debug('Geofence: entry handler (demo)',{error:e.message}); }
                                                                                                                                                                                                                                                                                            }

                                                                                                                                                                                                                                                                                            async function handleExit(vehicleId,prev,ping,pingId) {
                                                                                                                                                                                                                                                                                              logger.info('Geofence: ZONE EXIT',{fleet:vehicleId,zone:prev.zone_name});
                                                                                                                                                                                                                                                                                                try {
                                                                                                                                                                                                                                                                                                    await query('INSERT INTO geofence_events(vehicle_id,zone_id,event_type,event_time,ping_id,latitude,longitude,speed_kmh,auto_note) VALUES($1,$2,\'zone_exit\',$3,$4,$5,$6,$7,$8)',
                                                                                                                                                                                                                                                                                                          [vehicleId,prev.zone_id,ping.timestamp,pingId,ping.latitude,ping.longitude,ping.speed_kmh,`Exited ${prev.zone_name}`]);
                                                                                                                                                                                                                                                                                                              const tripRes = await query('SELECT t.trip_id,t.trip_ref,t.origin_zone_id,t.driver_id FROM trips t JOIN driver_checkins dc ON dc.driver_id=t.driver_id AND dc.vehicle_id=$1 AND dc.shift_date=CURRENT_DATE WHERE t.trip_status=\'pending\' ORDER BY t.created_at DESC LIMIT 1',[vehicleId]);
                                                                                                                                                                                                                                                                                                                  if (tripRes.rows.length && tripRes.rows[0].origin_zone_id===prev.zone_id) {
                                                                                                                                                                                                                                                                                                                        const trip=tripRes.rows[0];
                                                                                                                                                                                                                                                                                                                              await query('UPDATE trips SET trip_status=\'in_transit\',departed_at=$1 WHERE trip_id=$2',[ping.timestamp,trip.trip_id]);
                                                                                                                                                                                                                                                                                                                                    await query('UPDATE loads SET load_status=\'in_transit\' WHERE load_id=(SELECT load_id FROM trips WHERE trip_id=$1)',[trip.trip_id]);
                                                                                                                                                                                                                                                                                                                                          await query('INSERT INTO audit_log(event_source,event_type,entity_type,entity_id,description,vehicle_id,driver_id,trip_id) VALUES(\'geofence\',\'TRIP_STARTED\',\'trip\',$1,$2,$3,$4,$5)',
                                                                                                                                                                                                                                                                                                                                                  [trip.trip_id,`Trip ${trip.trip_ref} started — exited ${prev.zone_name}`,vehicleId,trip.driver_id,trip.trip_id]);
                                                                                                                                                                                                                                                                                                                                                        logger.info('Geofence: TRIP STARTED',{trip_ref:trip.trip_ref});
                                                                                                                                                                                                                                                                                                                                                            }
                                                                                                                                                                                                                                                                                                                                                              } catch(e){ logger.debug('Geofence: exit handler (demo)',{error:e.message}); }
                                                                                                                                                                                                                                                                                                                                                              }

                                                                                                                                                                                                                                                                                                                                                              async function refreshZones() { zonesCachedAt=0; return loadZones(); }
                                                                                                                                                                                                                                                                                                                                                              module.exports = { processPing, refreshZones, vehicleZoneState };
                                                                                                                                                                                                                                                                                                                                                              