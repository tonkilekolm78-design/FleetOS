// ============================================================
//  FleetOS — Management Engine Routes
//  src/api/routes/management.js
//  Handles: CPK analysis, efficiency scores, maintenance
// ============================================================
'use strict';

const express = require('express');
const router  = express.Router();
const { query, withTransaction } = require('../../config/database');
const { authenticate, requireRole } = require('../middleware/auth');
const logger  = require('../../utils/logger');

router.use(authenticate);

// ── GET /api/mgmt/cpk ────────────────────────────────────────
// Cost-per-KM analysis by route for current month
router.get('/cpk', async (req, res) => {
  const { month } = req.query; // e.g. '2026-04'
  try {
    const result = await query(`SELECT * FROM v_route_cpk ORDER BY actual_cpk_rand DESC NULLS LAST`);

    // Compute fleet average CPK for flagging context
    const avgRes = await query(`
      SELECT ROUND(AVG(actual_cpk_rand)::numeric, 2) AS fleet_avg_cpk
      FROM v_route_cpk WHERE actual_cpk_rand IS NOT NULL`
    );

    res.json({
      ok: true,
      fleet_avg_cpk: avgRes.rows[0]?.fleet_avg_cpk,
      data: result.rows
    });
  } catch (err) {
    logger.error('MGMT: CPK error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch CPK data' });
  }
});

// ── GET /api/mgmt/efficiency ─────────────────────────────────
// Fleet efficiency scores — latest per vehicle
router.get('/efficiency', async (req, res) => {
  try {
    const result = await query(`
      SELECT DISTINCT ON (es.vehicle_id)
        es.*,
        v.fleet_number,
        v.registration,
        d.full_name AS driver_name
      FROM efficiency_scores es
      JOIN vehicles v ON es.vehicle_id = v.vehicle_id
      LEFT JOIN drivers d ON es.driver_id = d.driver_id
      ORDER BY es.vehicle_id, es.score_date DESC`
    );

    // Fleet composite score
    const fleetScore = result.rows.length
      ? Math.round(result.rows.reduce((sum, r) => sum + parseFloat(r.overall_score || 0), 0) / result.rows.length)
      : null;

    res.json({ ok: true, fleet_score: fleetScore, data: result.rows });
  } catch (err) {
    logger.error('MGMT: efficiency error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch efficiency scores' });
  }
});

// ── GET /api/mgmt/maintenance ────────────────────────────────
// Maintenance alerts — ordered by severity
router.get('/maintenance', async (req, res) => {
  const { status } = req.query;
  try {
    let sql = `SELECT * FROM v_maintenance_alerts`;
    const params = [];
    if (status) { params.push(status); sql += ` WHERE alert_status = $1`; }
    sql += ` ORDER BY
      CASE alert_status
        WHEN 'critical' THEN 1 WHEN 'overdue' THEN 2
        WHEN 'due_soon' THEN 3 WHEN 'upcoming' THEN 4
        ELSE 5 END`;

    const result = await query(sql, params);
    res.json({ ok: true, data: result.rows, count: result.rows.length });
  } catch (err) {
    logger.error('MGMT: maintenance error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch maintenance data' });
  }
});

// ── POST /api/mgmt/maintenance/schedule ─────────────────────
// Add or update a maintenance schedule entry for a vehicle
router.post('/maintenance/schedule', requireRole('manager','superadmin'), async (req, res) => {
  const {
    vehicle_id, service_type_id,
    last_service_date, last_service_km,
    warn_at_km, warn_at_days,
    booked_date, booked_workshop, estimated_cost
  } = req.body;

  if (!vehicle_id || !service_type_id) {
    return res.status(400).json({ error: 'vehicle_id and service_type_id are required' });
  }

  try {
    // Fetch service interval defaults
    const svcRes = await query(
      `SELECT default_interval_km, default_interval_days FROM service_types WHERE service_type_id = $1`,
      [service_type_id]
    );
    const svc = svcRes.rows[0] || {};

    // Get current odometer
    const vehRes = await query(
      `SELECT odometer_km FROM vehicles WHERE vehicle_id = $1`, [vehicle_id]
    );
    const odometer = parseFloat(vehRes.rows[0]?.odometer_km || 0);
    const lastKm   = parseFloat(last_service_km || 0);
    const interval = svc.default_interval_km || 10000;
    const nextDueKm = lastKm + interval;
    const kmRemaining = nextDueKm - odometer;

    // Calculate next due date
    let nextDueDate = null;
    if (last_service_date && svc.default_interval_days) {
      const d = new Date(last_service_date);
      d.setDate(d.getDate() + svc.default_interval_days);
      nextDueDate = d.toISOString().split('T')[0];
    }

    // Determine alert status
    const daysRemaining = nextDueDate
      ? Math.floor((new Date(nextDueDate) - new Date()) / 86400000)
      : null;

    let alertStatus = 'ok';
    if (kmRemaining < 0 || (daysRemaining !== null && daysRemaining < 0)) alertStatus = 'overdue';
    else if (kmRemaining < 500 || (daysRemaining !== null && daysRemaining < 7)) alertStatus = 'critical';
    else if (kmRemaining < (warn_at_km || 1000) || (daysRemaining !== null && daysRemaining < (warn_at_days || 14))) alertStatus = 'due_soon';
    else if (kmRemaining < 3000) alertStatus = 'upcoming';

    const result = await query(`
      INSERT INTO maintenance_schedule
        (vehicle_id, service_type_id, last_service_date, last_service_km,
         next_due_km, next_due_date, km_remaining, days_remaining,
         alert_status, warn_at_km, warn_at_days, booked_date, booked_workshop, estimated_cost)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (vehicle_id, service_type_id) DO UPDATE SET
        last_service_date = EXCLUDED.last_service_date,
        last_service_km   = EXCLUDED.last_service_km,
        next_due_km       = EXCLUDED.next_due_km,
        next_due_date     = EXCLUDED.next_due_date,
        km_remaining      = EXCLUDED.km_remaining,
        days_remaining    = EXCLUDED.days_remaining,
        alert_status      = EXCLUDED.alert_status,
        booked_date       = EXCLUDED.booked_date,
        booked_workshop   = EXCLUDED.booked_workshop,
        estimated_cost    = EXCLUDED.estimated_cost,
        last_updated      = NOW()
      RETURNING *`,
      [vehicle_id, service_type_id, last_service_date, last_service_km,
       nextDueKm, nextDueDate, kmRemaining, daysRemaining,
       alertStatus, warn_at_km || 1000, warn_at_days || 14,
       booked_date || null, booked_workshop || null, estimated_cost || null]
    );

    logger.info('MGMT: maintenance schedule updated', { vehicle_id, alertStatus });
    res.status(201).json({ ok: true, data: result.rows[0] });
  } catch (err) {
    logger.error('MGMT: maintenance schedule error', { error: err.message });
    res.status(500).json({ error: 'Failed to update maintenance schedule' });
  }
});

// ── POST /api/mgmt/maintenance/complete ─────────────────────
// Log a completed service and reset the schedule
router.post('/maintenance/complete', requireRole('manager','superadmin'), async (req, res) => {
  const {
    vehicle_id, service_type_id, service_date,
    odometer_at_service, workshop_name, invoice_number,
    actual_cost_rand, work_description, parts_replaced
  } = req.body;

  if (!vehicle_id || !service_type_id || !service_date || !odometer_at_service) {
    return res.status(400).json({ error: 'vehicle_id, service_type_id, service_date, odometer_at_service required' });
  }

  try {
    await withTransaction(async (client) => {
      // Get service interval
      const svcRes = await client.query(
        `SELECT default_interval_km, default_interval_days FROM service_types WHERE service_type_id = $1`,
        [service_type_id]
      );
      const svc = svcRes.rows[0] || {};

      const nextKm = parseFloat(odometer_at_service) + (svc.default_interval_km || 10000);
      const nextDate = new Date(service_date);
      nextDate.setDate(nextDate.getDate() + (svc.default_interval_days || 90));

      // Log to history
      const histRes = await client.query(`
        INSERT INTO maintenance_history
          (vehicle_id, service_type_id, service_date, odometer_at_service,
           workshop_name, invoice_number, actual_cost_rand,
           work_description, parts_replaced,
           next_service_km, next_service_date, authorised_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        RETURNING history_id`,
        [vehicle_id, service_type_id, service_date, odometer_at_service,
         workshop_name, invoice_number, actual_cost_rand,
         work_description, parts_replaced,
         nextKm, nextDate.toISOString().split('T')[0], req.user.user_id]
      );

      // Reset schedule for next interval
      await client.query(`
        UPDATE maintenance_schedule SET
          last_service_date = $1,
          last_service_km   = $2,
          next_due_km       = $3,
          next_due_date     = $4,
          km_remaining      = $3 - (SELECT odometer_km FROM vehicles WHERE vehicle_id = $5),
          alert_status      = 'ok',
          booked_date       = NULL,
          booked_workshop   = NULL,
          last_updated      = NOW()
        WHERE vehicle_id = $5 AND service_type_id = $6`,
        [service_date, odometer_at_service, nextKm,
         nextDate.toISOString().split('T')[0],
         vehicle_id, service_type_id]
      );

      // Audit log
      await client.query(`
        INSERT INTO audit_log
          (event_source, event_type, entity_type, entity_id, description, vehicle_id, triggered_by_user)
        VALUES ('system','SERVICE_COMPLETED','vehicle',$1,$2,$3,$4)`,
        [vehicle_id,
         `Service completed — ${workshop_name || 'workshop'} — next due at ${nextKm.toLocaleString()} km`,
         vehicle_id, req.user.user_id]
      );
    });

    logger.info('MGMT: service completed', { vehicle_id, service_type_id });
    res.json({ ok: true, message: 'Service logged and schedule reset' });
  } catch (err) {
    logger.error('MGMT: complete service error', { error: err.message });
    res.status(500).json({ error: 'Failed to log service completion' });
  }
});

// ── GET /api/mgmt/crosscheck ─────────────────────────────────
// All unresolved cross-check findings
router.get('/crosscheck', async (req, res) => {
  const { severity, check_type, acknowledged } = req.query;
  try {
    const params = [];
    let sql = `
      SELECT
        xc.*,
        t.trip_ref,
        v.fleet_number,
        d.full_name AS driver_name,
        r.route_name
      FROM crosscheck_results xc
      LEFT JOIN trips t    ON xc.trip_id   = t.trip_id
      LEFT JOIN vehicles v ON xc.vehicle_id = v.vehicle_id
      LEFT JOIN drivers d  ON xc.driver_id  = d.driver_id
      LEFT JOIN routes r   ON xc.route_id   = r.route_id
      WHERE 1=1`;

    if (severity)     { params.push(severity);            sql += ` AND xc.severity = $${params.length}`; }
    if (check_type)   { params.push(check_type);          sql += ` AND xc.check_type = $${params.length}`; }
    if (acknowledged !== undefined) {
      params.push(acknowledged === 'true');
      sql += ` AND xc.acknowledged = $${params.length}`;
    } else {
      sql += ` AND xc.acknowledged = FALSE`;
    }
    sql += ` ORDER BY
      CASE xc.severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
      xc.check_time DESC LIMIT 200`;

    const result = await query(sql, params);
    res.json({ ok: true, data: result.rows, count: result.rows.length });
  } catch (err) {
    logger.error('MGMT: crosscheck error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch cross-check results' });
  }
});

// ── POST /api/mgmt/crosscheck/:check_id/acknowledge ─────────
router.post('/crosscheck/:check_id/acknowledge', async (req, res) => {
  const { resolution_notes } = req.body;
  try {
    await query(`
      UPDATE crosscheck_results SET
        acknowledged     = TRUE,
        acknowledged_by  = $1,
        acknowledged_at  = NOW(),
        resolution_notes = $2
      WHERE check_id = $3`,
      [req.user.user_id, resolution_notes || null, req.params.check_id]
    );
    res.json({ ok: true, message: 'Alert acknowledged' });
  } catch (err) {
    res.status(500).json({ error: 'Acknowledge failed' });
  }
});

// ── POST /api/mgmt/route-performance/aggregate ───────────────
// Trigger monthly route performance aggregation (called by cron)
router.post('/route-performance/aggregate', requireRole('manager','superadmin'), async (req, res) => {
  const { period_start, period_end } = req.body;
  if (!period_start || !period_end) {
    return res.status(400).json({ error: 'period_start and period_end required (YYYY-MM-DD)' });
  }

  try {
    const result = await query(`
      INSERT INTO route_performance
        (route_id, period_start, period_end,
         trips_count, total_distance_km,
         total_revenue_rand, total_fuel_rand, total_toll_rand, total_cost_rand,
         actual_cpk_rand, target_cpk_rand, cpk_variance_pct, gross_margin_pct,
         on_time_pct, cpk_flagged)
      SELECT
        t.route_id,
        $1::DATE,
        $2::DATE,
        COUNT(t.trip_id)                                     AS trips_count,
        COALESCE(SUM(t.actual_distance_km), 0)               AS total_distance_km,
        COALESCE(SUM(tc.gross_revenue_rand), 0)              AS total_revenue_rand,
        COALESCE(SUM(tc.fuel_cost_rand), 0)                  AS total_fuel_rand,
        COALESCE(SUM(tc.toll_cost_rand), 0)                  AS total_toll_rand,
        COALESCE(SUM(tc.total_cost_rand), 0)                 AS total_cost_rand,
        CASE WHEN SUM(t.actual_distance_km) > 0
          THEN ROUND((SUM(tc.total_cost_rand) / SUM(t.actual_distance_km))::numeric, 2)
          ELSE NULL END                                       AS actual_cpk_rand,
        r.target_cpk_rand,
        CASE WHEN r.target_cpk_rand > 0
          THEN ROUND(((SUM(tc.total_cost_rand)/NULLIF(SUM(t.actual_distance_km),0)
               - r.target_cpk_rand) / r.target_cpk_rand * 100)::numeric, 2)
          ELSE NULL END                                       AS cpk_variance_pct,
        CASE WHEN SUM(tc.gross_revenue_rand) > 0
          THEN ROUND(((SUM(tc.gross_revenue_rand) - SUM(tc.total_cost_rand))
               / SUM(tc.gross_revenue_rand) * 100)::numeric, 2)
          ELSE NULL END                                       AS gross_margin_pct,
        ROUND((COUNT(*) FILTER (WHERE t.eta_breach = FALSE)::numeric
               / NULLIF(COUNT(*), 0) * 100), 1)              AS on_time_pct,
        CASE WHEN r.target_cpk_rand > 0
               AND (SUM(tc.total_cost_rand)/NULLIF(SUM(t.actual_distance_km),0))
                   > r.target_cpk_rand * (1 + r.cpk_alert_threshold / 100)
          THEN TRUE ELSE FALSE END                            AS cpk_flagged
      FROM trips t
      JOIN routes r    ON t.route_id   = r.route_id
      LEFT JOIN trip_costs tc ON tc.trip_id = t.trip_id
      WHERE t.trip_status = 'completed'
        AND t.arrived_at BETWEEN $1 AND ($2::DATE + INTERVAL '1 day')
        AND t.route_id IS NOT NULL
      GROUP BY t.route_id, r.target_cpk_rand, r.cpk_alert_threshold
      ON CONFLICT (route_id, period_start) DO UPDATE SET
        trips_count        = EXCLUDED.trips_count,
        total_distance_km  = EXCLUDED.total_distance_km,
        total_revenue_rand = EXCLUDED.total_revenue_rand,
        total_fuel_rand    = EXCLUDED.total_fuel_rand,
        total_toll_rand    = EXCLUDED.total_toll_rand,
        total_cost_rand    = EXCLUDED.total_cost_rand,
        actual_cpk_rand    = EXCLUDED.actual_cpk_rand,
        cpk_variance_pct   = EXCLUDED.cpk_variance_pct,
        gross_margin_pct   = EXCLUDED.gross_margin_pct,
        on_time_pct        = EXCLUDED.on_time_pct,
        cpk_flagged        = EXCLUDED.cpk_flagged,
        calculated_at      = NOW()
      RETURNING route_id`,
      [period_start, period_end]
    );

    logger.info('MGMT: route performance aggregated', { routes: result.rows.length, period_start });
    res.json({ ok: true, routes_aggregated: result.rows.length });
  } catch (err) {
    logger.error('MGMT: aggregation error', { error: err.message });
    res.status(500).json({ error: 'Route performance aggregation failed' });
  }
});

// ── GET /api/mgmt/dashboard-summary ─────────────────────────
// Single endpoint for Management dashboard KPI strip
router.get('/dashboard-summary', async (req, res) => {
  try {
    const [cpkRes, maintRes, xcheckRes, scoreRes] = await Promise.all([
      query(`SELECT ROUND(AVG(actual_cpk_rand)::numeric,2) AS avg_cpk,
                    COUNT(*) FILTER (WHERE cpk_flagged) AS routes_flagged
             FROM v_route_cpk`),
      query(`SELECT COUNT(*) FILTER (WHERE alert_status IN ('overdue','critical')) AS critical_count,
                    COUNT(*) FILTER (WHERE alert_status = 'due_soon') AS due_soon_count
             FROM v_maintenance_alerts`),
      query(`SELECT COUNT(*) AS unacked_alerts
             FROM crosscheck_results WHERE acknowledged = FALSE AND passed = FALSE`),
      query(`SELECT ROUND(AVG(overall_score)::numeric,1) AS fleet_score
             FROM efficiency_scores WHERE score_date = CURRENT_DATE`)
    ]);

    res.json({
      ok: true,
      data: {
        avg_cpk              : cpkRes.rows[0]?.avg_cpk,
        routes_flagged       : parseInt(cpkRes.rows[0]?.routes_flagged || 0),
        maintenance_critical : parseInt(maintRes.rows[0]?.critical_count || 0),
        maintenance_due_soon : parseInt(maintRes.rows[0]?.due_soon_count || 0),
        unacked_alerts       : parseInt(xcheckRes.rows[0]?.unacked_alerts || 0),
        fleet_score          : scoreRes.rows[0]?.fleet_score
      }
    });
  } catch (err) {
    logger.error('MGMT: dashboard summary error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch management summary' });
  }
});

module.exports = router;
