import { useEffect, useMemo } from 'react';
import { Activity, House, ListMusic, LogOut, Music2 } from 'lucide-react';
import { getRuntimeConfig } from '../runtime-config';
import { useAuth } from '../use-auth';
import { handleInternalLink, navigateTo, useCurrentRoute } from '../music/routes';
import { buildAdminPath, parseAdminRoute } from './admin-routes';
import { CatalogProvider, useCatalog, useCatalogBootstrap } from './catalog-store';
import { NotificationProvider } from './notifications';
import { ActivityPage } from './pages/ActivityPage';
import { ReleasesPage } from './pages/ReleasesPage';
import { SongsPage } from './pages/SongsPage';
import { ErrorBoundary } from './shared/ErrorBoundary';
import { ToastRegion } from './shared/ToastRegion';
import './AdminApp.css';

function AdminShellInner() {
    const { signOut } = useAuth();
    const route = useCurrentRoute();
    const runtimeConfig = useMemo(() => getRuntimeConfig(), []);
    const { listsLoading } = useCatalog();
    useCatalogBootstrap();

    const parsed = useMemo(() => parseAdminRoute(route), [route]);

    // Redirect legacy /admin/publish to /admin/releases
    useEffect(() => {
        const pathname = route.split(/[?#]/)[0];
        if (pathname.startsWith('/admin/publish')) {
            navigateTo('/admin/releases');
        }
    }, [route]);

    function setSelectedReleaseId(id: string | undefined) {
        navigateTo(buildAdminPath('releases', id));
    }
    function setSelectedSongId(id: string | undefined) {
        navigateTo(buildAdminPath('songs', id));
    }

    return (
        <div className="admin-shell">
            <header className="admin-topbar">
                <div>
                    <p className="admin-kicker">Catalog Operations</p>
                    <h1>Tsonu Streaming Admin</h1>
                </div>
                <div className="admin-topbar__actions">
                    <div className="admin-topbar__meta">
                        <span>{runtimeConfig.adminApiBaseUrl}</span>
                        {listsLoading ? <span className="admin-busy">Loading…</span> : null}
                    </div>
                    <a className="admin-button" href="/" onClick={(event) => handleInternalLink(event, '/')}>
                        <House aria-hidden="true" /> Site
                    </a>
                    <button className="admin-icon-button" type="button" title="Sign out" onClick={signOut}>
                        <LogOut aria-hidden="true" />
                    </button>
                </div>
            </header>

            <nav className="admin-nav" aria-label="Admin sections">
                <a
                    href="/admin/releases"
                    onClick={(event) => handleInternalLink(event, '/admin/releases')}
                    className={parsed.section === 'releases' ? 'active' : undefined}
                >
                    <ListMusic aria-hidden="true" /> Releases
                </a>
                <a
                    href="/admin/songs"
                    onClick={(event) => handleInternalLink(event, '/admin/songs')}
                    className={parsed.section === 'songs' ? 'active' : undefined}
                >
                    <Music2 aria-hidden="true" /> Songs
                </a>
                <a
                    href="/admin/activity"
                    onClick={(event) => handleInternalLink(event, '/admin/activity')}
                    className={parsed.section === 'activity' ? 'active' : undefined}
                >
                    <Activity aria-hidden="true" /> Activity
                </a>
            </nav>

            <main className="admin-main">
                {parsed.section === 'releases' ? (
                    <ReleasesPage
                        selectedReleaseId={parsed.selectedId}
                        onSelectionChange={setSelectedReleaseId}
                    />
                ) : null}
                {parsed.section === 'songs' ? (
                    <SongsPage
                        selectedSongId={parsed.selectedId}
                        onSelectionChange={setSelectedSongId}
                        onNavigateRelease={setSelectedReleaseId}
                    />
                ) : null}
                {parsed.section === 'activity' ? (
                    <ActivityPage
                        view={parsed.subview === 'stats' || parsed.subview === 'maintenance' ? parsed.subview : 'encoding'}
                        onNavigateSong={setSelectedSongId}
                    />
                ) : null}
            </main>

            <ToastRegion />
        </div>
    );
}

export default function AdminApp() {
    return (
        <ErrorBoundary>
            <NotificationProvider>
                <CatalogProvider>
                    <AdminShellInner />
                </CatalogProvider>
            </NotificationProvider>
        </ErrorBoundary>
    );
}
