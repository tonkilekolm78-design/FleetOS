// ============================================================
//  FleetOS — Administration Engine Routes
//  src/api/routes/administration.js
//  Handles: trip costs, payroll, pay stubs, audit log
// ============================================================
'use strict';

const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs');
const PDFDocument = require('pdfkit');
const { query, withTransaction } = require('../../config/database');
const { authenticate, requireRole } = require('../middleware/auth');
const logger   = require('../../utils/logger');

router.use(authenticate);

// ── GET /api/admin/audit-log ─────────────────────────────────
router.get('/audit-log', async (req, res) => {
  const { trip_id, driver_id, event_source, limit = 100 } = req.query;
  try {
    const params = [];
    let sql = `
      SELECT
        al.*,
        u.full_name AS triggered_by_name
      FROM audit_log al
      LEFT JOIN users u ON al.triggered_by_user = u.user_id
      WHERE 1=1`;

    if (trip_id)      { params.push(trip_id);      sql += ` AND al.trip_id = $${params.length}`; }
    if (driver_id)    { params.push(driver_id);    sql += ` AND al.driver_id = $${params.length}`; }
    if (event_source) { params.push(event_source); sql += ` AND al.event_source = $${params.length}`; }

    params.push(parseInt(limit));
    sql += ` ORDER BY al.log_time DESC LIMIT $${params.length}`;

    const result = await query(sql, params);
    res.json({ ok: true, data: result.rows, count: result.rows.length });
  } catch (err) {
    logger.error('ADMIN: audit log error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

// ── GET /api/admin/trip-costs ────────────────────────────────
router.get('/trip-costs', async (req, res) => {
  const { trip_id, driver_id, flagged, from_date, to_date } = req.query;
  try {
    const params = [];
    let sql = `
      SELECT
        tc.*,
        t.trip_ref, t.actual_distance_km,
        d.full_name AS driver_name, d.employment_type,
        v.fleet_number,
        r.route_name, r.target_cpk_rand
      FROM trip_costs tc
      JOIN trips t   ON tc.trip_id   = t.trip_id
      JOIN drivers d ON tc.driver_id = d.driver_id
      JOIN vehicles v ON tc.vehicle_id = v.vehicle_id
      LEFT JOIN routes r ON t.route_id = r.route_id
      WHERE 1=1`;

    if (trip_id)   { params.push(trip_id);   sql += ` AND tc.trip_id = $${params.length}`; }
    if (driver_id) { params.push(driver_id); sql += ` AND tc.driver_id = $${params.length}`; }
    if (flagged === 'true') sql += ` AND tc.flagged = TRUE`;
    if (from_date) { params.push(from_date); sql += ` AND tc.created_at::DATE >= $${params.length}`; }
    if (to_date)   { params.push(to_date);   sql += ` AND tc.created_at::DATE <= $${params.length}`; }

    sql += ` ORDER BY tc.created_at DESC LIMIT 200`;

    const result = await query(sql, params);
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    logger.error('ADMIN: trip costs error', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch trip costs' });
  }
});

// ── POST /api/admin/trip-costs ───────────────────────────────
router.post('/trip-costs', requireRole('accountant','manager','superadmin'), async (req, res) => {
  const {
    trip_id, gross_revenue_rand, fuel_cost_rand,
    fuel_litres, toll_cost_rand, accommodation_rand, incidental_rand
  } = req.body;

  if (!trip_id || gross_revenue_rand === undefined) {
    return res.status(400).json({ error: 'trip_id and gross_revenue_rand are required' });
  }

  try {
    // Fetch trip to get vehicle and driver IDs
    const tripRes = await query(
      `SELECT trip_id, driver_id, vehicle_id FROM trips WHERE trip_id = $1`, [trip_id]
    );
    if (!tripRes.rows.length) return res.status(404).json({ error: 'Trip not found' });
    const trip = tripRes.rows[0];

    const result = await query(`
      INSERT INTO trip_costs
        (trip_id, vehicle_id, driver_id, gross_revenue_rand, fuel_cost_rand,
         fuel_litres, toll_cost_rand, accommodation_rand, incidental_rand,
         entered_by, entry_method)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'manual')
      ON CONFLICT (trip_id) DO UPDATE SET
        gross_revenue_rand = EXCLUDED.gross_revenue_rand,
        fuel_cost_rand     = EXCLUDED.fuel_cost_rand,
        fuel_litres        = EXCLUDED.fuel_litres,
        toll_cost_rand     = EXCLUDED.toll_cost_rand,
        accommodation_rand = EXCLUDED.accommodation_rand,
        incidental_rand    = EXCLUDED.incidental_rand,
        updated_at         = NOW()
      RETURNING *`,
      [trip_id, trip.vehicle_id, trip.driver_id,
       gross_revenue_rand, fuel_cost_rand || 0,
       fuel_litres || null, toll_cost_rand || 0,
       accommodation_rand || 0, incidental_rand || 0,
       req.user.user_id]
    );

    logger.info('ADMIN: trip costs saved', { trip_id });
    res.status(201).json({ ok: true, data: result.rows[0] });
  } catch (err) {
    logger.error('ADMIN: save trip costs error', { error: err.message });
    res.status(500).json({ error: 'Failed to save trip costs' });
  }
});

// ── GET /api/admin/pay-periods ───────────────────────────────
router.get('/pay-periods', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM v_payroll_summary ORDER BY period_start DESC LIMIT 24`);
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch pay periods' });
  }
});

// ── POST /api/admin/pay-periods ──────────────────────────────
router.post('/pay-periods', requireRole('accountant','manager','superadmin'), async (req, res) => {
  const { period_name, period_start, period_end } = req.body;
  if (!period_name || !period_start || !period_end) {
    return res.status(400).json({ error: 'period_name, period_start, period_end required' });
  }
  try {
    const result = await query(`
      INSERT INTO pay_periods (period_name, period_start, period_end)
      VALUES ($1, $2, $3) RETURNING *`,
      [period_name, period_start, period_end]
    );
    res.status(201).json({ ok: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create pay period' });
  }
});

// ── POST /api/admin/payroll/calculate ───────────────────────
// Calculate payroll for all drivers in a period
router.post('/payroll/calculate', requireRole('accountant','manager','superadmin'), async (req, res) => {
  const { period_id } = req.body;
  if (!period_id) return res.status(400).json({ error: 'period_id required' });

  try {
    const periodRes = await query(
      `SELECT * FROM pay_periods WHERE period_id = $1`, [period_id]
    );
    if (!periodRes.rows.length) return res.status(404).json({ error: 'Pay period not found' });
    if (periodRes.rows[0].status === 'locked') {
      return res.status(409).json({ error: 'Pay period is locked — cannot recalculate' });
    }
    const period = periodRes.rows[0];

    // Get all drivers who had trips in this period
    const driversRes = await query(`
      SELECT DISTINCT
        d.driver_id,
        d.full_name,
        d.employment_type,
        d.commission_pct,
        COUNT(t.trip_id)                     AS trips_completed,
        COALESCE(SUM(t.actual_distance_km),0) AS total_distance_km,
        COALESCE(SUM(tc.gross_revenue_rand),0) AS gross_revenue_rand,
        COALESCE(SUM(tc.fuel_cost_rand),0)     AS fuel_deduction_rand,
        COALESCE(SUM(tc.toll_cost_rand),0)     AS toll_deduction_rand
      FROM drivers d
      JOIN trips t ON t.driver_id = d.driver_id
        AND t.trip_status = 'completed'
        AND t.arrived_at BETWEEN $1 AND $2
      LEFT JOIN trip_costs tc ON tc.trip_id = t.trip_id
      GROUP BY d.driver_id, d.full_name, d.employment_type, d.commission_pct`,
      [period.period_start, period.period_end + ' 23:59:59']
    );

    // Employee base salary (configurable — using env or default)
    const employeeBaseSalary = parseFloat(process.env.EMPLOYEE_BASE_SALARY || '18500');

    const records = [];
    for (const driver of driversRes.rows) {
      let commission_rand = 0;
      let base_salary    = 0;
      let net_payout     = 0;

      if (driver.employment_type === 'owner_operator') {
        commission_rand = driver.gross_revenue_rand * (driver.commission_pct / 100);
        net_payout = driver.gross_revenue_rand
                   - driver.fuel_deduction_rand
                   - driver.toll_deduction_rand
                   - commission_rand;
      } else {
        // Employee
        base_salary = employeeBaseSalary;
        net_payout  = base_salary;
      }

      const upsert = await query(`
        INSERT INTO payroll_records
          (period_id, driver_id, employment_type, trips_completed, total_distance_km,
           gross_revenue_rand, fuel_deduction_rand, toll_deduction_rand,
           commission_pct, commission_rand, base_salary_rand, net_payout_rand, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'calculated')
        ON CONFLICT (period_id, driver_id) DO UPDATE SET
          trips_completed    = EXCLUDED.trips_completed,
          total_distance_km  = EXCLUDED.total_distance_km,
          gross_revenue_rand = EXCLUDED.gross_revenue_rand,
          fuel_deduction_rand = EXCLUDED.fuel_deduction_rand,
          toll_deduction_rand = EXCLUDED.toll_deduction_rand,
          commission_rand    = EXCLUDED.commission_rand,
          base_salary_rand   = EXCLUDED.base_salary_rand,
          net_payout_rand    = EXCLUDED.net_payout_rand,
          status             = 'calculated',
          updated_at         = NOW()
        RETURNING *`,
        [period_id, driver.driver_id, driver.employment_type,
         driver.trips_completed, driver.total_distance_km,
         driver.gross_revenue_rand, driver.fuel_deduction_rand,
         driver.toll_deduction_rand, driver.commission_pct,
         commission_rand, base_salary, net_payout]
      );
      records.push(upsert.rows[0]);
    }

    // Write audit entry
    await query(`
      INSERT INTO audit_log (event_source, event_type, entity_type, description, triggered_by_user)
      VALUES ('payroll','PAYROLL_CALCULATED','pay_period',$1,$2)`,
      [`Payroll calculated for ${period.period_name} — ${records.length} drivers`, req.user.user_id]
    );

    logger.info('ADMIN: payroll calculated', { period_id, driver_count: records.length });
    res.json({ ok: true, records_calculated: records.length, data: records });
  } catch (err) {
    logger.error('ADMIN: payroll calc error', { error: err.message });
    res.status(500).json({ error: 'Payroll calculation failed' });
  }
});

// ── GET /api/admin/payroll/:period_id ────────────────────────
router.get('/payroll/:period_id', async (req, res) => {
  try {
    const result = await query(`
      SELECT
        pr.*,
        d.full_name, d.driver_code, d.phone_primary,
        d.bank_name, d.bank_account, d.bank_branch_code,
        pp.period_name, pp.period_start, pp.period_end
      FROM payroll_records pr
      JOIN drivers d    ON pr.driver_id  = d.driver_id
      JOIN pay_periods pp ON pr.period_id = pp.period_id
      WHERE pr.period_id = $1
      ORDER BY d.full_name`,
      [req.params.period_id]
    );
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch payroll' });
  }
});

// ── POST /api/admin/payroll/:payroll_id/approve ──────────────
router.post('/payroll/:payroll_id/approve', requireRole('manager','superadmin'), async (req, res) => {
  try {
    await query(`
      UPDATE payroll_records SET status = 'approved', approved_by = $1, approved_at = NOW()
      WHERE payroll_id = $2`,
      [req.user.user_id, req.params.payroll_id]
    );
    res.json({ ok: true, message: 'Payroll record approved' });
  } catch (err) {
    res.status(500).json({ error: 'Approval failed' });
  }
});

// ── GET /api/admin/paystub/:payroll_id ───────────────────────
// Generate and stream a PDF pay stub
router.get('/paystub/:payroll_id', async (req, res) => {
  try {
    const result = await query(`
      SELECT
        pr.*,
        d.full_name, d.driver_code, d.id_number,
        d.bank_name, d.bank_account, d.bank_branch_code,
        d.employment_type,
        pp.period_name, pp.period_start, pp.period_end
      FROM payroll_records pr
      JOIN drivers d      ON pr.driver_id  = d.driver_id
      JOIN pay_periods pp ON pr.period_id  = pp.period_id
      WHERE pr.payroll_id = $1`,
      [req.params.payroll_id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Payroll record not found' });
    }

    const p = result.rows[0];
    const fmt = (v) => `R ${parseFloat(v || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}`;

    // Build PDF
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="paystub_${p.driver_code}_${p.period_name.replace(/\s/g,'_')}.pdf"`);
    doc.pipe(res);

    // ── Header bar
    doc.rect(0, 0, 595, 80).fill('#1A2B38');
    doc.fillColor('#FFB400').fontSize(22).font('Helvetica-Bold')
       .text('FLEET', 50, 22, { continued: true })
       .fillColor('#FFFFFF').text('OS');
    doc.fillColor('#FFFFFF').fontSize(10).font('Helvetica')
       .text('Command Intelligence Platform', 50, 48);
    doc.fillColor('#FFB400').fontSize(14).font('Helvetica-Bold')
       .text('REMUNERATION STATEMENT', 350, 30, { width: 200, align: 'right' });

    // ── Period info
    doc.fillColor('#333333').fontSize(9).font('Helvetica')
       .text(`Pay Period: ${p.period_name}`, 50, 100)
       .text(`Generated: ${new Date().toLocaleDateString('en-ZA')}`, 50, 114)
       .text(`Pay Date: ${p.period_end}`, 50, 128);

    // ── Driver info box
    doc.rect(50, 150, 495, 70).stroke('#D0D9E0');
    doc.fillColor('#1A2B38').fontSize(9).font('Helvetica-Bold')
       .text('EMPLOYEE / OPERATOR DETAILS', 60, 158);
    doc.fillColor('#333333').font('Helvetica').fontSize(9)
       .text(`Name:         ${p.full_name}`, 60, 172)
       .text(`Code:         ${p.driver_code}`, 60, 185)
       .text(`ID Number:    ${p.id_number || 'N/A'}`, 60, 198)
       .text(`Type:         ${p.employment_type === 'owner_operator' ? 'Owner-Operator' : 'Employee'}`, 300, 172)
       .text(`Bank:         ${p.bank_name || 'N/A'}`, 300, 185)
       .text(`Account:      ${p.bank_account || 'N/A'}`, 300, 198);

    // ── Earnings table
    doc.fillColor('#1A2B38').fontSize(10).font('Helvetica-Bold')
       .text('EARNINGS', 50, 240);
    doc.rect(50, 255, 495, 18).fill('#1A2B38');
    doc.fillColor('#FFFFFF').fontSize(8).font('Helvetica-Bold')
       .text('DESCRIPTION', 60, 260)
       .text('AMOUNT', 480, 260, { width: 60, align: 'right' });

    let y = 278;
    const addRow = (label, value, isDeduction = false, isTotal = false) => {
      if (isTotal) {
        doc.rect(50, y - 3, 495, 20).fill('#E8F5E9');
        doc.fillColor('#1E7D34').fontSize(9).font('Helvetica-Bold');
      } else {
        if (y % 2 === 0) doc.rect(50, y - 3, 495, 18).fill('#F5F8FA');
        doc.fillColor(isDeduction ? '#B00020' : '#333333').fontSize(9).font('Helvetica');
      }
      doc.text(label, 60, y)
         .text(isDeduction ? `(${value})` : value, 480, y, { width: 60, align: 'right' });
      y += 20;
    };

    if (p.employment_type === 'owner_operator') {
      addRow('Trips Completed', p.trips_completed);
      addRow('Total Distance', `${parseFloat(p.total_distance_km || 0).toLocaleString()} km`);
      addRow('Gross Revenue', fmt(p.gross_revenue_rand));
      y += 4;
      doc.moveTo(50, y).lineTo(545, y).stroke('#D0D9E0'); y += 8;
      addRow('Fuel Deduction', fmt(p.fuel_deduction_rand), true);
      addRow('Toll Deduction', fmt(p.toll_deduction_rand), true);
      addRow(`Commission (${p.commission_pct}%)`, fmt(p.commission_rand), true);
      if (parseFloat(p.bonus_rand) > 0) addRow('Performance Bonus', fmt(p.bonus_rand));
      if (parseFloat(p.deductions_rand) > 0) addRow('Other Deductions', fmt(p.deductions_rand), true);
    } else {
      addRow('Base Salary', fmt(p.base_salary_rand));
      if (parseFloat(p.overtime_rand) > 0) addRow('Overtime', fmt(p.overtime_rand));
      if (parseFloat(p.bonus_rand) > 0) addRow('Performance Bonus', fmt(p.bonus_rand));
      if (parseFloat(p.deductions_rand) > 0) addRow('Deductions', fmt(p.deductions_rand), true);
      addRow('Trips Completed', p.trips_completed);
      addRow('Total Distance', `${parseFloat(p.total_distance_km || 0).toLocaleString()} km`);
    }

    y += 8;
    doc.moveTo(50, y).lineTo(545, y).strokeColor('#1A2B38').lineWidth(1.5).stroke(); y += 10;
    addRow('NET PAYOUT', fmt(p.net_payout_rand), false, true);

    // ── Formula note
    if (p.employment_type === 'owner_operator') {
      doc.fillColor('#888888').fontSize(7.5).font('Helvetica')
         .text('Formula: Gross Revenue − Fuel − Tolls − Commission + Bonus = Net Payout', 50, y + 20);
    }

    // ── Footer
    doc.rect(0, 780, 595, 60).fill('#1A2B38');
    doc.fillColor('#FFFFFF').fontSize(7.5).font('Helvetica')
       .text('This is a system-generated remuneration statement. Contact your fleet manager for queries.',
             50, 792, { width: 495, align: 'center' })
       .text('FleetOS Command Intelligence Platform  ·  Confidential',
             50, 806, { width: 495, align: 'center' });

    doc.end();

    // Mark paystub as generated
    await query(
      `UPDATE payroll_records SET paystub_generated = TRUE WHERE payroll_id = $1`,
      [req.params.payroll_id]
    );

    logger.info('ADMIN: paystub generated', { payroll_id: req.params.payroll_id });
  } catch (err) {
    logger.error('ADMIN: paystub error', { error: err.message });
    if (!res.headersSent) res.status(500).json({ error: 'Pay stub generation failed' });
  }
});

module.exports = router;
