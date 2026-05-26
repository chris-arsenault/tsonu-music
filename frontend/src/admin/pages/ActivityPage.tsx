import { navigateTo } from '../../music/routes';
import { EncodingJobsFeed } from '../activity/EncodingJobsFeed';
import { MaintenancePanel } from '../activity/MaintenancePanel';
import { RumDashboard } from '../activity/RumDashboard';

type View = 'encoding' | 'stats' | 'maintenance';

interface Props {
    view: View;
    onNavigateSong: (songId: string) => void;
}

export function ActivityPage({ view, onNavigateSong }: Props) {
    function setView(next: View) {
        navigateTo(next === 'encoding' ? '/admin/activity' : `/admin/activity/${next}`);
    }

    return (
        <div className="admin-page">
            <nav className="admin-segmented" aria-label="Activity views">
                <button type="button" className={view === 'encoding' ? 'is-active' : ''} onClick={() => setView('encoding')}>
                    Encoding jobs
                </button>
                <button type="button" className={view === 'stats' ? 'is-active' : ''} onClick={() => setView('stats')}>
                    Playback stats
                </button>
                <button type="button" className={view === 'maintenance' ? 'is-active' : ''} onClick={() => setView('maintenance')}>
                    Cleanup
                </button>
            </nav>

            {view === 'encoding' ? <EncodingJobsFeed onNavigateSong={onNavigateSong} /> : null}
            {view === 'stats' ? <RumDashboard /> : null}
            {view === 'maintenance' ? <MaintenancePanel /> : null}
        </div>
    );
}
