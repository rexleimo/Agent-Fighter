import { useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from './lib/api';
import { Sprite } from './components/Sprite';
import { TopBar } from './components/TopBar';
import { Footer } from './components/Footer';
import { AccountLayout } from './pages/account/AccountLayout';
import { OverviewPage } from './pages/account/OverviewPage';
import { AgentPage } from './pages/account/AgentPage';
import { MatchesPage } from './pages/account/MatchesPage';
import { AccessPage } from './pages/account/AccessPage';
import { SecurityPage } from './pages/account/SecurityPage';
import { AdminPage } from './pages/account/AdminPage';
import { GuidePage } from './pages/GuidePage';
import { LibraryPage } from './pages/LibraryPage';
import { LobbyPage } from './pages/LobbyPage';
import { BoardPage } from './pages/BoardPage';
import { FightersPage } from './pages/FightersPage';
import { ConnectPage } from './pages/ConnectPage';
import { LivePage } from './pages/LivePage';
import { ReplayPage } from './pages/ReplayPage';
import { TrainingPage } from './pages/TrainingPage';
import { SetupPage } from './pages/SetupPage';

const VIEW_TO_PATH: Record<string, string> = {
  lobby: '/lobby',
  fighters: '/fighters',
  board: '/board',
  replay: '/replay',
  training: '/training',
  connect: '/connect',
  account: '/account',
  guide: '/guide',
  library: '/library',
};

function Page({ id, children }: { id: string; children: ReactNode }) {
  return <section className="view active" id={id}>{children}</section>;
}

function RootRoute() {
  const [params] = useSearchParams();
  const view = params.get('view');
  if (view && view !== 'live') {
    return <Navigate to={VIEW_TO_PATH[view] ?? '/'} replace />;
  }
  return <Page id="view-live"><LivePage /></Page>;
}

/** First-run guidance: while no admin exists, every page leads to /setup. */
function SetupRedirect() {
  const navigate = useNavigate();
  const location = useLocation();
  const statusQuery = useQuery({
    queryKey: ['setup-status'],
    queryFn: () => api<{ needsSetup: boolean }>('/api/setup/status'),
    retry: false,
    staleTime: 30_000,
  });
  const needsSetup = statusQuery.data?.needsSetup ?? false;
  useEffect(() => {
    if (needsSetup && location.pathname !== '/setup') {
      navigate('/setup', { replace: true });
    }
  }, [needsSetup, location.pathname, navigate]);
  return null;
}

export function App() {
  return (
    <>
      <Sprite />
      <TopBar />
      <SetupRedirect />
      <main>
        <Routes>
          <Route path="/" element={<RootRoute />} />
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/lobby" element={<Page id="view-lobby"><LobbyPage /></Page>} />
          <Route path="/fighters" element={<Page id="view-fighters"><FightersPage /></Page>} />
          <Route path="/board" element={<Page id="view-board"><BoardPage /></Page>} />
          <Route path="/replay" element={<Page id="view-replay"><ReplayPage /></Page>} />
          <Route path="/training" element={<Page id="view-training"><TrainingPage /></Page>} />
          <Route path="/connect" element={<Page id="view-connect"><ConnectPage /></Page>} />
          <Route path="/account" element={<Navigate to="/me" replace />} />
          <Route path="/me" element={<AccountLayout />}>
            <Route index element={<OverviewPage />} />
            <Route path="agent" element={<AgentPage />} />
            <Route path="matches" element={<MatchesPage />} />
            <Route path="access" element={<AccessPage />} />
            <Route path="security" element={<SecurityPage />} />
            <Route path="admin" element={<AdminPage />} />
          </Route>
          <Route path="/guide" element={<GuidePage />} />
          <Route path="/library" element={<Page id="view-library"><LibraryPage /></Page>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <Footer />
    </>
  );
}
