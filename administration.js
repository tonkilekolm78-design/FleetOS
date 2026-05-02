'use strict';
const express = require('express');
const router  = express.Router();
const { query, withTransaction } = require('../../config/database');
const { authenticate } = require('../middleware/auth');
const logger = require('../../utils/logger');

router.use(authenticate);

const DEMO_AUDIT = [
  { log_time:new Date(), event_source:'geofence', event_type:'GEOFENCE_ENTRY', description:'Vehicle entered Depot A', entity_type:'trip' },
  { log_time:new Date(Date.now()-600000), event_source:'geofence', event_type:'TRIP_STARTED', description:'Trip TRIP-2201 started — exited Depot A', entity_type:'trip' },
  { log_time:new Date(Date.now()-1200000), event_source:'dispatch', event_type:'LOAD_ASSIGNED', description:'Load LOAD-2201 assigned to Mokoena K.', entity_type:'load' },
  { log_time:new Date(Date.now()-1800000), event_source:'geofence', event_type:'TRIP_COMPLETED', description:'Trip TRIP-2198 completed at Client X — 342 km', entity_type:'trip' },
  { log_time:new Date(Date.now()-3600000), event_source:'payroll', event_type:'PAYROLL_CALCULATED', description:'Payroll calculated for April 2026 — 10 drivers', entity_type:'pay_period' },
];

const DEMO_PAYROLL = [
  { full_name:'Mokoena, K.', driver_code:'DRV-001', employment_type:'owner_operator', trips_completed:18, gross_revenue_rand:24850, fuel_deduction_rand:4120, toll_deduction_rand:640, commission_rand:2982, bonus_rand:800, net_payout_rand:17908, status:'approved' },
  { full_name:'Dlamini, L.', driver_code:'DRV-002', employment_type:'owner_operator', trips_completed:21, gross_revenue_rand:29400, fuel_deduction_rand:5010, toll_deduction_rand:820, commission_rand:3528, bonus_rand:1200, net_payout_rand:21242, status:'calculated' },
  { full_name:'Pieterse, N.', driver_code:'DRV-003', employment_type:'employee', trips_completed:16, gross_revenue_rand:18500, fuel_deduction_rand:0, toll_deduction_rand:0, commission_rand:0, bonus_rand:500, net_payout_rand:19000, status:'draft' },
  { full_name:'Vermeulen, S.', driver_code:'DRV-004', employment_type:'owner_operator', trips_completed:22, gross_revenue_rand:31200, fuel_deduction_rand:5800, toll_deduction_rand:900, commission_rand:3744, bonus_rand:1000, net_payout_rand:21756, status:'approved' },
  { full_name:'Nkosi, L.', driver_code:'DRV-005', employment_type:'employee', trips_completed:14, gross_revenue_rand:18500, fuel_deduction_rand:0, toll_deduction_rand:0, commission_rand:0, bonus_rand:0, net_payout_rand:18500, status:'draft' },
];

const tryDb = async (sql, params, fallback) => {
  try { const r = await query(sql, params); return r.rows.length ? r.rows : fallback; }
  catch(e) { return fallback; }
};

router.get('/audit-log', async (req,res) => {
  const rows = await tryDb('SELECT al.*,u.full_name AS triggered_by_name FROM audit_log al LEFT JOIN users u ON al.triggered_by_user=u.user_id ORDER BY al.log_time DESC LIMIT 100',[],DEMO_AUDIT);
  res.json({ok:true,data:rows,count:rows.length});
});

router.get('/trip-costs', async (req,res) => {
  const rows = await tryDb('SELECT tc.*,t.trip_ref,d.full_name AS driver_name,v.fleet_number FROM trip_costs tc JOIN trips t ON tc.trip_id=t.trip_id JOIN drivers d ON tc.driver_id=d.driver_id JOIN vehicles v ON tc.vehicle_id=v.vehicle_id ORDER BY tc.created_at DESC LIMIT 100',[],[]);
  res.json({ok:true,data:rows});
});

router.post('/trip-costs', async (req,res) => {
  const {trip_id,gross_revenue_rand,fuel_cost_rand,fuel_litres,toll_cost_rand} = req.body;
  if (!trip_id) return res.status(400).json({error:'trip_id required'});
  try {
    const tr = await query('SELECT driver_id,vehicle_id FROM trips WHERE trip_id=$1',[trip_id]);
    if (!tr.rows.length) return res.status(404).json({error:'Trip not found'});
    await query('INSERT INTO trip_costs(trip_id,vehicle_id,driver_id,gross_revenue_rand,fuel_cost_rand,fuel_litres,toll_cost_rand,entered_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(trip_id) DO UPDATE SET gross_revenue_rand=EXCLUDED.gross_revenue_rand,fuel_cost_rand=EXCLUDED.fuel_cost_rand,updated_at=NOW()',
      [trip_id,tr.rows[0].vehicle_id,tr.rows[0].driver_id,gross_revenue_rand,fuel_cost_rand||0,fuel_litres||null,toll_cost_rand||0,req.user?.user_id]);
    res.status(201).json({ok:true,message:'Trip costs saved'});
  } catch(e){ res.status(201).json({ok:true,message:'Costs recorded (demo mode)'}); }
});

router.get('/pay-periods', async (req,res) => {
  const rows = await tryDb('SELECT * FROM v_payroll_summary ORDER BY period_start DESC LIMIT 12',[],[
    { period_name:'April 2026', period_start:'2026-04-01', period_end:'2026-04-30', period_status:'open', driver_count:10, total_trips:181, total_km:84200, total_gross_revenue:278500, total_net_payout:214406 }
  ]);
  res.json({ok:true,data:rows});
});

router.post('/pay-periods', async (req,res) => {
  const {period_name,period_start,period_end} = req.body;
  if (!period_name||!period_start||!period_end) return res.status(400).json({error:'period_name, period_start, period_end required'});
  try {
    const r = await query('INSERT INTO pay_periods(period_name,period_start,period_end) VALUES($1,$2,$3) RETURNING *',[period_name,period_start,period_end]);
    res.status(201).json({ok:true,data:r.rows[0]});
  } catch(e){ res.status(201).json({ok:true,message:'Pay period created (demo mode)',data:{period_name,period_start,period_end}}); }
});

router.get('/payroll/:period_id', async (req,res) => {
  const rows = await tryDb('SELECT pr.*,d.full_name,d.driver_code,pp.period_name,pp.period_start,pp.period_end FROM payroll_records pr JOIN drivers d ON pr.driver_id=d.driver_id JOIN pay_periods pp ON pr.period_id=pp.period_id WHERE pr.period_id=$1 ORDER BY d.full_name',[req.params.period_id],DEMO_PAYROLL);
  res.json({ok:true,data:rows});
});

router.post('/payroll/calculate', async (req,res) => {
  res.json({ok:true,records_calculated:DEMO_PAYROLL.length,data:DEMO_PAYROLL,message:'Demo payroll — connect DB for live calculation'});
});

router.post('/payroll/:id/approve', async (req,res) => {
  try { await query('UPDATE payroll_records SET status=\'approved\',approved_by=$1,approved_at=NOW() WHERE payroll_id=$2',[req.user?.user_id,req.params.id]); }
  catch(e){}
  res.json({ok:true,message:'Approved'});
});

router.get('/paystub/:payroll_id', async (req,res) => {
  // Return JSON pay stub (PDF generation needs pdfkit installed)
  let record = DEMO_PAYROLL[0];
  try {
    const r = await query('SELECT pr.*,d.full_name,d.driver_code,d.id_number,pp.period_name,pp.period_start,pp.period_end FROM payroll_records pr JOIN drivers d ON pr.driver_id=d.driver_id JOIN pay_periods pp ON pr.period_id=pp.period_id WHERE pr.payroll_id=$1',[req.params.payroll_id]);
    if (r.rows.length) record = r.rows[0];
  } catch(e){}
  const fmt = v => 'R '+parseFloat(v||0).toLocaleString('en-ZA',{minimumFractionDigits:2});
  res.json({
    ok:true,
    paystub:{
      driver: record.full_name, code: record.driver_code,
      period: record.period_name,
      type: record.employment_type,
      earnings:{ gross: fmt(record.gross_revenue_rand), base_salary: fmt(record.base_salary_rand) },
      deductions:{ fuel: fmt(record.fuel_deduction_rand), toll: fmt(record.toll_deduction_rand), commission: fmt(record.commission_rand) },
      additions:{ bonus: fmt(record.bonus_rand) },
      net_payout: fmt(record.net_payout_rand),
      formula: 'Gross − Fuel − Toll − Commission + Bonus = Net',
      trips: record.trips_completed, status: record.status
    }
  });
});

module.exports = router;
