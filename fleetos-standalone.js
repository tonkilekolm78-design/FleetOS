'use strict';
const http = require('http');
const url  = require('url');
const PORT = 3000;

const log = (l,m,x) => console.log(`${new Date().toISOString()} [${l.toUpperCase()}] ${m}${x?' '+JSON.stringify(x):''}`);

const DEMO = {
  fleet:[
    {fleet_number:'TRK-004',driver_name:'Mokoena, K.',driver_status:'on_load',trip_status:'in_transit',last_lat:-26.1052,last_lon:28.0560,last_speed:87,hours_remaining:9.2,current_zone:'En Route N3',active_trip:'TRIP-2201',eta_breach:false},
    {fleet_number:'TRK-011',driver_name:'Dlamini, L.',driver_status:'checked_in',trip_status:null,last_lat:-26.2041,last_lon:28.0473,last_speed:0,hours_remaining:7.8,current_zone:'Depot A',active_trip:null,eta_breach:false},
    {fleet_number:'TRK-007',driver_name:'Pieterse, N.',driver_status:'on_load',trip_status:'in_transit',last_lat:-33.1200,last_lon:19.4100,last_speed:102,hours_remaining:6.1,current_zone:'En Route N1',active_trip:'TRIP-2198',eta_breach:false},
    {fleet_number:'TRK-002',driver_name:'Vermeulen, S.',driver_status:'resting',trip_status:null,last_lat:-33.4667,last_lon:19.6167,last_speed:0,hours_remaining:2.1,current_zone:'N1 Layby',active_trip:null,eta_breach:false},
    {fleet_number:'TRK-009',driver_name:'Nkosi, L.',driver_status:'flagged',trip_status:'in_transit',last_lat:-27.8300,last_lon:26.1600,last_speed:0,hours_remaining:3.4,current_zone:'Unknown',active_trip:'TRIP-2199',eta_breach:true},
    {fleet_number:'TRK-015',driver_name:'Adams, T.',driver_status:'checked_in',trip_status:null,last_lat:-25.7479,last_lon:28.2293,last_speed:0,hours_remaining:10,current_zone:'Depot B',active_trip:null,eta_breach:false},
  ],
  summary:{drivers_active:6,drivers_ready:3,drivers_in_transit:2,drivers_flagged:1,loads_queued:4,loads_in_transit:3,loads_delivered_today:7,active_eta_breaches:1},
  queue:[
    {driver_code:'DRV-001',full_name:'Mokoena, K.',fleet_number:'TRK-004',checkin_status:'on_load',hours_remaining:9.2,current_zone:'En Route',employment_type:'owner_operator'},
    {driver_code:'DRV-002',full_name:'Dlamini, L.',fleet_number:'TRK-011',checkin_status:'checked_in',hours_remaining:7.8,current_zone:'Depot A',employment_type:'owner_operator'},
    {driver_code:'DRV-003',full_name:'Pieterse, N.',fleet_number:'TRK-007',checkin_status:'on_load',hours_remaining:6.1,current_zone:'En Route',employment_type:'employee'},
    {driver_code:'DRV-004',full_name:'Vermeulen, S.',fleet_number:'TRK-002',checkin_status:'resting',hours_remaining:2.1,current_zone:'N1 Layby',employment_type:'owner_operator'},
    {driver_code:'DRV-005',full_name:'Nkosi, L.',fleet_number:'TRK-009',checkin_status:'flagged',hours_remaining:3.4,current_zone:'Unknown',employment_type:'employee'},
    {driver_code:'DRV-006',full_name:'Adams, T.',fleet_number:'TRK-015',checkin_status:'checked_in',hours_remaining:10,current_zone:'Depot B',employment_type:'owner_operator'},
  ],
  loads:[
    {load_ref:'LOAD-2201',client_name:'Shoprite DC',origin_zone_name:'Depot A',dest_zone_name:'Client X Cape Town',priority:'high',load_status:'in_transit',cargo_weight_kg:8500,deliver_by:'2026-04-30T18:00:00',agreed_rate_rand:6200,driver_name:'Mokoena, K.',fleet_number:'TRK-004'},
    {load_ref:'LOAD-2204',client_name:'Massmart',origin_zone_name:'Depot A',dest_zone_name:'Client Y Polokwane',priority:'high',load_status:'queued',cargo_weight_kg:6000,deliver_by:'2026-05-01T10:00:00',agreed_rate_rand:5500,driver_name:null,fleet_number:null},
    {load_ref:'LOAD-2205',client_name:'Tiger Brands',origin_zone_name:'Depot B',dest_zone_name:'Client Z East London',priority:'medium',load_status:'queued',cargo_weight_kg:12000,deliver_by:'2026-05-02T12:00:00',agreed_rate_rand:7800,driver_name:null,fleet_number:null},
    {load_ref:'LOAD-2206',client_name:'Woolworths',origin_zone_name:'Depot A',dest_zone_name:'Depot C Durban',priority:'urgent',load_status:'queued',cargo_weight_kg:4200,deliver_by:'2026-04-30T16:00:00',agreed_rate_rand:4900,driver_name:null,fleet_number:null},
  ],
  alerts:[
    {severity:'critical',alert_type:'eta_compliance',message:'TRK-009 (Nkosi) overdue by 43 min — no geofence arrival at Depot B',fleet_number:'TRK-009',driver_name:'Nkosi, L.',alert_time:new Date().toISOString(),acknowledged:false},
    {severity:'warning',alert_type:'fuel_variance',message:'TRK-007 fuel 22% above benchmark — 28.4 L/100km vs 22 L/100km',fleet_number:'TRK-007',driver_name:'Pieterse, N.',alert_time:new Date(Date.now()-900000).toISOString(),acknowledged:false},
    {severity:'critical',alert_type:'signal_lost',message:'TRK-009 GPS signal lost at R14 Km 204 — 43 min ago',fleet_number:'TRK-009',driver_name:'Nkosi, L.',alert_time:new Date(Date.now()-2580000).toISOString(),acknowledged:false},
  ],
  audit:[
    {log_time:new Date().toISOString(),event_source:'geofence',event_type:'GEOFENCE_ENTRY',description:'TRK-011 entered Depot A'},
    {log_time:new Date(Date.now()-600000).toISOString(),event_source:'geofence',event_type:'TRIP_STARTED',description:'TRIP-2201 started — TRK-004 exited Depot A'},
    {log_time:new Date(Date.now()-1200000).toISOString(),event_source:'dispatch',event_type:'LOAD_ASSIGNED',description:'LOAD-2201 assigned to Mokoena K.'},
    {log_time:new Date(Date.now()-1800000).toISOString(),event_source:'geofence',event_type:'TRIP_COMPLETED',description:'TRIP-2197 completed at Depot C — 490 km'},
    {log_time:new Date(Date.now()-3600000).toISOString(),event_source:'payroll',event_type:'PAYROLL_CALCULATED',description:'April 2026 payroll — 10 drivers — R214,406'},
  ],
  payroll:[
    {full_name:'Mokoena, K.',driver_code:'DRV-001',employment_type:'owner_operator',trips_completed:18,gross_revenue_rand:24850,fuel_deduction_rand:4120,toll_deduction_rand:640,commission_pct:12,commission_rand:2982,bonus_rand:800,net_payout_rand:17908,status:'approved'},
    {full_name:'Dlamini, L.',driver_code:'DRV-002',employment_type:'owner_operator',trips_completed:21,gross_revenue_rand:29400,fuel_deduction_rand:5010,toll_deduction_rand:820,commission_pct:12,commission_rand:3528,bonus_rand:1200,net_payout_rand:21242,status:'calculated'},
    {full_name:'Pieterse, N.',driver_code:'DRV-003',employment_type:'employee',trips_completed:16,gross_revenue_rand:0,fuel_deduction_rand:0,toll_deduction_rand:0,commission_pct:0,commission_rand:0,bonus_rand:500,net_payout_rand:19000,status:'draft'},
    {full_name:'Vermeulen, S.',driver_code:'DRV-004',employment_type:'owner_operator',trips_completed:22,gross_revenue_rand:31200,fuel_deduction_rand:5800,toll_deduction_rand:900,commission_pct:12,commission_rand:3744,bonus_rand:1000,net_payout_rand:21756,status:'approved'},
  ],
  cpk:[
    {route_code:'RTE-A',route_name:'Jhb to Durban',origin:'Depot A',destination:'Client X',trips_count:22,total_distance_km:7524,actual_cpk_rand:5.72,target_cpk_rand:4.80,cpk_variance_pct:19.2,gross_margin_pct:42.1,on_time_pct:81,cpk_flagged:true},
    {route_code:'RTE-B',route_name:'Jhb to Cape Town',origin:'Depot A',destination:'Depot C',trips_count:15,total_distance_km:11250,actual_cpk_rand:3.98,target_cpk_rand:4.20,cpk_variance_pct:-5.2,gross_margin_pct:58.3,on_time_pct:93,cpk_flagged:false},
    {route_code:'RTE-C',route_name:'Pta to Polokwane',origin:'Depot B',destination:'Client Y',trips_count:30,total_distance_km:5100,actual_cpk_rand:3.40,target_cpk_rand:3.50,cpk_variance_pct:-2.9,gross_margin_pct:62.7,on_time_pct:97,cpk_flagged:false},
    {route_code:'RTE-D',route_name:'Jhb to East London',origin:'Depot A',destination:'Client Z',trips_count:18,total_distance_km:8820,actual_cpk_rand:4.56,target_cpk_rand:4.40,cpk_variance_pct:3.6,gross_margin_pct:51.2,on_time_pct:89,cpk_flagged:false},
    {route_code:'RTE-E',route_name:'Jhb to Klerksdorp',origin:'Depot B',destination:'Depot C',trips_count:25,total_distance_km:4750,actual_cpk_rand:3.78,target_cpk_rand:3.60,cpk_variance_pct:5.0,gross_margin_pct:55.8,on_time_pct:92,cpk_flagged:false},
  ],
  maintenance:[
    {fleet_number:'TRK-002',primary_driver:'Vermeulen, S.',service_name:'Engine Service',km_remaining:-480,days_remaining:-15,alert_status:'overdue',next_due_date:'2026-04-15',estimated_cost:4500},
    {fleet_number:'TRK-007',primary_driver:'Pieterse, N.',service_name:'Tyre Rotation',km_remaining:620,days_remaining:12,alert_status:'due_soon',next_due_date:'2026-05-12',estimated_cost:800},
    {fleet_number:'TRK-011',primary_driver:'Dlamini, L.',service_name:'Brake Inspection',km_remaining:1240,days_remaining:18,alert_status:'upcoming',next_due_date:'2026-05-18',estimated_cost:1500},
    {fleet_number:'TRK-004',primary_driver:'Mokoena, K.',service_name:'Oil Change',km_remaining:9520,days_remaining:32,alert_status:'ok',next_due_date:'2026-06-01',estimated_cost:1200},
  ],
  crosscheck:[
    {check_type:'eta_compliance',severity:'critical',passed:false,finding:'TRK-009 overdue by 43 min — no geofence arrival',recommendation:'Check last GPS ping. Escalate immediately.',acknowledged:false,check_time:new Date().toISOString()},
    {check_type:'fuel_variance',severity:'warning',passed:false,finding:'TRK-007 fuel 22% above benchmark',recommendation:'Check engine or route deviation on TRK-007',acknowledged:false,check_time:new Date(Date.now()-900000).toISOString()},
    {check_type:'dwell_time',severity:'warning',passed:false,finding:'TRK-011 in Client Y zone 94 min — threshold 60 min',recommendation:'Confirm with driver — possible delay',acknowledged:false,check_time:new Date(Date.now()-1800000).toISOString()},
    {check_type:'cpk_variance',severity:'warning',passed:false,finding:'Route A CPK R5.72 exceeds target R4.80 by 19.2%',recommendation:'Review fuel and loading on Jhb-Durban route',acknowledged:false,check_time:new Date(Date.now()-3600000).toISOString()},
  ],
};

const USERS=[
  {id:'1',username:'admin',password:'admin123',name:'System Administrator',role:'superadmin'},
  {id:'2',username:'manager',password:'manager123',name:'Fleet Manager',role:'manager'},
  {id:'3',username:'dispatcher',password:'dispatch123',name:'Dispatcher',role:'dispatcher'},
];
const sessions=new Map();
const mkToken=()=>Math.random().toString(36).slice(2)+Date.now().toString(36);

function send(res,data,status=200){
  const body=JSON.stringify(data,null,2);
  res.writeHead(status,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type,Authorization','Access-Control-Allow-Methods':'GET,POST,PUT,PATCH,DELETE,OPTIONS'});
  res.end(body);
}

function body(req){
  return new Promise(resolve=>{
    let d='';
    req.on('data',c=>d+=c);
    req.on('end',()=>{try{resolve(JSON.parse(d||'{}'))}catch(e){resolve({})}});
  });
}

const server=http.createServer(async(req,res)=>{
  if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type,Authorization','Access-Control-Allow-Methods':'GET,POST,PUT,PATCH,DELETE,OPTIONS'});return res.end();}
  const p=url.parse(req.url,true).pathname.replace(/\/$/,'')||'/';
  const m=req.method;
  log('debug',`${m} ${p}`);

  try{
    if(p==='/health') return send(res,{status:'healthy',service:'fleetos-api',version:'1.0.0',mode:'DEMO — no database needed',uptime:Math.floor(process.uptime()),timestamp:new Date().toISOString()});
    if(p==='/api'||p==='/'||p==='') return send(res,{service:'FleetOS API',version:'1.0.0',mode:'DEMO',tip:'Login: POST /api/auth/login with {"username":"admin","password":"admin123"}',endpoints:{auth:['POST /api/auth/login','GET /api/auth/me'],ops:['GET /api/ops/fleet','GET /api/ops/queue','GET /api/ops/loads','GET /api/ops/alerts','GET /api/ops/summary'],admin:['GET /api/admin/audit-log','POST /api/admin/payroll/calculate','GET /api/admin/paystub/1'],mgmt:['GET /api/mgmt/cpk','GET /api/mgmt/maintenance','GET /api/mgmt/crosscheck','GET /api/mgmt/dashboard-summary']}});

    // AUTH
    if(p==='/api/auth/login'&&m==='POST'){const b=await body(req);const u=USERS.find(x=>x.username===b.username&&x.password===b.password);if(!u)return send(res,{error:'Invalid credentials. Try: admin / admin123'},401);const t=mkToken();sessions.set(t,u);log('info','Login',{user:u.username});return send(res,{ok:true,token:t,user:{id:u.id,username:u.username,full_name:u.name,role:u.role}});}
    if(p==='/api/auth/me'){const t=(req.headers.authorization||'').replace('Bearer ','');const u=sessions.get(t);if(!u)return send(res,{error:'Not authenticated'},401);return send(res,{ok:true,user:u});}

    // OPS
    if(p==='/api/ops/fleet')   return send(res,{ok:true,data:DEMO.fleet,count:DEMO.fleet.length});
    if(p==='/api/ops/summary') return send(res,{ok:true,data:DEMO.summary});
    if(p==='/api/ops/queue')   return send(res,{ok:true,data:DEMO.queue});
    if(p==='/api/ops/loads')   return send(res,{ok:true,data:DEMO.loads});
    if(p==='/api/ops/alerts')  return send(res,{ok:true,data:DEMO.alerts,count:DEMO.alerts.length});
    if(p==='/api/ops/trips')   return send(res,{ok:true,data:[]});
    if(p==='/api/ops/checkin'&&m==='POST') return send(res,{ok:true,message:'Driver checked in (demo)'},201);
    if(p==='/api/ops/assign'&&m==='POST')  return send(res,{ok:true,message:'Load assigned (demo)'});

    // ADMIN
    if(p==='/api/admin/audit-log')            return send(res,{ok:true,data:DEMO.audit,count:DEMO.audit.length});
    if(p==='/api/admin/trip-costs')           return send(res,{ok:true,data:[]});
    if(p==='/api/admin/trip-costs'&&m==='POST') return send(res,{ok:true,message:'Costs saved (demo)'},201);
    if(p==='/api/admin/pay-periods')          return send(res,{ok:true,data:[{period_name:'April 2026',period_start:'2026-04-01',period_end:'2026-04-30',period_status:'open',driver_count:10,total_net_payout:214406}]});
    if(p==='/api/admin/payroll/calculate'&&m==='POST') return send(res,{ok:true,records_calculated:DEMO.payroll.length,data:DEMO.payroll});
    if(p.startsWith('/api/admin/paystub/'))   return send(res,{ok:true,paystub:{driver:'Mokoena, K.',period:'April 2026',gross:'R 24,850.00',fuel_deduction:'R 4,120.00',toll_deduction:'R 640.00',commission:'12% = R 2,982.00',bonus:'R 800.00',net_payout:'R 17,908.00',formula:'Gross − Fuel − Toll − Commission + Bonus = Net',status:'approved'}});
    if(p.startsWith('/api/admin/payroll/')&&!p.includes('calculate')) return send(res,{ok:true,data:DEMO.payroll});
    if(p.includes('/approve')&&m==='POST')    return send(res,{ok:true,message:'Approved'});

    // MGMT
    if(p==='/api/mgmt/cpk')        return send(res,{ok:true,fleet_avg_cpk:4.29,data:DEMO.cpk});
    if(p==='/api/mgmt/maintenance') return send(res,{ok:true,data:DEMO.maintenance,count:DEMO.maintenance.length});
    if(p==='/api/mgmt/crosscheck')  return send(res,{ok:true,data:DEMO.crosscheck,count:DEMO.crosscheck.length});
    if(p==='/api/mgmt/dashboard-summary') return send(res,{ok:true,data:{avg_cpk:4.29,routes_flagged:1,maintenance_critical:2,maintenance_due_soon:1,unacked_alerts:4,fleet_score:82}});
    if(p.includes('/acknowledge')&&m==='POST') return send(res,{ok:true,message:'Alert acknowledged'});
    if(p==='/api/mgmt/maintenance/schedule'&&m==='POST') return send(res,{ok:true,message:'Schedule updated (demo)'},201);
    if(p==='/api/mgmt/maintenance/complete'&&m==='POST') return send(res,{ok:true,message:'Service logged (demo)'});
    if(p==='/api/mgmt/route-performance/aggregate'&&m==='POST') return send(res,{ok:true,routes_aggregated:5});

    send(res,{error:`Not found: ${m} ${p}`,tip:'GET /api for all endpoints'},404);
  }catch(err){
    log('error','Unhandled',{error:err.message});
    send(res,{error:'Internal server error'},500);
  }
});

server.listen(PORT,()=>{
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║        FleetOS API Server — RUNNING              ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  http://localhost:3000/health                    ║');
  console.log('║  http://localhost:3000/api                       ║');
  console.log('║  Mode: DEMO (zero dependencies)                  ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  Login → POST /api/auth/login                    ║');
  console.log('║  { "username":"admin","password":"admin123" }     ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
});
process.on('SIGTERM',()=>{server.close();process.exit(0);});
process.on('SIGINT', ()=>{server.close();process.exit(0);});
