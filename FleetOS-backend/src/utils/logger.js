'use strict';
const log = (level, msg, meta={}) => {
  const ts = new Date().toISOString();
    const extras = Object.keys(meta||{}).length ? ' '+JSON.stringify(meta) : '';
      console.log(`${ts} [${level.toUpperCase()}] ${msg}${extras}`);
      };
      module.exports = { info:(m,x)=>log('info',m,x), warn:(m,x)=>log('warn',m,x), error:(m,x)=>log('error',m,x), debug:(m,x)=>log('debug',m,x) };
  