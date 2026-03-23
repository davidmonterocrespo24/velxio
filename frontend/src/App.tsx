import { useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { LandingPage } from './pages/LandingPage';
import { EditorPage } from './pages/EditorPage';
import { ExamplesPage } from './pages/ExamplesPage';
import { DocsPage } from './pages/DocsPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { UserProfilePage } from './pages/UserProfilePage';
import { ProjectPage } from './pages/ProjectPage';
import { ProjectByIdPage } from './pages/ProjectByIdPage';
import { AdminPage } from './pages/AdminPage';
import { ArduinoSimulatorPage } from './pages/ArduinoSimulatorPage';
import { ArduinoEmulatorPage } from './pages/ArduinoEmulatorPage';
import { AtmegaSimulatorPage } from './pages/AtmegaSimulatorPage';
import { ArduinoMegaSimulatorPage } from './pages/ArduinoMegaSimulatorPage';
import { Esp32SimulatorPage } from './pages/Esp32SimulatorPage';
import { Esp32S3SimulatorPage } from './pages/Esp32S3SimulatorPage';
import { Esp32C3SimulatorPage } from './pages/Esp32C3SimulatorPage';
import { RaspberryPiPicoSimulatorPage } from './pages/RaspberryPiPicoSimulatorPage';
import { RaspberryPiSimulatorPage } from './pages/RaspberryPiSimulatorPage';
import { Velxio2Page } from './pages/Velxio2Page';
import { useAuthStore } from './store/useAuthStore';
import './App.css';

function App() {
  const checkSession = useAuthStore((s) => s.checkSession);

  useEffect(() => {
    checkSession();
  }, []);

  return (
    <Router>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/editor" element={<EditorPage />} />
        <Route path="/examples" element={<ExamplesPage />} />
        <Route path="/docs" element={<DocsPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/docs/:section" element={<DocsPage />} />
        {/* SEO landing pages — keyword-targeted */}
        <Route path="/arduino-simulator" element={<ArduinoSimulatorPage />} />
        <Route path="/arduino-emulator" element={<ArduinoEmulatorPage />} />
        <Route path="/atmega328p-simulator" element={<AtmegaSimulatorPage />} />
        <Route path="/arduino-mega-simulator" element={<ArduinoMegaSimulatorPage />} />
        <Route path="/esp32-simulator" element={<Esp32SimulatorPage />} />
        <Route path="/esp32-s3-simulator" element={<Esp32S3SimulatorPage />} />
        <Route path="/esp32-c3-simulator" element={<Esp32C3SimulatorPage />} />
        <Route path="/raspberry-pi-pico-simulator" element={<RaspberryPiPicoSimulatorPage />} />
        <Route path="/raspberry-pi-simulator" element={<RaspberryPiSimulatorPage />} />
        <Route path="/v2" element={<Velxio2Page />} />
        {/* Canonical project URL by ID */}
        <Route path="/project/:id" element={<ProjectByIdPage />} />
        {/* Legacy slug route — redirects to /project/:id */}
        <Route path="/:username/:projectName" element={<ProjectPage />} />
        <Route path="/:username" element={<UserProfilePage />} />
      </Routes>
    </Router>
  );
}

export default App;
