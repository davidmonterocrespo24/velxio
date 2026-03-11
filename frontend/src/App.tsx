import { useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { LandingPage } from './pages/LandingPage';
import { EditorPage } from './pages/EditorPage';
import { ExamplesPage } from './pages/ExamplesPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { UserProfilePage } from './pages/UserProfilePage';
import { ProjectPage } from './pages/ProjectPage';
import { ProjectByIdPage } from './pages/ProjectByIdPage';
import { AdminPage } from './pages/AdminPage';
import { DocsPage } from './pages/DocsPage';
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
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/docs" element={<DocsPage />} />
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
