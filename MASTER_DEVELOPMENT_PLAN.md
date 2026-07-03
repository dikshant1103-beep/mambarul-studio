# MambaRUL Studio — Master Development Plan

## 1. Software Identity

**MambaRUL Studio** — Scientific Battery Intelligence Platform

A production-quality desktop application converting the MambaRUL thesis into an interactive scientific research and demonstration platform.

---

## 2. Repository Analysis Summary

### Models Implemented
| Model | Version | Architecture | Parameters |
|-------|---------|--------------|------------|
| MambaRUL | v1-v11 | Mamba SSM (4 blocks, d=256) + Degradation Anchor Attention | ~2.8M |
| TCNMambaRUL | Run 1-4 | TCN (3 blocks) + FiLM + Mamba SSM + Chemistry Heads | ~500K |
| LSTM Baseline | — | 2-layer LSTM + MLP head | ~300K |
| GRU Baseline | — | 2-layer GRU + MLP head | ~220K |
| Transformer | — | 4-head transformer + MLP | ~400K |
| BiLSTM | — | Bidirectional LSTM | ~480K |

### Datasets
| Dataset | Chemistry | Cells | Cycles | Status |
|---------|-----------|-------|--------|--------|
| CALCE CS2 | LCO | 6 (CS2_33–38) | 132–337 | Train/Val/Test |
| CALCE CX2 | LCO | 5 (CX2_16,33,36,37,38) | ~500 | Train/Val |
| MIT | LFP | 5 test cells | 395–1934 | Test only |
| KJTU | NMC | 5 test cells | ~400–550 | Test only |
| TJU | NCM | 3 test cells | 445–662 | Test only |
| Oxford | NMC | 8 cells (Cell1–8) | ~8000 | Train 1-6, Test 7-8 |
| NASA | LCO | B0005–B0007 | ~167 | Zero-shot eval |

### Feature Engineering (13 base features)
0. Capacity (Ah) — discharge capacity per cycle
1. Charge Time — CC-CV charge duration
2. Voltage Mean — mean discharge voltage
3. Voltage End — terminal discharge voltage
4. Energy (Wh) — discharge energy per cycle
5. Temperature — cell temperature during discharge
6. Cap. Slope — rolling capacity fade rate (5-cycle window)
7. Int. Resistance — internal resistance
8. Chem. Code — chemistry label (0=LCO, 1=LFP, 2=NMC, 3=NCM)
9. cap_pct (SOH) — capacity/initial_capacity (state of health proxy)
10. Delta Cap — cycle-to-cycle capacity change
11. Cum. Energy — normalized cumulative energy throughput
12. Delta IR — cycle-to-cycle resistance change

### Key Scientific Contributions
1. **Leakage Audit**: CumEnergy ↔ RUL correlation r=-1.000 (perfect leakage, excluded)
2. **Per-cell normalization**: Prevents cross-cell contamination
3. **Degradation Anchor Attention**: 3 learned anchors (fresh/knee/near-EOL)
4. **MAE Pretraining**: Masked Autoencoder for missing features
5. **Zero-shot transfer**: Oxford NMC R²=+0.911 without fine-tuning
6. **Multi-chemistry benchmark**: 5 chemistries, 17 test cells

### Best Results (v10-final)
| Chemistry | RMSE | R² | RMSE% |
|-----------|------|-----|-------|
| CALCE-LCO | 20.6 | +0.910 | 7.1% |
| MIT-LFP | 200.0 | +0.123 | 23.6% |
| KJTU-NMC | 39.2 | +0.854 | 8.8% |
| TJU-NCM | 60.2 | +0.660 | 12.3% |
| Oxford-NMC | 422.3 | +0.911 | 5.2% |

---

## 3. System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    ELECTRON DESKTOP SHELL                    │
├─────────────────────────────────────────────────────────────┤
│                      REACT FRONTEND                          │
│  Home │ Datasets │ Features │ Models │ Benchmark │ Predict  │
├─────────────────────────────────────────────────────────────┤
│                    REST/WebSocket API                         │
├─────────────────────────────────────────────────────────────┤
│                     FASTAPI BACKEND                          │
│  Datasets │ Features │ Models │ Results │ Leakage │ Predict │
├─────────────────────────────────────────────────────────────┤
│                       DATA LAYER                             │
│  NumPy (.npy) │ CSV metadata │ PyTorch checkpoints │ PNGs  │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Module Implementation Order

### Phase 1 — Backend Foundation
- [x] FastAPI app scaffold
- [x] Dataset router (metadata, cell lists, capacity curves)
- [x] Features router (feature definitions, importance data)
- [x] Results router (benchmark tables, per-chemistry)
- [x] Leakage router (audit data, correlations)
- [x] Models router (architecture metadata)
- [x] Prediction router (live inference)
- [x] SHAP router (importance arrays)

### Phase 2 — Frontend Foundation
- [x] React + Vite + TypeScript scaffold
- [x] Tailwind + dark theme
- [x] Navigation + Layout
- [x] API service layer

### Phase 3 — Page Implementations
- [x] Home / Landing (animated stats, hero section)
- [x] Dataset Explorer (chemistry cards, metadata)
- [x] Raw Signal Viewer (capacity curves, plotly)
- [x] Feature Engineering Engine (42-feature pipeline)
- [x] Leakage Audit Module
- [x] Model Gallery (architecture cards)
- [x] Universal Architecture Renderer (SVG-based)
- [x] Benchmark Comparison Dashboard
- [x] SHAP Explainability
- [x] Live Prediction System

---

## 5. Data Flow Architecture

```
Raw Datasets (CALCE/MIT/Oxford/...)
         ↓
  build_dataset.py → multi_dataset_features.npy
                    multi_dataset_meta.csv
                    multi_dataset_rul.npy
         ↓
  Backend Data Loader → pandas/numpy in memory
         ↓
  REST API (JSON) → React Frontend
         ↓
  Plotly Charts + SVG Architecture + Framer Motion
```

---

## 6. Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Desktop Shell | Electron 28 | Cross-platform desktop |
| Frontend Framework | React 18 + Vite | Fast SPA |
| Type System | TypeScript 5 | Type safety |
| Styling | Tailwind CSS 3 | Utility-first CSS |
| Animation | Framer Motion 11 | Page transitions, micro-animations |
| Charts | Plotly.js via react-plotly.js | Scientific charts |
| Architecture Viz | React SVG + custom renderer | Neural architecture diagrams |
| Backend | FastAPI 0.109 | Python REST API |
| ML Runtime | PyTorch 2.x | Model inference |
| Data | NumPy + Pandas | Array and tabular data |
| Server | Uvicorn | ASGI server |

---

## 7. Design System

- **Background**: #0a0e1a (near-black blue)
- **Surface**: #111827 (dark navy)
- **Panel**: #1a2233 (elevated surface)
- **Border**: #1e3a5f / #2563eb (electric blue borders)
- **Primary**: #3b82f6 (blue-500)
- **Accent**: #06b6d4 (cyan-500)
- **Success**: #10b981 (emerald-500)
- **Warning**: #f59e0b (amber-500)
- **Danger**: #ef4444 (red-500)
- **Text Primary**: #f1f5f9 (slate-100)
- **Text Secondary**: #94a3b8 (slate-400)
- **Font**: Inter (UI) + JetBrains Mono (code/metrics)
