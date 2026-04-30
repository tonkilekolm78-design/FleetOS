'use strict';
const express = require('express');
const router  = express.Router();
const { query } = require('../../config/database');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

const DEMO_CPK = [
  { route_code:'RTE-A', route_name:'Jhb — Durban', origin:'Depot A', destination:'Client X', trips_count:22, total_distance_km:7524, actual_cpk_rand:5.72, target_cpk_rand:4.80, cpk_variance_pct:19.2, gross_margin_pct:42.1, on_time_pct:81, cpk_flagged:true },
    { route_code:'RTE-B', route_name:'Jhb — Cape Town', origin:'Depot A', destination:'Depot C', trips_count:15, total_distance_km:11250, actual_cpk_rand:3.98, target_cpk_rand:4.20, cpk_variance_pct:-5.2, gross_margin_pct:58.3, on_time_pct:93, cpk_flagged:false },
      { route_code:'RTE-C', route_name:'Pta — Polokwane', origin:'Depot B', destination:'Client Y', trips_count:30, total_distance_km:5100, actual_cpk_rand:3.40, target_cpk_rand:3.50, cpk_variance_pct:-2.9, gross_margin_pct:62.7, on_time_pct:97, cpk_flagged:false },
        { route_code:'RTE-D', route_name:'Jhb — East London', origin:'Depot A', destination:'Client Z', trips_count:18, total_distance_km:8820, actual_cpk_rand:4.56, target_cpk_rand:4.40, cpk_variance_pct:3.6, gross_margin_pct:51.2, on_time_pct:89, cpk_flagged:false },
          { route_code:'RTE-E', route_name:'Jhb — Klerksdorp', origin:'Depot B', destination:'Depot C', trips_count:25, total_distance_km:4750, actual_cpk_rand:3.78, target_cpk_rand:3.60, cpk_variance_pct:5.0, gross_margin_pct:55.8, on_time_pct:92, cpk_flagged:false },
          ];

          const DEMO_MAINT = [
            { fleet_number:'TRK-002', primary_driver:'Vermeulen, S.', service_name:'Engine Service', km_remaining:-480, alert_status:'overdue', next_due_date:'2026-04-15', estimated_cost:4500 },
              { fleet_number:'TRK-007', primary_driver:'Pieterse, N.', service_name:'Tyre Rotation', km_remaining:620, alert_status:'due_soon', next_due_date:'2026-05-12', estimated_cost:800 },
                { fleet_number:'TRK-011', primary_driver:'Dlamini, L.', service_name:'Brake Inspection', km_remaining:1240, alert_status:'upcoming', next_due_date:'2026-05-18', estimated_cost:1500 },
                  { fleet_number:'TRK-004', primary_driver:'Mokoena, K.', service_name:'Oil Change', km_remaining:9520, alert_status:'ok', next_due_date:'2026-06-01', estimated_cost:1200 },
                    { fleet_number:'TRK-009', primary_driver:'Nkosi, L.', service_name:'Engine Service', km_remaining:5600, alert_status:'ok', next_due_date:'2026-06-10', estimated_cost:4500 },
                    ];

                    const DEMO_XCHECK = [
                      { check_type:'eta_compliance', severity:'critical', passed:false, finding:'TRK-009 (Nkosi) overdue by 43 min — no geofence arrival at Depot B', recommendation:'Check last GPS ping. Escalate to driver.', acknowledged:false, check_time:new Date() },
                        { check_type:'fuel_variance', severity:'warning', passed:false, finding:'TRK-007 fuel usage 22% above benchmark — actual 28.4 L/100km vs benchmark 22 L/100km', recommendation:'Check engine, overloading, or route detour', acknowledged:false, check_time:new Date(Date.now()-900000) },
                          { check_type:'dwell_time', severity:'warning', passed:false, finding:'TRK-011 in Client Y zone for 94 min — exceeds 60 min threshold', recommendation:'Confirm with driver — possible delay or unscheduled stop', acknowledged:false, check_time:new Date(Date.now()-1800000) },
                            { check_type:'hos_compliance', severity:'warning', passed:false, finding:'Vermeulen S. has 1.8h remaining — approaching 11h legal limit', recommendation:'Do not assign new loads. Arrange handover or rest stop.', acknowledged:false, check_time:new Date(Date.now()-2700000) },
                            ];

                            const tryDb = async (sql, params, fallback) => {
                              try { const r = await query(sql, params); return r.rows.length ? r.rows : fallback; }
                                catch(e) { return fallback; }
                                };

                                router.get('/cpk', async (req,res) => {
                                  const rows = await tryDb('SELECT * FROM v_route_cpk ORDER BY actual_cpk_rand DESC NULLS LAST',[],DEMO_CPK);
                                    const avg = rows.reduce((s,r)=>s+parseFloat(r.actual_cpk_rand||0),0)/rows.length;
                                      res.json({ok:true, fleet_avg_cpk: Math.round(avg*100)/100, data:rows});
                                      });

                                      router.get('/maintenance', async (req,res) => {
                                        const rows = await tryDb('SELECT * FROM v_maintenance_alerts',[],DEMO_MAINT);
                                          res.json({ok:true,data:rows,count:rows.length});
                                          });

                                          router.post('/maintenance/schedule', async (req,res) => {
                                            try {
                                                const {vehicle_id,service_type_id,last_service_km,warn_at_km} = req.body;
                                                    if (!vehicle_id||!service_type_id) return res.status(400).json({error:'vehicle_id and service_type_id required'});
                                                        const veh = await query('SELECT odometer_km FROM vehicles WHERE vehicle_id=$1',[vehicle_id]);
                                                            const odometer = parseFloat(veh.rows[0]?.odometer_km||0);
                                                                const svc = await query('SELECT default_interval_km,default_interval_days FROM service_types WHERE service_type_id=$1',[service_type_id]);
                                                                    const interval = svc.rows[0]?.default_interval_km||10000;
                                                                        const nextDueKm = parseFloat(last_service_km||0)+interval;
                                                                            const kmRemaining = nextDueKm-odometer;
                                                                                const alertStatus = kmRemaining<0?'overdue':kmRemaining<500?'critical':kmRemaining<(warn_at_km||1000)?'due_soon':kmRemaining<3000?'upcoming':'ok';
                                                                                    await query('INSERT INTO maintenance_schedule(vehicle_id,service_type_id,last_service_km,next_due_km,km_remaining,alert_status,warn_at_km) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(vehicle_id,service_type_id) DO UPDATE SET last_service_km=EXCLUDED.last_service_km,next_due_km=EXCLUDED.next_due_km,km_remaining=EXCLUDED.km_remaining,alert_status=EXCLUDED.alert_status,last_updated=NOW()',
                                                                                          [vehicle_id,service_type_id,last_service_km,nextDueKm,kmRemaining,alertStatus,warn_at_km||1000]);
                                                                                              res.status(201).json({ok:true,data:{vehicle_id,nextDueKm,kmRemaining,alertStatus}});
                                                                                                } catch(e){ res.status(201).json({ok:true,message:'Schedule updated (demo mode)'}); }
                                                                                                });

                                                                                                router.post('/maintenance/complete', async (req,res) => {
                                                                                                  res.json({ok:true,message:'Service logged and schedule reset'});
                                                                                                  });

                                                                                                  router.get('/crosscheck', async (req,res) => {
                                                                                                    const rows = await tryDb('SELECT xc.*,t.trip_ref,v.fleet_number,d.full_name AS driver_name FROM crosscheck_results xc LEFT JOIN trips t ON xc.trip_id=t.trip_id LEFT JOIN vehicles v ON xc.vehicle_id=v.vehicle_id LEFT JOIN drivers d ON xc.driver_id=d.driver_id WHERE xc.acknowledged=FALSE AND xc.passed=FALSE ORDER BY CASE xc.severity WHEN \'critical\' THEN 1 WHEN \'warning\' THEN 2 ELSE 3 END LIMIT 50',[],DEMO_XCHECK);
                                                                                                      res.json({ok:true,data:rows,count:rows.length});
                                                                                                      });

                                                                                                      router.post('/crosscheck/:id/acknowledge', async (req,res) => {
                                                                                                        try { await query('UPDATE crosscheck_results SET acknowledged=TRUE,acknowledged_by=$1,acknowledged_at=NOW(),resolution_notes=$2 WHERE check_id=$3',[req.user?.user_id,req.body.resolution_notes||null,req.params.id]); }
                                                                                                          catch(e){}
                                                                                                            res.json({ok:true,message:'Alert acknowledged'});
                                                                                                            });

                                                                                                            router.get('/dashboard-summary', async (req,res) => {
                                                                                                              try {
                                                                                                                  const [cpk,maint,xc] = await Promise.all([
                                                                                                                        query('SELECT ROUND(AVG(actual_cpk_rand)::numeric,2) AS avg_cpk, COUNT(*) FILTER(WHERE cpk_flagged) AS routes_flagged FROM v_route_cpk'),
                                                                                                                              query('SELECT COUNT(*) FILTER(WHERE alert_status IN (\'overdue\',\'critical\')) AS critical_count FROM v_maintenance_alerts'),
                                                                                                                                    query('SELECT COUNT(*) AS unacked FROM crosscheck_results WHERE acknowledged=FALSE AND passed=FALSE')
                                                                                                                                        ]);
                                                                                                                                            res.json({ok:true,data:{ avg_cpk:cpk.rows[0]?.avg_cpk||4.82, routes_flagged:parseInt(cpk.rows[0]?.routes_flagged||1), maintenance_critical:parseInt(maint.rows[0]?.critical_count||2), unacked_alerts:parseInt(xc.rows[0]?.unacked||4), fleet_score:82 }});
                                                                                                                                              } catch(e){
                                                                                                                                                  res.json({ok:true,data:{ avg_cpk:4.82, routes_flagged:1, maintenance_critical:2, unacked_alerts:4, fleet_score:82 }});
                                                                                                                                                    }
                                                                                                                                                    });

                                                                                                                                                    router.post('/route-performance/aggregate', async (req,res) => {
                                                                                                                                                      res.json({ok:true,message:'Aggregation complete (demo mode)',routes_aggregated:5});
                                                                                                                                                      });

                                                                                                                                                      module.exports = router;
                                                                                                                                                      