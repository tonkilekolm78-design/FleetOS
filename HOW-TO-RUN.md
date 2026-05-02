# FleetOS — How To Run

## OPTION A: Standalone (no setup needed)
Works immediately with zero dependencies:
```
node fleetos-standalone.js
```
Then open port 3000 in the browser.
Login: admin / admin123

## OPTION B: Full backend (requires npm install)
```
npm install
npm start
```
Set DATABASE_URL in .env for live database.

## Codespaces steps:
1. Upload this entire folder to your Codespaces workspace
2. Open terminal
3. Run: node fleetos-standalone.js
4. Click "Open in Browser" when port 3000 popup appears
