// ============================================================
//  FleetOS — Geofence Engine
//  src/geofence/engine.js
//
//  Receives every GPS ping from the TCP listener.
//  Checks whether the vehicle has crossed a zone boundary.
//  Fires events: zone_entry, zone_exit, dwell_alert.
//  Updates trip status automatically (no manual driver input).
// ============================================================
'use strict';

const { query, withTransaction } = require('../config/database');
const logger = require('../utils/logger');

// Cache zones in memory — refreshed every 5 minutes
// Avoids a DB query on every single GPS ping
let zonesCache    = [];
let zonesCachedAt = 0;
const ZONE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Track last known zone per vehicle in memory
// { vehicle_id: { zone_id, zone_name, entered_at } | null }
const vehicleZoneState = new Map();

// ── Haversine distance formula ────────────────────────────────
// Returns distance in metres between two lat/lon points
function haversineMetres(lat1, lon1, lat2, lon2) {
  const R  = 6371000; // Earth radius in metres
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a  = Math.sin(Δφ/2) ** 2
            + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Load zones from database ─────────────────────────────────
async function loadZones() {
  const now = Date.now();
  if (zonesCache.length && now - zonesCachedAt < ZONE_CACHE_TTL) {
    return zonesCache;
  }
  const result = await query(
    `SELECT zone_id, zone_code, zone_name, zone_type,
            latitude, longitude, radius_metres
     FROM zones WHERE is_active = TRUE`
  );
  zonesCache    = result.rows;
  zonesCachedAt = now;
  logger.debug('Geofence: zones reloaded', { count: zonesCache.length });
  return zonesCache;
}

// ── Find which zone a point is inside (null if open road) ────
function findZoneForPoint(lat, lon, zones) {
  for (const zone of zones) {
    const dist = haversineMetres(lat, lon, zone.latitude, zone.longitude);
    if (dist <= zone.radius_metres) {
      return zone;
    }
  }
  return null;
}

// ── Main: process a single GPS ping ─────────────────────────
async function processPing(ping) {
  const { ping_id, vehicle_id, latitude, longitude, speed_kmh, timestamp } = ping;

  try {
    const zones      = await loadZones();
    const currentZone = findZoneForPoint(latitude, longitude, zones);
    const prevState   = vehicleZoneState.get(vehicle_id) || null;

    // Update gps_pings with resolved zone
    if (currentZone) {
      await query(
        `UPDATE gps_pings SET current_zone_id = $1 WHERE ping_id = $2`,
        [currentZone.zone_id, ping_id]
      );
    }

    // ── Detect zone transitions ──────────────────────────────
    const wasInZone  = prevState !== null;
    const nowInZone  = currentZone !== null;
    const sameZone   = wasInZone && nowInZone && prevState.zone_id === currentZone.zone_id;

    if (!sameZone) {
      // Zone EXIT — vehicle left a zone
      if (wasInZone && (!nowInZone || prevState.zone_id !== currentZone?.zone_id)) {
        await handleZoneExit(vehicle_id, prevState, ping, ping_id);
      }
      // Zone ENTRY — vehicle entered a zone
      if (nowInZone && (!wasInZone || prevState?.zone_id !== currentZone.zone_id)) {
        await handleZoneEntry(vehicle_id, currentZone, ping, ping_id);
      }
    }

    // ── Dwell time check (vehicle stationary inside zone) ────
    if (sameZone && prevState.entered_at) {
      const dwellMs = timestamp - prevState.entered_at;
      const dwellMin = Math.floor(dwellMs / 60000);
      const alertThreshold = parseInt(process.env.DWELL_ALERT_THRESHOLD_MIN || '60');
      if (dwellMin >= alertThreshold && !prevState.dwell_alerted) {
        await handleDwellAlert(vehicle_id, currentZone, dwellMin, ping, ping_id);
        prevState.dwell_alerted = true;
      }
    }

    // Update in-memory state
    vehicleZoneState.set(vehicle_id, currentZone
      ? { zone_id: currentZone.zone_id, zone_name: currentZone.zone_name,
          entered_at: wasInZone && sameZone ? prevState.entered_at : timestamp.getTime(),
          dwell_alerted: sameZone ? prevState?.dwell_alerted : false }
      : null
    );

  } catch (err) {
    logger.error('Geofence: processping error', { error: err.message, vehicle_id });
  }
}

// ── Zone ENTRY handler ───────────────────────────────────────
async function handleZoneEntry(vehicleId, zone, ping, pingId) {
  logger.info('Geofence: ZONE ENTRY', {
    vehicle: vehicleId, zone: zone.zone_name, time: ping.timestamp
  });

  await withTransaction(async (client) => {
    // 1. Log geofence event
    const gfeResult = await client.query(`
      INSERT INTO geofence_events
        (vehicle_id, zone_id, event_type, event_time, ping_id,
         latitude, longitude, speed_kmh, auto_note)
      VALUES ($1,$2,'zone_entry',$3,$4,$5,$6,$7,$8)
      RETURNING event_id`,
      [vehicleId, zone.zone_id, ping.timestamp, pingId,
       ping.latitude, ping.longitude, ping.speed_kmh,
       `Vehicle entered ${zone.zone_name} at ${ping.timestamp.toISOString()}`]
    );

    // 2. Find active trip for this vehicle
    const tripRes = await client.query(`
      SELECT t.trip_id, t.trip_ref, t.expected_arrive,
             t.dest_zone_id, t.origin_zone_id, t.trip_status,
             d.driver_id
      FROM trips t
      JOIN driver_checkins dc ON dc.driver_id = t.driver_id
        AND dc.vehicle_id = $1
        AND dc.shift_date = CURRENT_DATE
      WHERE t.trip_status IN ('pending','in_transit')
      ORDER BY t.created_at DESC LIMIT 1`,
      [vehicleId]
    );

    if (!tripRes.rows.length) return;
    const trip = tripRes.rows[0];

    // 3. Is this the DESTINATION zone? → Trip completed
    if (trip.dest_zone_id === zone.zone_id && trip.trip_status === 'in_transit') {
      await completTrip(client, trip, ping, zone, gfeResult.rows[0].event_id);
    }

    // 4. Update geofence_event with trip link
    await client.query(
      `UPDATE geofence_events SET trip_id = $1, driver_id = $2
       WHERE event_id = $3`,
      [trip.trip_id, trip.driver_id, gfeResult.rows[0].event_id]
    );

    // 5. Check if this is a waypoint zone — log to audit
    await client.query(`
      INSERT INTO audit_log
        (event_source, event_type, entity_type, entity_id,
         description, vehicle_id, driver_id, trip_id)
      VALUES ('geofence','GEOFENCE_ENTRY','geofence_event',$1,$2,$3,$4,$5)`,
      [gfeResult.rows[0].event_id,
       `Entered ${zone.zone_name} — ${zone.zone_type}`,
       vehicleId, trip.driver_id, trip.trip_id]
    );
  });
}

// ── Zone EXIT handler ────────────────────────────────────────
async function handleZoneExit(vehicleId, prevState, ping, pingId) {
  logger.info('Geofence: ZONE EXIT', {
    vehicle: vehicleId, zone: prevState.zone_name, time: ping.timestamp
  });

  const dwellMin = prevState.entered_at
    ? Math.floor((ping.timestamp.getTime() - prevState.entered_at) / 60000)
    : null;

  await withTransaction(async (client) => {
    // 1. Log geofence event
    const gfeResult = await client.query(`
      INSERT INTO geofence_events
        (vehicle_id, zone_id, event_type, event_time, ping_id,
         latitude, longitude, speed_kmh, dwell_minutes, auto_note)
      VALUES ($1,$2,'zone_exit',$3,$4,$5,$6,$7,$8,$9)
      RETURNING event_id`,
      [vehicleId, prevState.zone_id, ping.timestamp, pingId,
       ping.latitude, ping.longitude, ping.speed_kmh, dwellMin,
       `Vehicle exited ${prevState.zone_name}${dwellMin ? ` after ${dwellMin} min` : ''}`]
    );

    // 2. Find active trip
    const tripRes = await client.query(`
      SELECT t.trip_id, t.trip_ref, t.expected_depart,
             t.origin_zone_id, t.driver_id
      FROM trips t
      JOIN driver_checkins dc ON dc.driver_id = t.driver_id
        AND dc.vehicle_id = $1 AND dc.shift_date = CURRENT_DATE
      WHERE t.trip_status IN ('pending','in_transit')
      ORDER BY t.created_at DESC LIMIT 1`,
      [vehicleId]
    );

    if (!tripRes.rows.length) return;
    const trip = tripRes.rows[0];

    // 3. Is this the ORIGIN zone? → Trip started automatically
    if (trip.origin_zone_id === prevState.zone_id && trip.trip_status === 'pending') {
      await startTrip(client, trip, ping, prevState.zone_name, gfeResult.rows[0].event_id);
    }

    await client.query(
      `UPDATE geofence_events SET trip_id = $1, driver_id = $2
       WHERE event_id = $3`,
      [trip.trip_id, trip.driver_id, gfeResult.rows[0].event_id]
    );

    await client.query(`
      INSERT INTO audit_log
        (event_source, event_type, entity_type, entity_id,
         description, vehicle_id, driver_id, trip_id)
      VALUES ('geofence','GEOFENCE_EXIT','geofence_event',$1,$2,$3,$4,$5)`,
      [gfeResult.rows[0].event_id,
       `Exited ${prevState.zone_name}${dwellMin ? ` — dwell ${dwellMin} min` : ''}`,
       vehicleId, trip.driver_id, trip.trip_id]
    );
  });
}

// ── Start trip (triggered by exit from origin zone) ──────────
async function startTrip(client, trip, ping, zoneName, eventId) {
  logger.info('Geofence: TRIP STARTED', { trip_ref: trip.trip_ref });

  await client.query(`
    UPDATE trips SET trip_status = 'in_transit', departed_at = $1
    WHERE trip_id = $2`,
    [ping.timestamp, trip.trip_id]
  );

  await client.query(`
    UPDATE loads SET load_status = 'in_transit'
    WHERE load_id = (SELECT load_id FROM trips WHERE trip_id = $1)`,
    [trip.trip_id]
  );

  // Cross-check: Was departure on time?
  if (trip.expected_depart) {
    const varianceMin = Math.round(
      (ping.timestamp.getTime() - new Date(trip.expected_depart).getTime()) / 60000
    );
    await client.query(`
      INSERT INTO crosscheck_results
        (check_type, trip_id, vehicle_id, driver_id,
         expected_value, actual_value, unit, passed, severity, finding)
      VALUES ('eta_compliance',$1,$2,$3,0,$4,'minutes',$5,$6,$7)`,
      [trip.trip_id, ping.vehicle_id, trip.driver_id,
       varianceMin,
       varianceMin <= 15,
       varianceMin > 60 ? 'critical' : varianceMin > 15 ? 'warning' : 'info',
       varianceMin <= 0
         ? `${trip.trip_ref} departed on time from ${zoneName}`
         : `${trip.trip_ref} departed ${varianceMin} min late from ${zoneName}`
      ]
    );
  }

  await client.query(`
    INSERT INTO audit_log (event_source, event_type, entity_type, entity_id, description, vehicle_id, driver_id, trip_id)
    VALUES ('geofence','TRIP_STARTED','trip',$1,$2,$3,$4,$5)`,
    [trip.trip_id, `Trip ${trip.trip_ref} started — exited ${zoneName}`,
     ping.vehicle_id, trip.driver_id, trip.trip_id]
  );
}

// ── Complete trip (triggered by entry into destination zone) ─
async function completTrip(client, trip, ping, zone, eventId) {
  logger.info('Geofence: TRIP COMPLETED', { trip_ref: trip.trip_ref });

  // Calculate actual distance from odometer delta
  const distRes = await client.query(`
    SELECT
      MAX(odometer_m) - MIN(odometer_m) AS distance_m
    FROM gps_pings
    WHERE vehicle_id = $1 AND trip_id = $2 AND odometer_m IS NOT NULL`,
    [ping.vehicle_id, trip.trip_id]
  );
  const actualDistanceKm = distRes.rows[0]?.distance_m
    ? Math.round(distRes.rows[0].distance_m / 100) / 10
    : null;

  await client.query(`
    UPDATE trips SET
      trip_status = 'completed',
      arrived_at  = $1,
      actual_distance_km = COALESCE($2, actual_distance_km)
    WHERE trip_id = $3`,
    [ping.timestamp, actualDistanceKm, trip.trip_id]
  );

  // Update driver status back to available
  await client.query(`
    UPDATE driver_checkins SET checkin_status = 'checked_in'
    WHERE driver_id = $1 AND shift_date = CURRENT_DATE
      AND checkin_status = 'on_load'`,
    [trip.driver_id]
  );

  // Update load to delivered
  await client.query(`
    UPDATE loads SET load_status = 'delivered'
    WHERE load_id = (SELECT load_id FROM trips WHERE trip_id = $1)`,
    [trip.trip_id]
  );

  await client.query(`
    INSERT INTO audit_log (event_source, event_type, entity_type, entity_id, description, vehicle_id, driver_id, trip_id)
    VALUES ('geofence','TRIP_COMPLETED','trip',$1,$2,$3,$4,$5)`,
    [trip.trip_id,
     `Trip ${trip.trip_ref} completed at ${zone.zone_name}${actualDistanceKm ? ` — ${actualDistanceKm} km` : ''}`,
     ping.vehicle_id, trip.driver_id, trip.trip_id]
  );
}

// ── Dwell alert ──────────────────────────────────────────────
async function handleDwellAlert(vehicleId, zone, dwellMin, ping, pingId) {
  logger.warn('Geofence: DWELL ALERT', {
    vehicle: vehicleId, zone: zone.zone_name, dwell_min: dwellMin
  });

  const driverRes = await query(
    `SELECT dc.driver_id FROM driver_checkins dc
     WHERE dc.vehicle_id = $1 AND dc.shift_date = CURRENT_DATE LIMIT 1`,
    [vehicleId]
  );

  await query(`
    INSERT INTO geofence_events
      (vehicle_id, zone_id, event_type, event_time, ping_id,
       latitude, longitude, dwell_minutes, auto_note)
    VALUES ($1,$2,'dwell_alert',NOW(),$3,$4,$5,$6,$7)`,
    [vehicleId, zone.zone_id, pingId,
     ping.latitude, ping.longitude, dwellMin,
     `Vehicle stationary in ${zone.zone_name} for ${dwellMin} minutes`]
  );

  await query(`
    INSERT INTO crosscheck_results
      (check_type, vehicle_id, driver_id, expected_value, actual_value,
       unit, passed, severity, finding, recommendation)
    VALUES ('dwell_time',$1,$2,$3,$4,'minutes',FALSE,'warning',$5,$6)`,
    [vehicleId,
     driverRes.rows[0]?.driver_id || null,
     parseInt(process.env.DWELL_ALERT_THRESHOLD_MIN || '60'),
     dwellMin,
     `Vehicle in ${zone.zone_name} for ${dwellMin} min — exceeds ${process.env.DWELL_ALERT_THRESHOLD_MIN || '60'} min threshold`,
     `Confirm with driver — possible delay, breakdown, or unscheduled stop`]
  );
}

// ── Refresh zone cache manually ──────────────────────────────
async function refreshZones() {
  zonesCachedAt = 0;
  return loadZones();
}

module.exports = { processPing, refreshZones, vehicleZoneState };
