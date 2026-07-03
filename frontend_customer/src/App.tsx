import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AnimatePresence } from 'framer-motion'
import Layout           from './components/Layout'
import AuthGate         from './components/AuthGate'
import LicenseGate      from './components/LicenseGate'
import { ErrorBoundary } from './components/ErrorBoundary'
// Predict
import Home             from './pages/Home'
import LivePrediction   from './pages/LivePrediction'
import PackPredict      from './pages/PackPredict'
import BatchPredict     from './pages/BatchPredict'
import UploadPredict    from './pages/UploadPredict'
import CyclerImport     from './pages/CyclerImport'
import CyclerQaDashboard from './pages/CyclerQaDashboard'
// BMS Hardware
import BMSLive          from './pages/BMSLive'
import BMSSafety        from './pages/BMSSafety'
import BMSControl       from './pages/BMSControl'
import BMSAdapters      from './pages/BMSAdapters'
import BMSValidation    from './pages/BMSValidation'
// Fleet
import FleetView        from './pages/FleetView'
import AlertHistory     from './pages/AlertHistory'
import AnomalyDetector  from './pages/AnomalyDetector'
// Battery Intelligence
import DigitalTwin      from './pages/DigitalTwin'
import SecondLife       from './pages/SecondLife'
import BatteryGrading    from './pages/BatteryGrading'
import WeakCellAnalysis  from './pages/WeakCellAnalysis'
import WarrantyIntelligence from './pages/WarrantyIntelligence'
import Calibrate         from './pages/Calibrate'
import OnlineLearning    from './pages/OnlineLearning'
import ThermalCoupling   from './pages/ThermalCoupling'
import ThermalRunaway    from './pages/ThermalRunaway'
import InternalStateValidation from './pages/InternalStateValidation'
// Account
import Analytics        from './pages/Analytics'
import APIKeys          from './pages/APIKeys'
import Settings         from './pages/Settings'

export default function App() {
  return (
    <BrowserRouter>
      <ErrorBoundary label="Application">
      <LicenseGate>
        <AuthGate>
          <AnimatePresence mode="wait">
            <Routes>
              <Route path="/" element={<Layout />}>
                {/* Predict */}
                <Route index                 element={<Home />} />
                <Route path="predict"        element={<LivePrediction />} />
                <Route path="pack"           element={<PackPredict />} />
                <Route path="batch"          element={<BatchPredict />} />
                <Route path="upload"         element={<UploadPredict />} />
                <Route path="cycler-import"  element={<CyclerImport />} />
                <Route path="cycler-qa"      element={<CyclerQaDashboard />} />
                {/* BMS Hardware */}
                <Route path="bms/live"       element={<BMSLive />} />
                <Route path="bms/safety"     element={<BMSSafety />} />
                <Route path="bms/control"    element={<BMSControl />} />
                <Route path="bms/adapters"   element={<BMSAdapters />} />
                <Route path="bms/validation" element={<BMSValidation />} />
                {/* Fleet */}
                <Route path="fleet"          element={<FleetView />} />
                <Route path="alerts"         element={<AlertHistory />} />
                <Route path="anomaly"        element={<AnomalyDetector />} />
                {/* Battery Intelligence */}
                <Route path="digital-twin"   element={<DigitalTwin />} />
                <Route path="second-life"    element={<SecondLife />} />
                <Route path="grade"          element={<BatteryGrading />} />
                <Route path="weak-cell"      element={<WeakCellAnalysis />} />
                <Route path="warranty"       element={<WarrantyIntelligence />} />
                <Route path="calibrate"      element={<Calibrate />} />
                <Route path="online-learning"  element={<OnlineLearning />} />
                <Route path="thermal-coupling" element={<ThermalCoupling />} />
                <Route path="thermal-runaway"  element={<ThermalRunaway />} />
                <Route path="internal-state-validation" element={<InternalStateValidation />} />
                {/* Account */}
                <Route path="analytics"      element={<Analytics />} />
                <Route path="keys"           element={<APIKeys />} />
                <Route path="settings"       element={<Settings />} />
              </Route>
            </Routes>
          </AnimatePresence>
        </AuthGate>
      </LicenseGate>
      </ErrorBoundary>
    </BrowserRouter>
  )
}
