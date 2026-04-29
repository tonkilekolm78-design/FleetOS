// ============================================================
//  FleetOS — GPS TCP Listener
//  src/gps/tcp-listener.js
//
//  Listens for Teltonika FMB920/FMB140 CODEC 8 packets over TCP.
//  Each packet contains GPS position + I/O data for one vehicle.
//  On receipt: decode → write to gps_pings → hand to geofence engine.
// ============================================================
'use strict';

require('dotenv').config();

const net    = require('net');
const { query } = require('../config/database');
const { authenticateDevice } = require('../api/middleware/auth');
const GeofenceEngine = require('../geofence/engine');
const logger = require('../utils/logger');

const TCP_PORT = parseInt(process.env.GPS_TCP_PORT || '8080');
const TCP_HOST = process.env.GPS_TCP_HOST || '0.0.0.0';
const SIGNAL_LOSS_THRESHOLD = parseInt(process.env.GPS_SIGNAL_LOSS_THRESHOLD_MIN || '10') * 60 * 1000;

// Track active connections per IMEI
const activeConnections = new Map();

// ── TCP Server ───────────────────────────────────────────────
const server = net.createServer((socket) => {
  let vehicleId   = null;
  let fleetNumber = null;
  let imei        = null;
  let buffer      = Buffer.alloc(0);
  let authenticated = false;

  const clientAddr = `${socket.remoteAddress}:${socket.remotePort}`;
  logger.info('GPS: new connection', { client: clientAddr });

  socket.setTimeout(120000); // 2-min timeout — device pings every 30-60s

  // ── Step 1: Receive IMEI ────────────────────────────────────
  // Teltonika sends IMEI as first message: 2-byte length + IMEI string
  socket.once('data', async (data) => {
    try {
      if (data.length < 2) {
        socket.destroy();
        return;
      }

      const imeiLength = data.readUInt16BE(0);
      imei = data.slice(2, 2 + imeiLength).toString('ascii');
      logger.info('GPS: IMEI received', { imei, client: clientAddr });

      // Authenticate against vehicles table
      const vehicle = await authenticateDevice(imei);
      if (!vehicle) {
        logger.warn('GPS: unknown IMEI — rejecting', { imei });
        socket.write(Buffer.from([0x00])); // reject
        socket.destroy();
        return;
      }

      vehicleId   = vehicle.vehicle_id;
      fleetNumber = vehicle.fleet_number;
      authenticated = true;

      // Track connection
      activeConnections.set(imei, { socket, vehicleId, fleetNumber, lastPing: Date.now() });

      // Accept device
      socket.write(Buffer.from([0x01]));
      logger.info('GPS: device authenticated', { imei, fleet: fleetNumber });

      // ── Step 2: Listen for CODEC 8 data packets ─────────────
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        processBuffer();
      });

    } catch (err) {
      logger.error('GPS: IMEI auth error', { error: err.message, imei });
      socket.destroy();
    }
  });

  // ── CODEC 8 Packet Processor ─────────────────────────────────
  function processBuffer() {
    // CODEC 8 structure:
    // [4 bytes: preamble 0x00000000]
    // [4 bytes: data length]
    // [1 byte: codec ID = 0x08]
    // [1 byte: number of records]
    // [records...]
    // [1 byte: number of records (again)]
    // [4 bytes: CRC-16]

    while (buffer.length >= 12) {
      // Check preamble
      if (buffer.readUInt32BE(0) !== 0x00000000) {
        logger.warn('GPS: invalid preamble — discarding byte', { fleet: fleetNumber });
        buffer = buffer.slice(1);
        continue;
      }

      const dataLength = buffer.readUInt32BE(4);
      const totalLength = 8 + dataLength + 4; // preamble(4) + length(4) + data + crc(4)

      if (buffer.length < totalLength) break; // wait for more data

      const packet = buffer.slice(0, totalLength);
      buffer = buffer.slice(totalLength);

      decodePacket(packet, dataLength);
    }
  }

  async function decodePacket(packet, dataLength) {
    try {
      const codecId    = packet.readUInt8(8);
      const recordCount = packet.readUInt8(9);

      if (codecId !== 0x08) {
        logger.warn('GPS: unsupported codec', { codecId, fleet: fleetNumber });
        return;
      }

      // Send ACK — number of records received
      socket.write(buildAck(recordCount));

      // Parse each AVL record
      let offset = 10;
      const records = [];

      for (let i = 0; i < recordCount; i++) {
        const record = parseAvlRecord(packet, offset);
        if (!record) break;
        records.push(record);
        offset += record._byteLength;
      }

      // Update last ping time
      const conn = activeConnections.get(imei);
      if (conn) conn.lastPing = Date.now();

      // Persist all records
      for (const rec of records) {
        await savePing(rec);
      }

    } catch (err) {
      logger.error('GPS: decode error', { error: err.message, fleet: fleetNumber });
    }
  }

  // ── Parse a single AVL record from CODEC 8 ─────────────────
  function parseAvlRecord(buf, offset) {
    try {
      const start = offset;

      // Timestamp (8 bytes, milliseconds since epoch)
      const tsHigh = buf.readUInt32BE(offset);     offset += 4;
      const tsLow  = buf.readUInt32BE(offset);     offset += 4;
      const timestamp = new Date(tsHigh * 2**32 + tsLow);

      // Priority (1 byte) — ignore
      offset += 1;

      // GPS data (15 bytes)
      const longitude  = buf.readInt32BE(offset) / 10000000;   offset += 4;
      const latitude   = buf.readInt32BE(offset) / 10000000;   offset += 4;
      const altitude   = buf.readInt16BE(offset);              offset += 2;
      const heading    = buf.readUInt16BE(offset);             offset += 2;
      const satellites = buf.readUInt8(offset);                offset += 1;
      const speed      = buf.readUInt16BE(offset);             offset += 2;

      // I/O data
      const ioEventId    = buf.readUInt8(offset);  offset += 1;
      const totalElements = buf.readUInt8(offset); offset += 1;

      // 1-byte I/O elements
      const n1 = buf.readUInt8(offset); offset += 1;
      const ioData = {};
      for (let j = 0; j < n1; j++) {
        const id  = buf.readUInt8(offset);  offset += 1;
        const val = buf.readUInt8(offset);  offset += 1;
        ioData[id] = val;
      }

      // 2-byte I/O elements
      const n2 = buf.readUInt8(offset); offset += 1;
      for (let j = 0; j < n2; j++) {
        const id  = buf.readUInt8(offset);   offset += 1;
        const val = buf.readUInt16BE(offset); offset += 2;
        ioData[id] = val;
      }

      // 4-byte I/O elements
      const n4 = buf.readUInt8(offset); offset += 1;
      for (let j = 0; j < n4; j++) {
        const id  = buf.readUInt8(offset);   offset += 1;
        const val = buf.readUInt32BE(offset); offset += 4;
        ioData[id] = val;
      }

      // 8-byte I/O elements (odometer is usually here)
      const n8 = buf.readUInt8(offset); offset += 1;
      for (let j = 0; j < n8; j++) {
        const id    = buf.readUInt8(offset);   offset += 1;
        // Read as two 32-bit parts
        const high  = buf.readUInt32BE(offset); offset += 4;
        const low   = buf.readUInt32BE(offset); offset += 4;
        ioData[id]  = high * 2**32 + low;
      }

      // Teltonika I/O IDs (FMB920):
      // ID 1  = digital input 1 (ignition)
      // ID 66 = external voltage (mV)
      // ID 199= odometer (metres)
      // ID 24 = speed (km/h — same as GPS speed)
      // ID 69= GNSS status
      const ignition   = ioData[1] === 1;
      const odometerM  = ioData[199] || null;

      return {
        timestamp,
        latitude,
        longitude,
        altitude_m  : altitude,
        speed_kmh   : speed,
        heading_degrees: heading,
        satellites,
        ignition_on : ignition,
        odometer_m  : odometerM,
        raw_io      : ioData,
        _byteLength : offset - start
      };
    } catch (err) {
      logger.error('GPS: AVL record parse error', { error: err.message, offset });
      return null;
    }
  }

  // ── Save ping to database ────────────────────────────────────
  async function savePing(rec) {
    try {
      // Skip if position is 0,0 (no GPS fix)
      if (rec.latitude === 0 && rec.longitude === 0) return;

      const result = await query(`
        INSERT INTO gps_pings
          (vehicle_id, device_timestamp, latitude, longitude, altitude_m,
           speed_kmh, heading_degrees, satellites, ignition_on, odometer_m)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING ping_id`,
        [vehicleId, rec.timestamp,
         rec.latitude, rec.longitude, rec.altitude_m,
         rec.speed_kmh, rec.heading_degrees, rec.satellites,
         rec.ignition_on, rec.odometer_m]
      );

      const pingId = result.rows[0].ping_id;

      // Check speed violation
      if (rec.speed_kmh > 120) {
        await checkSpeedViolation(rec, pingId);
      }

      // Hand off to geofence engine (non-blocking)
      GeofenceEngine.processping({
        ping_id  : pingId,
        vehicle_id: vehicleId,
        latitude : rec.latitude,
        longitude: rec.longitude,
        speed_kmh: rec.speed_kmh,
        timestamp: rec.timestamp
      }).catch(err => logger.error('GPS: geofence error', { error: err.message }));

    } catch (err) {
      logger.error('GPS: save ping error', { error: err.message, fleet: fleetNumber });
    }
  }

  async function checkSpeedViolation(rec, pingId) {
    const excess = rec.speed_kmh - 120;
    const severity = excess > 40 ? 'critical' : excess > 20 ? 'major' : 'minor';
    try {
      // Get driver from active checkin
      const driverRes = await query(
        `SELECT driver_id FROM driver_checkins
         WHERE vehicle_id = $1 AND shift_date = CURRENT_DATE
           AND checkin_status NOT IN ('checked_out')
         LIMIT 1`,
        [vehicleId]
      );
      const driverId = driverRes.rows[0]?.driver_id || null;

      await query(`
        INSERT INTO speed_violations
          (vehicle_id, driver_id, ping_id, violation_time, latitude, longitude,
           recorded_speed_kmh, speed_limit_kmh, excess_kmh, severity)
        VALUES ($1,$2,$3,$4,$5,$6,$7,120,$8,$9)`,
        [vehicleId, driverId, pingId, rec.timestamp,
         rec.latitude, rec.longitude,
         rec.speed_kmh, excess, severity]
      );
      logger.warn('GPS: speed violation', { fleet: fleetNumber, speed: rec.speed_kmh, severity });
    } catch (err) {
      logger.error('GPS: speed violation log error', { error: err.message });
    }
  }

  // ── Build ACK packet ─────────────────────────────────────────
  function buildAck(count) {
    const ack = Buffer.alloc(4);
    ack.writeUInt32BE(count, 0);
    return ack;
  }

  // ── Socket events ────────────────────────────────────────────
  socket.on('timeout', () => {
    logger.warn('GPS: socket timeout', { fleet: fleetNumber, imei });
    handleDisconnect();
    socket.destroy();
  });

  socket.on('error', (err) => {
    if (err.code !== 'ECONNRESET') {
      logger.error('GPS: socket error', { error: err.message, fleet: fleetNumber });
    }
    handleDisconnect();
  });

  socket.on('close', () => {
    logger.info('GPS: connection closed', { fleet: fleetNumber, imei });
    handleDisconnect();
  });

  async function handleDisconnect() {
    if (!vehicleId || !authenticated) return;
    activeConnections.delete(imei);

    // Log signal loss
    try {
      // Get last known position
      const lastPing = await query(`
        SELECT latitude, longitude, device_timestamp, current_zone_id
        FROM gps_pings WHERE vehicle_id = $1
        ORDER BY device_timestamp DESC LIMIT 1`,
        [vehicleId]
      );

      const driverRes = await query(
        `SELECT driver_id FROM driver_checkins
         WHERE vehicle_id = $1 AND shift_date = CURRENT_DATE
           AND checkin_status NOT IN ('checked_out') LIMIT 1`,
        [vehicleId]
      );

      if (lastPing.rows.length) {
        const lp = lastPing.rows[0];
        await query(`
          INSERT INTO signal_loss_log
            (vehicle_id, driver_id, last_known_lat, last_known_lon,
             last_ping_at, last_known_zone_id)
          VALUES ($1,$2,$3,$4,$5,$6)`,
          [vehicleId,
           driverRes.rows[0]?.driver_id || null,
           lp.latitude, lp.longitude,
           lp.device_timestamp,
           lp.current_zone_id || null]
        );
        logger.warn('GPS: signal loss logged', { fleet: fleetNumber });
      }
    } catch (err) {
      logger.error('GPS: signal loss log error', { error: err.message });
    }
  }
});

// ── Signal loss monitor (runs every 2 minutes) ───────────────
setInterval(async () => {
  const threshold = Date.now() - SIGNAL_LOSS_THRESHOLD;
  for (const [imei, conn] of activeConnections.entries()) {
    if (conn.lastPing < threshold) {
      logger.warn('GPS: no ping received — possible signal loss', {
        fleet: conn.fleetNumber, lastPing: new Date(conn.lastPing)
      });
    }
  }
}, 120000);

// ── Start server ─────────────────────────────────────────────
server.listen(TCP_PORT, TCP_HOST, () => {
  logger.info(`GPS TCP Listener started`, { host: TCP_HOST, port: TCP_PORT });
});

server.on('error', (err) => {
  logger.error('GPS: server error', { error: err.message });
  process.exit(1);
});

// ── Status endpoint (for health checks) ─────────────────────
module.exports = {
  getActiveConnections: () => activeConnections.size,
  getConnectedVehicles: () => Array.from(activeConnections.values()).map(c => c.fleetNumber)
};
