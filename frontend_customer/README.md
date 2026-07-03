# BatteryOS — Operator Edition

The customer-facing Electron desktop app of the [MambaRUL Studio platform](../README.md):
real-time SOH monitoring, per-cell RUL countdowns with conformal intervals,
degradation heatmaps, second-life grading, BMS safety alerts, and pack analytics.

It talks to the same FastAPI backend as the Studio app (`../backend`, port 8000)
— run that first (`bash ../start_backend.sh`).

```bash
npm install
npm run dev        # Vite dev server + Electron window
npm run dist       # build the BatteryOS AppImage into ../dist
```

Login uses the local demo admin seeded by the backend. Everything runs locally;
see [`../ARCHITECTURE.md`](../ARCHITECTURE.md) for the honest scope notes.
