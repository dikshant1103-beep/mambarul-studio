import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AnimatePresence } from 'framer-motion'
import Layout from './components/Layout'
import Home from './pages/Home'
import FleetView from './pages/FleetView'
import DatasetExplorer from './pages/DatasetExplorer'
import FeatureEngineering from './pages/FeatureEngineering'
import FeatureGraphs from './pages/FeatureGraphs'
import LeakageAudit from './pages/LeakageAudit'
import ModelGallery from './pages/ModelGallery'
import ModelVersions from './pages/ModelVersions'
import BenchmarkDashboard from './pages/BenchmarkDashboard'
import LivePrediction from './pages/LivePrediction'
import Explainability from './pages/Explainability'
import ThesisExplorer from './pages/ThesisExplorer'
import RawSignalViewer from './pages/RawSignalViewer'
import PredictionsPage from './pages/PredictionsPage'
import TrainingAnimation from './pages/TrainingAnimation'
import TrainingPipeline from './pages/TrainingPipeline'
import AnalysisHub from './pages/AnalysisHub'
import ConformalPrediction from './pages/ConformalPrediction'
import BMSDashboard from './pages/BMSDashboard'
import KeyDiscoveries from './pages/KeyDiscoveries'
import PhysicsVisualizer from './pages/PhysicsVisualizer'
import ArchitectureInsights from './pages/ArchitectureInsights'
import UploadPredict from './pages/UploadPredict'
import CyclerImport from './pages/CyclerImport'
import CyclerQaDashboard from './pages/CyclerQaDashboard'
import CellDeepDive from './pages/CellDeepDive'
import APIKeys from './pages/APIKeys'
import BatchPredict from './pages/BatchPredict'
import Calibrate from './pages/Calibrate'
import Compare from './pages/Compare'
import Settings from './pages/Settings'
import Analytics from './pages/Analytics'
import AlertHistory from './pages/AlertHistory'
import AuthGate from './components/AuthGate'
import NeuronAnimation from './pages/NeuronAnimation'
import ChemistryExplorer from './pages/ChemistryExplorer'
import OxfordAnalysis from './pages/OxfordAnalysis'
import PyBaMM from './pages/PyBaMM'
import AblationStudy from './pages/AblationStudy'
import ExperimentReplay from './pages/ExperimentReplay'
import BatteryLab from './pages/BatteryLab'
import MAEVisualizer from './pages/MAEVisualizer'
import PerCellPredictions from './pages/PerCellPredictions'
import ChemistryMolecular from './pages/ChemistryMolecular'
import ModelRace from './pages/ModelRace'
import MultiCellOverlay from './pages/MultiCellOverlay'
import BatteryAgingSimulator from './pages/BatteryAgingSimulator'
import PCAExplorer from './pages/PCAExplorer'
import OxfordFineTune from './pages/OxfordFineTune'
import TrainingLogReplay from './pages/TrainingLogReplay'
import NASAZeroShot from './pages/NASAZeroShot'
import ConformalReal from './pages/ConformalReal'
import SHAPInteractive from './pages/SHAPInteractive'
import OxfordLOOCV from './pages/OxfordLOOCV'
import EarlyPrediction from './pages/EarlyPrediction'
import ErrorDistribution from './pages/ErrorDistribution'
import OxfordFewShot from './pages/OxfordFewShot'
import V11Results from './pages/V11Results'
import VersionLadderInteractive from './pages/VersionLadderInteractive'
import SideBySide from './pages/SideBySide'
import TCNReceptiveField from './pages/TCNReceptiveField'
import TTADemo from './pages/TTADemo'
import OODAnalysis from './pages/OODAnalysis'
import DVACurves from './pages/DVACurves'
import PackPredict from './pages/PackPredict'
import FineTune from './pages/FineTune'
import Experiments from './pages/Experiments'
import CustomerHub from './pages/CustomerHub'
import BMSLive     from './pages/BMSLive'
import BMSSafety   from './pages/BMSSafety'
import BMSControl  from './pages/BMSControl'
import BMSAdapters    from './pages/BMSAdapters'
import BMSValidation  from './pages/BMSValidation'
import SecondLife      from './pages/SecondLife'
import BatteryGrading    from './pages/BatteryGrading'
import WeakCellAnalysis  from './pages/WeakCellAnalysis'
import WarrantyIntelligence from './pages/WarrantyIntelligence'
import AnomalyDetector   from './pages/AnomalyDetector'
import ICAnalysis      from './pages/ICAnalysis'
import DigitalTwin     from './pages/DigitalTwin'
import OnlineLearning  from './pages/OnlineLearning'
import ThermalCoupling from './pages/ThermalCoupling'
import ThermalRunaway  from './pages/ThermalRunaway'
import ThermalTwin     from './pages/ThermalTwin'
import PhaseCResearch  from './pages/PhaseCResearch'
import Notifications   from './pages/Notifications'

export default function App() {
  return (
    <BrowserRouter>
      <AuthGate>
      <AnimatePresence mode="wait">
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<Home />} />
            <Route path="fleet" element={<FleetView />} />
            <Route path="datasets" element={<DatasetExplorer />} />
            <Route path="features" element={<FeatureEngineering />} />
            <Route path="feature-graphs" element={<FeatureGraphs />} />
            <Route path="leakage" element={<LeakageAudit />} />
            <Route path="models" element={<ModelGallery />} />
            <Route path="model-versions" element={<ModelVersions />} />
            <Route path="benchmark" element={<BenchmarkDashboard />} />
            <Route path="predict" element={<LivePrediction />} />
            <Route path="explainability" element={<Explainability />} />
            <Route path="thesis" element={<ThesisExplorer />} />
            <Route path="raw-signals" element={<RawSignalViewer />} />
            <Route path="predictions" element={<PredictionsPage />} />
            <Route path="training" element={<TrainingPipeline />} />
            <Route path="training-log" element={<TrainingAnimation />} />
            <Route path="analysis" element={<AnalysisHub />} />
            <Route path="conformal" element={<ConformalPrediction />} />
            <Route path="chemistry" element={<ChemistryExplorer />} />
            <Route path="oxford" element={<OxfordAnalysis />} />
            <Route path="pybamm" element={<PyBaMM />} />
            <Route path="ablation" element={<AblationStudy />} />
            <Route path="bms" element={<BMSDashboard />} />
              <Route path="bms/live"     element={<BMSLive />} />
              <Route path="bms/safety"   element={<BMSSafety />} />
              <Route path="bms/control"  element={<BMSControl />} />
              <Route path="bms/adapters"   element={<BMSAdapters />} />
              <Route path="bms/validation" element={<BMSValidation />} />
            <Route path="discoveries" element={<KeyDiscoveries />} />
            <Route path="physics" element={<PhysicsVisualizer />} />
            <Route path="architecture" element={<ArchitectureInsights />} />
            <Route path="upload" element={<UploadPredict />} />
            <Route path="cycler-import" element={<CyclerImport />} />
            <Route path="cycler-qa"     element={<CyclerQaDashboard />} />
            <Route path="cell/:cellId" element={<CellDeepDive />} />
            <Route path="keys" element={<APIKeys />} />
            <Route path="batch" element={<BatchPredict />} />
            <Route path="calibrate" element={<Calibrate />} />
            <Route path="compare-models" element={<Compare />} />
            <Route path="settings" element={<Settings />} />
            <Route path="analytics" element={<Analytics />} />
            <Route path="alerts" element={<AlertHistory />} />
            <Route path="neuron" element={<NeuronAnimation />} />
            <Route path="experiment-replay" element={<ExperimentReplay />} />
            <Route path="battery-lab" element={<BatteryLab />} />
            <Route path="mae" element={<MAEVisualizer />} />
            <Route path="per-cell" element={<PerCellPredictions />} />
            <Route path="chemistry-3d" element={<ChemistryMolecular />} />
            <Route path="model-race" element={<ModelRace />} />
            <Route path="multi-cell" element={<MultiCellOverlay />} />
            <Route path="aging-sim" element={<BatteryAgingSimulator />} />
            <Route path="pca" element={<PCAExplorer />} />
            <Route path="oxford-finetune" element={<OxfordFineTune />} />
            <Route path="training-real" element={<TrainingLogReplay />} />
            <Route path="nasa" element={<NASAZeroShot />} />
            <Route path="conformal-real" element={<ConformalReal />} />
            <Route path="shap-real" element={<SHAPInteractive />} />
            <Route path="oxford-loocv" element={<OxfordLOOCV />} />
            <Route path="early-pred" element={<EarlyPrediction />} />
            <Route path="error-dist" element={<ErrorDistribution />} />
            <Route path="oxford-fewshot" element={<OxfordFewShot />} />
            <Route path="v11" element={<V11Results />} />
            <Route path="version-ladder" element={<VersionLadderInteractive />} />
            <Route path="compare" element={<SideBySide />} />
            <Route path="tcn-rf" element={<TCNReceptiveField />} />
            <Route path="tta-demo" element={<TTADemo />} />
            <Route path="ood-analysis" element={<OODAnalysis />} />
            <Route path="dva-curves" element={<DVACurves />} />
            <Route path="pack" element={<PackPredict />} />
            <Route path="finetune" element={<FineTune />} />
            <Route path="experiments" element={<Experiments />} />
            <Route path="customers"    element={<CustomerHub />} />
            <Route path="second-life"  element={<SecondLife />} />
            <Route path="grade"        element={<BatteryGrading />} />
            <Route path="weak-cell"    element={<WeakCellAnalysis />} />
            <Route path="warranty"     element={<WarrantyIntelligence />} />
            <Route path="online-learning"  element={<OnlineLearning />} />
            <Route path="thermal-coupling" element={<ThermalCoupling />} />
            <Route path="thermal-runaway"  element={<ThermalRunaway />} />
            <Route path="thermal-twin"     element={<ThermalTwin />} />
            <Route path="phase-c"          element={<PhaseCResearch />} />
            <Route path="notifications"    element={<Notifications />} />
            <Route path="anomaly"      element={<AnomalyDetector />} />
            <Route path="ic-analysis"  element={<ICAnalysis />} />
            <Route path="digital-twin" element={<DigitalTwin />} />
          </Route>
        </Routes>
      </AnimatePresence>
      </AuthGate>
    </BrowserRouter>
  )
}
