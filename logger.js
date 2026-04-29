// ============================================================
//  FleetOS — Logger
//  src/utils/logger.js
// ============================================================
'use strict';

const { createLogger, format, transports } = require('winston');
const path = require('path');

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.json()
  ),
  defaultMeta: { service: 'fleetos' },
  transports: [
    // Console output (Render shows this in the dashboard)
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf(({ timestamp, level, message, ...meta }) => {
          const extras = Object.keys(meta).length > 1
            ? ' ' + JSON.stringify(meta)
            : '';
          return `${timestamp} [${level}] ${message}${extras}`;
        })
      )
    }),
    // File logging (optional — comment out if Render disk not attached)
    // new transports.File({ filename: process.env.LOG_FILE || 'logs/fleetos.log' })
  ]
});

module.exports = logger;
