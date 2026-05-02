'use strict';
require('dotenv').config();
const net = require('net');
const { query } = require('../config/database');
const { authenticateDevice } = require('../api/middleware/auth');
const GeofenceEngine = require('../geofence/engine');
const logger = require('../utils/logger');
const TCP_PORT = parseInt(process.env.GPS_TCP_PORT||'8080');

const server = net.createServer((socket) => {
  let vehicleId=null, fleetNumber=null, imei=null, buffer=Buffer.alloc(0), auth=false;
  logger.info('GPS: connection',{from:`${socket.remoteAddress}:${socket.remotePort}`});
  socket.setTimeout(120000);

  socket.once('data', async(data)=>{
    try {
      if (data.length<2){socket.destroy();return;}
      const len=data.readUInt16BE(0);
      imei=data.slice(2,2+len).toString('ascii');
      const vehicle=await authenticateDevice(imei);
      if (!vehicle){socket.write(Buffer.from([0x00]));socket.destroy();logger.warn('GPS: unknown IMEI',{imei});return;}
      vehicleId=vehicle.vehicle_id; fleetNumber=vehicle.fleet_number; auth=true;
      socket.write(Buffer.from([0x01]));
      logger.info('GPS: authenticated',{imei,fleet:fleetNumber});
      socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);processBuffer();});
    } catch(e){logger.error('GPS: auth error',{error:e.message});socket.destroy();}
  });

  function processBuffer(){
    while(buffer.length>=12){
      if(buffer.readUInt32BE(0)!==0){buffer=buffer.slice(1);continue;}
      const dLen=buffer.readUInt32BE(4);
      const total=8+dLen+4;
      if(buffer.length<total)break;
      const pkt=buffer.slice(0,total); buffer=buffer.slice(total);
      try{
        const codec=pkt.readUInt8(8);
        const count=pkt.readUInt8(9);
        socket.write(buildAck(count));
        if(codec!==0x08)continue;
        let off=10;
        for(let i=0;i<count;i++){
          const rec=parseRecord(pkt,off);
          if(!rec)break;
          off+=rec._len;
          savePing(rec).catch(e=>logger.error('GPS: save ping error',{error:e.message}));
        }
      }catch(e){logger.error('GPS: decode error',{error:e.message});}
    }
  }

  function parseRecord(buf,off){
    try{
      const start=off;
      const tsHi=buf.readUInt32BE(off);off+=4;
      const tsLo=buf.readUInt32BE(off);off+=4;
      const ts=new Date(tsHi*4294967296+tsLo);
      off+=1; // priority
      const lon=buf.readInt32BE(off)/10000000;off+=4;
      const lat=buf.readInt32BE(off)/10000000;off+=4;
      const alt=buf.readInt16BE(off);off+=2;
      const hdg=buf.readUInt16BE(off);off+=2;
      const sat=buf.readUInt8(off);off+=1;
      const spd=buf.readUInt16BE(off);off+=2;
      off+=1; // io event id
      const total=buf.readUInt8(off);off+=1;
      const ioData={};
      for(const sz of [1,2,4]){
        const n=buf.readUInt8(off);off+=1;
        for(let j=0;j<n;j++){const id=buf.readUInt8(off);off+=1;const v=sz===1?buf.readUInt8(off):sz===2?buf.readUInt16BE(off):buf.readUInt32BE(off);off+=sz;ioData[id]=v;}
      }
      const n8=buf.readUInt8(off);off+=1;
      for(let j=0;j<n8;j++){const id=buf.readUInt8(off);off+=1;const h=buf.readUInt32BE(off);off+=4;const l=buf.readUInt32BE(off);off+=4;ioData[id]=h*4294967296+l;}
      return{timestamp:ts,latitude:lat,longitude:lon,altitude_m:alt,speed_kmh:spd,heading_degrees:hdg,satellites:sat,ignition_on:ioData[1]===1,odometer_m:ioData[199]||null,_len:off-start};
    }catch(e){return null;}
  }

  async function savePing(rec){
    if(rec.latitude===0&&rec.longitude===0)return;
    try{
      const r=await query('INSERT INTO gps_pings(vehicle_id,device_timestamp,latitude,longitude,altitude_m,speed_kmh,heading_degrees,satellites,ignition_on,odometer_m) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ping_id',
        [vehicleId,rec.timestamp,rec.latitude,rec.longitude,rec.altitude_m,rec.speed_kmh,rec.heading_degrees,rec.satellites,rec.ignition_on,rec.odometer_m]);
      GeofenceEngine.processPing({ping_id:r.rows[0].ping_id,vehicle_id:vehicleId,latitude:rec.latitude,longitude:rec.longitude,speed_kmh:rec.speed_kmh,timestamp:rec.timestamp}).catch(()=>{});
    }catch(e){logger.error('GPS: db save error',{error:e.message});}
  }

  function buildAck(n){const b=Buffer.alloc(4);b.writeUInt32BE(n,0);return b;}
  socket.on('timeout',()=>{logger.warn('GPS: timeout',{fleet:fleetNumber});socket.destroy();});
  socket.on('error',e=>{if(e.code!=='ECONNRESET')logger.error('GPS: socket error',{error:e.message});});
  socket.on('close',()=>logger.info('GPS: disconnected',{fleet:fleetNumber}));
});

server.listen(TCP_PORT,'0.0.0.0',()=>logger.info(`GPS TCP Listener running on port ${TCP_PORT}`));
server.on('error',e=>{logger.error('GPS: server error',{error:e.message});process.exit(1);});
module.exports = server;
