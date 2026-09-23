import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { RequireSession } from './session';
import { LoginPage } from './pages/LoginPage';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { ConnectionPage } from './pages/ConnectionPage';
import { ApiKeysPage } from './pages/ApiKeysPage';
import { TestPanelPage } from './pages/TestPanelPage';
import { ActivityPage } from './pages/ActivityPage';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireSession>
            <Layout />
          </RequireSession>
        }
      >
        <Route index element={<Navigate to="/connections" replace />} />
        <Route path="connections" element={<ConnectionsPage />} />
        <Route path="connections/:id" element={<ConnectionPage />} />
        <Route path="api-keys" element={<ApiKeysPage />} />
        <Route path="test" element={<TestPanelPage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="*" element={<p>Page not found.</p>} />
      </Route>
    </Routes>
  );
}
