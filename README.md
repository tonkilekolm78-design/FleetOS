# FleetOS Backend — Deployment Guide

## Architecture Overview

```
Teltonika GPS Device (in truck)
         │ TCP CODEC 8
         ▼
┌─────────────────────┐      ┌─────────────────────────┐
│  fleetos-gps        │      │  fleetos-api             │
│  Background Worker  │─────▶│  Web Service (Express)   │
│  (TCP Listener +    │      │  Port 3000               │
│   Geofence Engine)  │      │  /api/ops                │
└─────────────────────┘      │  /api/admin              │
         │                   │  /api/mgmt               │
         ▼                   │  /api/auth               │
┌─────────────────────────────────────────────────────┐
│         fleetos-db  (PostgreSQL 16 on Render)        │
│         23 tables · triggers · views · indexes       │
└─────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────┐
│  Cloudflare (CDN + SSL + DDoS protection)           │
│  fleetos.co.za  ──▶  frontend HTML/CSS/JS           │
└─────────────────────────────────────────────────────┘
```

---

## Step 1 — Prerequisites

- GitHub account (push this code to a private repo)
- Render account at render.com
- Cloudflare account (free tier is fine)
- Your domain name (e.g. fleetos.co.za)
- Teltonika FMB920 or FMB140 devices in trucks

---

## Step 2 — Database Setup on Render

1. Log into render.com → New → PostgreSQL
2. Name: `fleetos-db`
3. Plan: Starter (upgrade later)
4. Region: Oregon (or Frankfurt)
5. Click **Create Database**
6. Copy the **External Connection String** — you will need it
7. Open the **Database Shell** in Render dashboard
8. Run the schema:
   ```
   \i fleetos_schema.sql
   ```
   Or paste the entire contents of `fleetos_schema.sql` into the shell

---

## Step 3 — Deploy the API Server

1. Push this entire folder to a GitHub repo (make it private)
2. In Render → New → Web Service
3. Connect your GitHub repo
4. Settings:
   - **Name:** `fleetos-api`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/health`
5. Add Environment Variables (from the list in `.env.example`):
   - `DATABASE_URL` = paste your Render connection string
   - `DB_SSL` = `true`
   - `JWT_SECRET` = click "Generate" in Render for a secure value
   - `ALLOWED_ORIGINS` = `https://fleetos.co.za,https://www.fleetos.co.za`
   - All others from `.env.example`
6. Click **Deploy**
7. Test: visit `https://fleetos-api.onrender.com/health`

---

## Step 4 — Deploy the GPS Listener

> ⚠️ The GPS listener needs a TCP port open — Render Background Workers
> support this. You will also need to configure your network/firewall
> to forward port 8080 to the Render service.

1. In Render → New → Background Worker
2. Connect same GitHub repo
3. Settings:
   - **Name:** `fleetos-gps`
   - **Start Command:** `npm run gps`
4. Add Environment Variables (same DATABASE_URL, plus GPS-specific ones)
5. Deploy

**Configure Teltonika devices:**
- Open Teltonika Configurator
- GPRS → Server Settings:
  - Server IP: your Render service IP (check Render dashboard)
  - Server Port: `8080`
  - Protocol: TCP
  - Codec: CODEC 8
- Set Record interval: 30 seconds (when moving), 60 seconds (stationary)

---

## Step 5 — Deploy the Frontend to Cloudflare

1. Log into Cloudflare dashboard
2. Add your domain (fleetos.co.za)
3. Update your domain registrar's nameservers to Cloudflare's
4. In Cloudflare → Pages → Create a project
5. Upload the `FleetOS-App.html` file (or connect your repo)
6. Set custom domain: `fleetos.co.za`
7. Cloudflare handles SSL automatically

**Update the frontend to point to your API:**
In `FleetOS-App.html`, find:
```javascript
const API_BASE = 'https://fleetos-api.onrender.com';
```
And replace with your actual API URL.

---

## Step 6 — Connect Frontend to Live API

The frontend currently uses mock data. To wire it to the backend,
each form submission should call:

```javascript
// Example: fetch driver queue
const response = await fetch(`${API_BASE}/api/ops/queue`, {
  headers: { 'Authorization': `Bearer ${token}` }
});
const data = await response.json();
```

The login flow:
```javascript
const loginRes = await fetch(`${API_BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username, password })
});
const { token, user } = await loginRes.json();
localStorage.setItem('fleetos_token', token);
```

---

## Default Login (change immediately after first deploy)

```
Username: admin
Password: ChangeMe123!
```

Change via: `POST /api/auth/change-password`

---

## API Quick Reference

| Engine          | Endpoint                          | Method | Description                  |
|-----------------|-----------------------------------|--------|------------------------------|
| Auth            | `/api/auth/login`                 | POST   | Get JWT token                |
| Auth            | `/api/auth/me`                    | GET    | Current user                 |
| Operations      | `/api/ops/fleet`                  | GET    | Live fleet map data          |
| Operations      | `/api/ops/queue`                  | GET    | Driver queue                 |
| Operations      | `/api/ops/loads`                  | GET    | Load queue                   |
| Operations      | `/api/ops/assign`                 | POST   | Assign load to driver        |
| Operations      | `/api/ops/auto-match/:load_id`    | GET    | Smart driver matching        |
| Operations      | `/api/ops/alerts`                 | GET    | Live alerts                  |
| Administration  | `/api/admin/audit-log`            | GET    | Geofence audit trail         |
| Administration  | `/api/admin/trip-costs`           | POST   | Save trip costs              |
| Administration  | `/api/admin/payroll/calculate`    | POST   | Run payroll calculation      |
| Administration  | `/api/admin/paystub/:id`          | GET    | Download pay stub PDF        |
| Management      | `/api/mgmt/cpk`                   | GET    | Cost-per-KM by route         |
| Management      | `/api/mgmt/maintenance`           | GET    | Maintenance alerts           |
| Management      | `/api/mgmt/crosscheck`            | GET    | Expected vs actual results   |
| Management      | `/api/mgmt/dashboard-summary`     | GET    | Management KPI strip         |
| System          | `/health`                         | GET    | Server + DB health check     |

---

## Maintenance

- **Render logs:** Dashboard → your service → Logs tab
- **DB backups:** Render auto-backs up PostgreSQL daily on paid plans
- **GPS offline?** Check Background Worker logs for TCP errors
- **Add new zone:** `INSERT INTO zones ...` in the DB shell, geofence cache refreshes in 5 min
- **Add new vehicle:** Insert into `vehicles` table with `tracker_imei` matching the device

---

## File Structure

```
fleetos-backend/
├── src/
│   ├── server.js              ← Main API server (start here)
│   ├── config/
│   │   └── database.js        ← PostgreSQL connection pool
│   ├── utils/
│   │   └── logger.js          ← Winston logger
│   ├── api/
│   │   ├── middleware/
│   │   │   └── auth.js        ← JWT authentication
│   │   └── routes/
│   │       ├── auth.js        ← Login endpoints
│   │       ├── operations.js  ← Operations Engine API
│   │       ├── administration.js ← Admin Engine + PDF
│   │       └── management.js  ← Management Engine API
│   ├── gps/
│   │   └── tcp-listener.js    ← Teltonika CODEC 8 decoder
│   ├── geofence/
│   │   └── engine.js          ← Zone crossing detection
│   └── crosscheck/
│       └── engine.js          ← Expected vs actual checks
├── render.yaml                ← Render deployment config
├── package.json
└── .env.example               ← Copy to .env for local dev
```
