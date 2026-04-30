'use strict';
let cron; try { cron=require('node-cron'); } catch(e){}
const { query } = require('../config/database');
const logger = require('../utils/logger');

async function checkEta() {
  try {
      const r = await query('SELECT t.trip_id,t.trip_ref,t.driver_id,t.vehicle_id,t.expected_arrive,v.fleet_number FROM trips t JOIN vehicles v ON t.vehicle_id=v.vehicle_id WHERE t.trip_status=\'in_transit\' AND t.expected_arrive IS NOT NULL AND t.expected_arrive<NOW() AND t.eta_breach=FALSE AND EXTRACT(EPOCH FROM(NOW()-t.expected_arrive))/60>$1',[15]);
          for (const trip of r.rows) {
                const min=Math.round((Date.now()-new Date(trip.expected_arrive).getTime())/60000);
                      await query('INSERT INTO crosscheck_results(check_type,trip_id,vehicle_id,driver_id,expected_value,actual_value,unit,passed,severity,finding) VALUES(\'eta_compliance\',$1,$2,$3,0,$4,\'minutes\',FALSE,$5,$6)',
                              [trip.trip_id,trip.vehicle_id,trip.driver_id,min,min>60?'critical':'warning',`${trip.fleet_number} overdue by ${min} min`]);
                                    await query('UPDATE trips SET eta_breach=TRUE WHERE trip_id=$1',[trip.trip_id]);
                                          logger.warn('CrossCheck: ETA breach',{trip_ref:trip.trip_ref,min});
                                              }
                                                } catch(e){}
                                                }

                                                async function syncMaintenance() {
                                                  try {
                                                      await query('UPDATE maintenance_schedule ms SET km_remaining=ms.next_due_km-v.odometer_km, alert_status=CASE WHEN ms.next_due_km-v.odometer_km<0 THEN \'overdue\' WHEN ms.next_due_km-v.odometer_km<500 THEN \'critical\' WHEN ms.next_due_km-v.odometer_km<ms.warn_at_km THEN \'due_soon\' WHEN ms.next_due_km-v.odometer_km<3000 THEN \'upcoming\' ELSE \'ok\' END,last_updated=NOW() FROM vehicles v WHERE ms.vehicle_id=v.vehicle_id');
                                                        } catch(e){}
                                                        }

                                                        async function runAllChecks() {
                                                          logger.debug('CrossCheck: running checks');
                                                            await Promise.allSettled([checkEta(), syncMaintenance()]);
                                                            }

                                                            function startScheduler() {
                                                              const min = parseInt(process.env.CROSSCHECK_INTERVAL_MIN||'5');
                                                                if (cron) {
                                                                    cron.schedule(`*/${min} * * * *`, ()=>runAllChecks().catch(e=>logger.error('CrossCheck error',{error:e.message})));
                                                                        logger.info(`CrossCheck: scheduler started every ${min} min`);
                                                                          } else {
                                                                              logger.warn('CrossCheck: node-cron not available — running once');
                                                                                  runAllChecks().catch(()=>{});
                                                                                    }
                                                                                    }

                                                                                    module.exports = { startScheduler, runAllChecks };
                                                                                    