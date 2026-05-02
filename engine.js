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
