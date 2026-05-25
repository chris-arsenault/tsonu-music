import { useState } from 'react';
import { EncodingJobsFeed } from '../activity/EncodingJobsFeed';
import { RumDashboard } from '../activity/RumDashboard';

type View = 'encoding' | 'stats';

interface Props {
    initialView?: View;
    onNavigateSong: (songId: string) => void;
}

export function ActivityPage({ initialView = 'encoding', onNavigateSong }: Props) {
    const [view, setView] = useState<View>(initialView);

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
