'use strict';
const express = require('express');
const router  = express.Router();
const { query, withTransaction } = require('../../config/database');
const { authenticate } = require('../middleware/auth');
const logger = require('../../utils/logger');

router.use(authenticate);

// DEMO data for when no DB is connected
const DEMO = {
  fleet: [
      { fleet_number:'TRK-004', driver_name:'Mokoena, K.', driver_status:'checked_in', trip_status:'in_transit', last_lat:-26.1052, last_lon:28.0560, last_speed:87, hours_remaining:9.2, current_zone:'En Route', active_trip:'TRIP-2201', eta_breach:false },
          { fleet_number:'TRK-011', driver_name:'Dlamini, L.', driver_status:'checked_in', trip_status:null, last_lat:-26.2041, last_lon:28.0473, last_speed:0, hours_remaining:7.8, current_zone:'Depot A', active_trip:null, eta_breach:false },
              { fleet_number:'TRK-007', driver_name:'Pieterse, N.', driver_status:'on_load', trip_status:'in_transit', last_lat:-33.1200, last_lon:19.4100, last_speed:102, hours_remaining:6.1, current_zone:'En Route', active_trip:'TRIP-2198', eta_breach:false },
                  { fleet_number:'TRK-002', driver_name:'Vermeulen, S.', driver_status:'resting', trip_status:null, last_lat:-33.4667, last_lon:19.6167, last_speed:0, hours_remaining:2.1, current_zone:'N1 Layby', active_trip:null, eta_breach:false },
                      { fleet_number:'TRK-009', driver_name:'Nkosi, L.', driver_status:'flagged', trip_status:'in_transit', last_lat:-27.8300, last_lon:26.1600, last_speed:0, hours_remaining:3.4, current_zone:'Unknown', active_trip:'TRIP-2199', eta_breach:true },
                        ],
                          summary: { drivers_active:5, drivers_ready:2, drivers_in_transit:2, drivers_flagged:1, loads_queued:4, loads_in_transit:3, loads_delivered_today:7, active_eta_breaches:1 },
                            queue: [
                                { driver_code:'DRV-001', full_name:'Mokoena, K.', fleet_number:'TRK-004', checkin_status:'checked_in', hours_remaining:9.2, current_zone:'Depot A', employment_type:'owner_operator' },
                                    { driver_code:'DRV-002', full_name:'Dlamini, L.', fleet_number:'TRK-011', checkin_status:'checked_in', hours_remaining:7.8, current_zone:'Depot A', employment_type:'owner_operator' },
                                        { driver_code:'DRV-003', full_name:'Pieterse, N.', fleet_number:'TRK-007', checkin_status:'on_load',    hours_remaining:6.1, current_zone:'R14', employment_type:'employee' },
                                            { driver_code:'DRV-004', full_name:'Vermeulen, S.', fleet_number:'TRK-002', checkin_status:'resting',   hours_remaining:2.1, current_zone:'N1 Layby', employment_type:'owner_operator' },
                                                { driver_code:'DRV-005', full_name:'Nkosi, L.',    fleet_number:'TRK-009', checkin_status:'flagged',    hours_remaining:3.4, current_zone:'Unknown', employment_type:'employee' },
                                                  ],
                                                    loads: [
                                                        { load_ref:'LOAD-2201', client_name:'Shoprite DC', origin_zone_name:'Depot A', dest_zone_name:'Client X — Cape Town', priority:'high', load_status:'in_transit', cargo_weight_kg:8500, deliver_by:'2026-04-30T18:00:00', agreed_rate_rand:6200 },
                                                            { load_ref:'LOAD-2204', client_name:'Massmart', origin_zone_name:'Depot A', dest_zone_name:'Client Y — Polokwane', priority:'high', load_status:'queued', cargo_weight_kg:6000, deliver_by:'2026-05-01T10:00:00', agreed_rate_rand:5500 },
                                                                { load_ref:'LOAD-2205', client_name:'Tiger Brands', origin_zone_name:'Depot B', dest_zone_name:'Client Z — East London', priority:'medium', load_status:'queued', cargo_weight_kg:12000, deliver_by:'2026-05-02T12:00:00', agreed_rate_rand:7800 },
                                                                    { load_ref:'LOAD-2206', client_name:'Woolworths', origin_zone_name:'Depot A', dest_zone_name:'Depot C — Durban', priority:'urgent', load_status:'queued', cargo_weight_kg:4200, deliver_by:'2026-04-30T16:00:00', agreed_rate_rand:4900 },
                                                                      ],
                                                                        alerts: [
                                                                            { alert_source:'crosscheck', severity:'critical', alert_type:'eta_compliance', message:'TRK-009 (Nkosi) overdue by 43 min — no geofence arrival', fleet_number:'TRK-009', driver_name:'Nkosi, L.', alert_time: new Date() },
                                                                                { alert_source:'crosscheck', severity:'warning',  alert_type:'fuel_variance',  message:'TRK-007 fuel usage 22% above benchmark on Route B', fleet_number:'TRK-007', driver_name:'Pieterse, N.', alert_time: new Date() },
                                                                                    { alert_source:'signal_loss',severity:'critical', alert_type:'signal_lost',    message:'TRK-009 — signal lost at R14 Km 204', fleet_number:'TRK-009', driver_name:'Nkosi, L.', alert_time: new Date() },
                                                                                      ]
                                                                                      };

                                                                                      const demoOrDb = async (sql, params, demoData) => {
                                                                                        try { const r = await query(sql, params); return r.rows.length ? r.rows : demoData; }
                                                                                          catch(e) { return demoData; }
                                                                                          };

                                                                                          router.get('/fleet',   async (req,res) => { try { const r = await demoOrDb('SELECT * FROM v_live_fleet ORDER BY fleet_number',[],DEMO.fleet); res.json({ok:true,data:r,count:r.length}); } catch(e){ res.json({ok:true,data:DEMO.fleet}); }});
                                                                                          router.get('/summary', async (req,res) => { try { const r = await demoOrDb('SELECT * FROM v_dispatch_summary',[],[DEMO.summary]); res.json({ok:true,data:r[0]||DEMO.summary}); } catch(e){ res.json({ok:true,data:DEMO.summary}); }});
                                                                                          router.get('/queue',   async (req,res) => { try { const r = await demoOrDb('SELECT * FROM v_live_fleet',[],DEMO.queue); res.json({ok:true,data:r}); } catch(e){ res.json({ok:true,data:DEMO.queue}); }});
                                                                                          router.get('/loads',   async (req,res) => { try { const r = await demoOrDb('SELECT l.*,oz.zone_name AS origin_zone_name,dz.zone_name AS dest_zone_name FROM loads l LEFT JOIN zones oz ON l.origin_zone_id=oz.zone_id LEFT JOIN zones dz ON l.dest_zone_id=dz.zone_id ORDER BY l.created_at DESC LIMIT 50',[],DEMO.loads); res.json({ok:true,data:r}); } catch(e){ res.json({ok:true,data:DEMO.loads}); }});
                                                                                          router.get('/alerts',  async (req,res) => { try { const r = await demoOrDb('SELECT * FROM v_active_alerts LIMIT 50',[],DEMO.alerts); res.json({ok:true,data:r,count:r.length}); } catch(e){ res.json({ok:true,data:DEMO.alerts}); }});
                                                                                          router.get('/trips',   async (req,res) => { res.json({ok:true,data:[],message:'Connect database to see trips'}); });

                                                                                          router.post('/checkin', async (req,res) => {
                                                                                            const {driver_id,vehicle_id,hours_available} = req.body;
                                                                                              if (!driver_id||!vehicle_id||!hours_available) return res.status(400).json({error:'driver_id, vehicle_id, hours_available required'});
                                                                                                try {
                                                                                                    await query('INSERT INTO driver_checkins(driver_id,vehicle_id,hours_available,checkin_status) VALUES($1,$2,$3,\'checked_in\')',[driver_id,vehicle_id,hours_available]);
                                                                                                        res.status(201).json({ok:true,message:'Driver checked in'});
                                                                                                          } catch(e){ res.status(201).json({ok:true,message:'Check-in recorded (demo mode)'}); }
                                                                                                          });

                                                                                                          router.post('/loads', async (req,res) => {
                                                                                                            try {
                                                                                                                const {route_id,origin_zone_id,dest_zone_id,client_name,cargo_weight_kg,deliver_by,agreed_rate_rand,priority} = req.body;
                                                                                                                    const n = Math.floor(Math.random()*9000)+2200;
                                                                                                                        await query('INSERT INTO loads(load_ref,route_id,origin_zone_id,dest_zone_id,client_name,cargo_weight_kg,deliver_by,agreed_rate_rand,priority,load_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,\'queued\')',
                                                                                                                              [`LOAD-${n}`,route_id,origin_zone_id,dest_zone_id,client_name,cargo_weight_kg,deliver_by,agreed_rate_rand,priority||'medium']);
                                                                                                                                  res.status(201).json({ok:true,message:`Load LOAD-${n} created`});
                                                                                                                                    } catch(e){ res.status(201).json({ok:true,message:'Load created (demo mode)'}); }
                                                                                                                                    });

                                                                                                                                    router.post('/assign', async (req,res) => {
                                                                                                                                      const {load_id,driver_id,vehicle_id} = req.body;
                                                                                                                                        if (!load_id||!driver_id||!vehicle_id) return res.status(400).json({error:'load_id, driver_id, vehicle_id required'});
                                                                                                                                          try {
                                                                                                                                              await withTransaction(async(client)=>{
                                                                                                                                                    await client.query('UPDATE loads SET assigned_driver_id=$1,assigned_vehicle_id=$2,load_status=\'assigned\',assigned_at=NOW() WHERE load_id=$3',[driver_id,vehicle_id,load_id]);
                                                                                                                                                          await client.query('UPDATE driver_checkins SET checkin_status=\'on_load\' WHERE driver_id=$1 AND shift_date=CURRENT_DATE',[driver_id]);
                                                                                                                                                              });
                                                                                                                                                                  res.json({ok:true,message:'Load assigned'});
                                                                                                                                                                    } catch(e){ res.json({ok:true,message:'Assignment recorded (demo mode)'}); }
                                                                                                                                                                    });

                                                                                                                                                                    module.exports = router;
                                                                                                                                                                    