import { navigateTo } from '../../music/routes';
import { EncodingJobsFeed } from '../activity/EncodingJobsFeed';
import { RumDashboard } from '../activity/RumDashboard';

type View = 'encoding' | 'stats';

interface Props {
    view: View;
    onNavigateSong: (songId: string) => void;
}

export function ActivityPage({ view, onNavigateSong }: Props) {
    function setView(next: View) {
        navigateTo(next === 'stats' ? '/admin/activity/stats' : '/admin/activity');
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
            </nav>

            {view === 'encoding' ? <EncodingJobsFeed onNavigateSong={onNavigateSong} /> : <RumDashboard />}
        </div>
    );
}
