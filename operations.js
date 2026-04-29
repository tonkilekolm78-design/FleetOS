// ============================================================
//  FleetOS — Operations Engine Routes
//  src/api/routes/operations.js
//  Handles: live fleet, dispatch, check-ins, loads, queue
// ============================================================
'use strict';

const express  = require('express');
const router   = express.Router();
const { query, withTransaction } = require('../../config/database');
const { authenticate, requireRole } = require('../middleware/auth');
const logger   = require('../../utils/logger');

// All operations routes require authentication
router.use(authenticate);

// ── GET /api/ops/fleet ───────────────────────────────────────
// Live fleet status for dashboard map
router.get('/fleet', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM v_live_fleet ORDER BY fleet_number`);
    res.json({ ok: true, data: result.rows, count: result.rows.length });
  } catch (err) {
    logger.error('OPS: fleet status error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch fleet status' });
  }
});

// ── GET /api/ops/summary ─────────────────────────────────────
// KPI strip numbers for top of Operations dashboard
router.get('/summary', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM v_dispatch_summary`);
    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch dispatch summary' });
  }
});

// ── GET /api/ops/queue ───────────────────────────────────────
// Driver queue — available drivers ordered by priority
router.get('/queue', async (req, res) => {
  try {
    const result = await query(`
      SELECT
        dc.checkin_id,
        dc.checkin_status,
        dc.hours_available - dc.hours_driven AS hours_remaining,
        d.driver_id,
        d.driver_code,
        d.full_name,
        d.employment_type,
        d.phone_primary,
        v.vehicle_id,
        v.fleet_number,
        v.registration,
        vt.type_name AS vehicle_type,
        z.zone_name AS current_zone,
        -- Distance from last ping to depot (for smart matching)
        gp.latitude  AS last_lat,
        gp.longitude AS last_lon,
        gp.speed_kmh,
        gp.device_timestamp AS last_seen
      FROM driver_checkins dc
      JOIN drivers d  ON dc.driver_id  = d.driver_id
      JOIN vehicles v ON dc.vehicle_id = v.vehicle_id
      LEFT JOIN vehicle_types vt ON v.type_id = vt.type_id
      LEFT JOIN zones z ON dc.starting_zone_id = z.zone_id
      LEFT JOIN LATERAL (
        SELECT latitude, longitude, speed_kmh, device_timestamp
        FROM gps_pings
        WHERE vehicle_id = dc.vehicle_id
        ORDER BY device_timestamp DESC LIMIT 1
      ) gp ON TRUE
      WHERE dc.shift_date = CURRENT_DATE
        AND dc.checkin_status NOT IN ('checked_out')
      ORDER BY
        CASE dc.checkin_status
          WHEN 'checked_in' THEN 1
          WHEN 'resting'    THEN 2
          WHEN 'on_load'    THEN 3
          WHEN 'flagged'    THEN 4
          ELSE 5
        END,
        dc.hours_available - dc.hours_driven DESC
    `);
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    logger.error('OPS: queue fetch error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch driver queue' });
  }
});

// ── POST /api/ops/checkin ────────────────────────────────────
// Driver checks in at start of shift
router.post('/checkin', async (req, res) => {
  const { driver_id, vehicle_id, hours_available, starting_zone_id, odometer_start_km } = req.body;

  if (!driver_id || !vehicle_id || !hours_available) {
    return res.status(400).json({ error: 'driver_id, vehicle_id, hours_available are required' });
  }

  try {
    // Check no existing open checkin for this driver today
    const existing = await query(
      `SELECT checkin_id FROM driver_checkins
       WHERE driver_id = $1 AND shift_date = CURRENT_DATE
         AND checkin_status NOT IN ('checked_out')`,
      [driver_id]
    );
    if (existing.rows.length) {
      return res.status(409).json({ error: 'Driver already checked in today' });
    }

    const result = await query(`
      INSERT INTO driver_checkins
        (driver_id, vehicle_id, hours_available, starting_zone_id, odometer_start_km, checkin_status)
      VALUES ($1, $2, $3, $4, $5, 'checked_in')
      RETURNING *`,
      [driver_id, vehicle_id, hours_available, starting_zone_id || null, odometer_start_km || null]
    );

    // Audit log
    await query(`
      INSERT INTO audit_log (event_source, event_type, entity_type, entity_id, description, driver_id, triggered_by_user)
      VALUES ('dispatch', 'DRIVER_CHECKIN', 'checkin', $1, $2, $3, $4)`,
      [result.rows[0].checkin_id,
       `Driver checked in — vehicle ${vehicle_id}`,
       driver_id, req.user.user_id]
    );

    logger.info('OPS: driver checked in', { driver_id, vehicle_id });
    res.status(201).json({ ok: true, data: result.rows[0] });
  } catch (err) {
    logger.error('OPS: checkin error', { error: err.message });
    res.status(500).json({ error: 'Check-in failed' });
  }
});

// ── GET /api/ops/loads ───────────────────────────────────────
// Load queue — unassigned and active loads
router.get('/loads', async (req, res) => {
  const { status, priority } = req.query;
  try {
    let sql = `
      SELECT
        l.*,
        oz.zone_name AS origin_zone_name,
        dz.zone_name AS dest_zone_name,
        r.route_name,
        r.expected_duration_hrs,
        d.full_name AS driver_name,
        v.fleet_number
      FROM loads l
      LEFT JOIN zones oz ON l.origin_zone_id = oz.zone_id
      LEFT JOIN zones dz ON l.dest_zone_id   = dz.zone_id
      LEFT JOIN routes r ON l.route_id = r.route_id
      LEFT JOIN drivers d  ON l.assigned_driver_id  = d.driver_id
      LEFT JOIN vehicles v ON l.assigned_vehicle_id = v.vehicle_id
      WHERE 1=1`;
    const params = [];
    if (status) {
      params.push(status);
      sql += ` AND l.load_status = $${params.length}`;
    }
    if (priority) {
      params.push(priority);
      sql += ` AND l.priority = $${params.length}`;
    }
    sql += ` ORDER BY
      CASE l.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
      l.deliver_by ASC NULLS LAST`;

    const result = await query(sql, params);
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    logger.error('OPS: loads fetch error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch loads' });
  }
});

// ── POST /api/ops/loads ──────────────────────────────────────
// Create a new load / job
router.post('/loads', requireRole('dispatcher','manager','superadmin'), async (req, res) => {
  const {
    route_id, origin_zone_id, dest_zone_id,
    client_name, client_ref, cargo_description,
    cargo_weight_kg, ready_at, collect_by, deliver_by,
    agreed_rate_rand, priority
  } = req.body;

  try {
    // Generate load reference
    const countResult = await query(`SELECT COUNT(*) FROM loads`);
    const loadRef = `LOAD-${2200 + parseInt(countResult.rows[0].count) + 1}`;

    const result = await query(`
      INSERT INTO loads
        (load_ref, route_id, origin_zone_id, dest_zone_id, client_name, client_ref,
         cargo_description, cargo_weight_kg, ready_at, collect_by, deliver_by,
         agreed_rate_rand, priority, load_status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'queued')
      RETURNING *`,
      [loadRef, route_id, origin_zone_id, dest_zone_id, client_name, client_ref,
       cargo_description, cargo_weight_kg, ready_at, collect_by, deliver_by,
       agreed_rate_rand, priority || 'medium']
    );

    logger.info('OPS: load created', { load_ref: loadRef });
    res.status(201).json({ ok: true, data: result.rows[0] });
  } catch (err) {
    logger.error('OPS: create load error', { error: err.message });
    res.status(500).json({ error: 'Failed to create load' });
  }
});

// ── POST /api/ops/assign ─────────────────────────────────────
// Assign a load to a driver (manual or auto-suggest)
router.post('/assign', requireRole('dispatcher','manager','superadmin'), async (req, res) => {
  const { load_id, driver_id, vehicle_id } = req.body;
  if (!load_id || !driver_id || !vehicle_id) {
    return res.status(400).json({ error: 'load_id, driver_id, vehicle_id required' });
  }

  try {
    await withTransaction(async (client) => {
      // Update load
      await client.query(`
        UPDATE loads SET
          assigned_driver_id = $1, assigned_vehicle_id = $2,
          load_status = 'assigned', assigned_at = NOW(), assigned_by = $3
        WHERE load_id = $4`,
        [driver_id, vehicle_id, req.user.user_id, load_id]
      );

      // Update driver status
      await client.query(`
        UPDATE driver_checkins SET checkin_status = 'on_load'
        WHERE driver_id = $1 AND shift_date = CURRENT_DATE
          AND checkin_status = 'checked_in'`,
        [driver_id]
      );

      // Generate trip reference and create trip record
      const countRes = await client.query(`SELECT COUNT(*) FROM trips`);
      const tripRef = `TRIP-${2200 + parseInt(countRes.rows[0].count) + 1}`;

      const loadRes = await client.query(
        `SELECT * FROM loads WHERE load_id = $1`, [load_id]
      );
      const load = loadRes.rows[0];

      await client.query(`
        INSERT INTO trips
          (trip_ref, load_id, driver_id, vehicle_id, route_id,
           origin_zone_id, dest_zone_id, expected_depart, expected_arrive,
           planned_distance_km, trip_status)
        SELECT $1, $2, $3, $4, l.route_id,
               l.origin_zone_id, l.dest_zone_id, l.collect_by, l.deliver_by,
               r.expected_distance_km, 'pending'
        FROM loads l
        LEFT JOIN routes r ON l.route_id = r.route_id
        WHERE l.load_id = $2`,
        [tripRef, load_id, driver_id, vehicle_id]
      );

      // Audit
      await client.query(`
        INSERT INTO audit_log
          (event_source, event_type, entity_type, entity_id, description, driver_id, vehicle_id, triggered_by_user)
        VALUES ('dispatch','LOAD_ASSIGNED','load',$1,$2,$3,$4,$5)`,
        [load_id,
         `Load ${load.load_ref} assigned to driver — trip ${tripRef} created`,
         driver_id, vehicle_id, req.user.user_id]
      );
    });

    logger.info('OPS: load assigned', { load_id, driver_id });
    res.json({ ok: true, message: 'Load assigned and trip created' });
  } catch (err) {
    logger.error('OPS: assign error', { error: err.message });
    res.status(500).json({ error: 'Assignment failed' });
  }
});

// ── GET /api/ops/auto-match/:load_id ────────────────────────
// Smart driver matching — suggests best driver for a load
router.get('/auto-match/:load_id', async (req, res) => {
  try {
    const loadResult = await query(
      `SELECT l.*, oz.latitude AS orig_lat, oz.longitude AS orig_lon,
              r.expected_duration_hrs
       FROM loads l
       JOIN zones oz ON l.origin_zone_id = oz.zone_id
       LEFT JOIN routes r ON l.route_id = r.route_id
       WHERE l.load_id = $1`,
      [req.params.load_id]
    );
    if (!loadResult.rows.length) {
      return res.status(404).json({ error: 'Load not found' });
    }
    const load = loadResult.rows[0];

    // Find available drivers with enough hours remaining
    // and rank by distance to origin zone
    const driversResult = await query(`
      SELECT
        dc.checkin_id,
        d.driver_id,
        d.full_name,
        d.driver_code,
        v.vehicle_id,
        v.fleet_number,
        vt.max_payload_kg,
        dc.hours_available - dc.hours_driven AS hours_remaining,
        gp.latitude AS last_lat,
        gp.longitude AS last_lon,
        -- Straight-line distance to load origin (km)
        ROUND(
          earth_distance(
            ll_to_earth(gp.latitude, gp.longitude),
            ll_to_earth($1, $2)
          ) / 1000
        , 1) AS distance_to_origin_km
      FROM driver_checkins dc
      JOIN drivers d  ON dc.driver_id  = d.driver_id
      JOIN vehicles v ON dc.vehicle_id = v.vehicle_id
      LEFT JOIN vehicle_types vt ON v.type_id = vt.type_id
      LEFT JOIN LATERAL (
        SELECT latitude, longitude FROM gps_pings
        WHERE vehicle_id = dc.vehicle_id
        ORDER BY device_timestamp DESC LIMIT 1
      ) gp ON TRUE
      WHERE dc.shift_date = CURRENT_DATE
        AND dc.checkin_status = 'checked_in'
        AND (dc.hours_available - dc.hours_driven) >= $3
        AND (vt.max_payload_kg IS NULL OR vt.max_payload_kg >= $4)
      ORDER BY distance_to_origin_km ASC NULLS LAST
      LIMIT 5`,
      [load.orig_lat, load.orig_lon,
       load.expected_duration_hrs || 4,
       load.cargo_weight_kg || 0]
    );

    res.json({
      ok: true,
      load_ref: load.load_ref,
      suggestions: driversResult.rows,
      message: `${driversResult.rows.length} drivers available`
    });
  } catch (err) {
    logger.error('OPS: auto-match error', { error: err.message });
    res.status(500).json({ error: 'Auto-match failed' });
  }
});

// ── GET /api/ops/trips ───────────────────────────────────────
// Active and recent trips
router.get('/trips', async (req, res) => {
  const { status, date } = req.query;
  try {
    const params = [];
    let sql = `
      SELECT
        t.*,
        d.full_name AS driver_name, d.driver_code, d.phone_primary,
        v.fleet_number, v.registration,
        oz.zone_name AS origin_name,
        dz.zone_name AS dest_name,
        r.route_name,
        tc.gross_revenue_rand, tc.total_cost_rand, tc.actual_cpk_rand, tc.flagged
      FROM trips t
      JOIN drivers d  ON t.driver_id  = d.driver_id
      JOIN vehicles v ON t.vehicle_id = v.vehicle_id
      LEFT JOIN zones oz ON t.origin_zone_id = oz.zone_id
      LEFT JOIN zones dz ON t.dest_zone_id   = dz.zone_id
      LEFT JOIN routes r ON t.route_id = r.route_id
      LEFT JOIN trip_costs tc ON tc.trip_id = t.trip_id
      WHERE 1=1`;

    if (status) { params.push(status);            sql += ` AND t.trip_status = $${params.length}`; }
    if (date)   { params.push(date);              sql += ` AND t.departed_at::DATE = $${params.length}`; }
    else        { sql += ` AND t.created_at >= NOW() - INTERVAL '7 days'`; }

    sql += ` ORDER BY t.created_at DESC LIMIT 100`;

    const result = await query(sql, params);
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    logger.error('OPS: trips fetch error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch trips' });
  }
});

// ── GET /api/ops/alerts ──────────────────────────────────────
// Live alerts for dispatcher
router.get('/alerts', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM v_active_alerts LIMIT 50`);
    res.json({ ok: true, data: result.rows, count: result.rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

module.exports = router;
