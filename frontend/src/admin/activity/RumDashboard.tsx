import { Activity } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getRumSummary } from '../admin-api';
import { formatCount, formatPercent } from '../admin-helpers';
import type { RumSummary } from '../admin-types';
import { useBusy } from '../shared/useBusy';

export function RumDashboard() {
    const { busy, run } = useBusy();
    const [hours, setHours] = useState(24);
    const [summary, setSummary] = useState<RumSummary>();

    async function refresh() {
        await run('Loading RUM stats', async () => {
            const next = await getRumSummary(hours);
            setSummary(next);
        });
    }

    useEffect(() => {
        void refresh();
    }, []);

    return (
        <div className="admin-rum">
            <header className="admin-activity__header">
                <div>
                    <p className="admin-kicker">Insight</p>
                    <h2>Playback stats</h2>
                </div>
                <div className="admin-button-row">
                    <div className="admin-field">
                        <label>Window (hours)</label>
                        <input type="number" min={1} max={720} value={hours} onChange={(event) => setHours(Number(event.currentTarget.value))} />
                    </div>
                    <button type="button" className="admin-button" onClick={() => void refresh()} disabled={Boolean(busy)}>
                        <Activity aria-hidden="true" /> {busy ?? 'Refresh'}
                    </button>
                </div>
            </header>

            {summary ? (
                <>
                    <div className="admin-metrics">
                        <div><span>Visits</span><strong>{formatCount(summary.visits)}</strong></div>
                        <div><span>Page views</span><strong>{formatCount(summary.pageViews)}</strong></div>
                        <div><span>Bounce</span><strong>{formatPercent(summary.bounceRate)}</strong></div>
                        <div><span>Playback sessions</span><strong>{formatCount(summary.uniquePlaybackSessions)}</strong></div>
                        <div><span>Starts</span><strong>{formatCount(summary.playStarts)}</strong></div>
                        <div><span>Completes</span><strong>{formatPercent(summary.playCompletionRate)}</strong></div>
                        <div><span>Player errors</span><strong>{formatCount(summary.playerErrors)}</strong></div>
                        <div><span>RUM JS errors</span><strong>{formatCount(summary.standard.jsErrors)}</strong></div>
                        <div><span>Backend plays</span><strong>{formatCount(summary.backendPlayEvents.tenSecondPlays)}</strong></div>
                        <div><span>Backend 25%</span><strong>{formatCount(summary.backendPlayEvents.twentyFivePercentPlays)}</strong></div>
                        <div><span>Backend complete</span><strong>{formatPercent(summary.backendPlayEvents.playCompletionRate)}</strong></div>
                    </div>

                    <div className="admin-rum-grid">
                        <div>
                            <h3>Backend top songs</h3>
                            {summary.backendPlayEvents.songs.slice(0, 8).map((song) => (
                                <div className="admin-stat-row" key={`${song.songId}/${song.recordingId}`}>
                                    <span>{song.title ?? song.songId}</span>
                                    <strong>{formatCount(song.tenSecondPlays)}</strong>
                                </div>
                            ))}
                        </div>
                        <div>
                            <h3>Backend play events</h3>
                            {summary.backendPlayEvents.events.map((event) => (
                                <div className="admin-stat-row" key={event.eventType}>
                                    <span>{event.eventType}</span>
                                    <strong>{formatCount(event.count)}</strong>
                                </div>
                            ))}
                        </div>
                        <div>
                            <h3>Traffic sources</h3>
                            {summary.referrers.slice(0, 8).map((referrer) => (
                                <div className="admin-stat-row" key={referrer.value}>
                                    <span>{referrer.value}</span>
                                    <strong>{formatCount(referrer.count)}</strong>
                                </div>
                            ))}
                        </div>
                        <div>
                            <h3>Top pages</h3>
                            {summary.pages.slice(0, 8).map((page) => (
                                <div className="admin-stat-row" key={page.pagePath}>
                                    <span>{page.pagePath}</span>
                                    <strong>{formatCount(page.views)} / {formatPercent(page.bounceRate)}</strong>
                                </div>
                            ))}
                        </div>
                        <div>
                            <h3>Player events</h3>
                            {summary.events.map((event) => (
                                <div className="admin-stat-row" key={event.eventType}>
                                    <span>{event.eventType}</span>
                                    <strong>{formatCount(event.count)}</strong>
                                </div>
                            ))}
                        </div>
                        <div>
                            <h3>Top tracks</h3>
                            {summary.tracks.slice(0, 8).map((track) => (
                                <div className="admin-stat-row" key={`${track.releaseId}/${track.trackId}`}>
                                    <span>{track.trackId}</span>
                                    <strong>{formatCount(track.playStarts)}</strong>
                                </div>
                            ))}
                        </div>
                        <div>
                            <h3>RUM standard</h3>
                            <div className="admin-stat-row"><span>page_view_event</span><strong>{formatCount(summary.standard.pageViews)}</strong></div>
                            <div className="admin-stat-row"><span>performance_navigation_event</span><strong>{formatCount(summary.standard.navigationEvents)}</strong></div>
                            <div className="admin-stat-row"><span>http_event</span><strong>{formatCount(summary.standard.httpEvents)}</strong></div>
                        </div>
                        <div>
                            <h3>Browsers</h3>
                            {summary.browsers.slice(0, 8).map((browser) => (
                                <div className="admin-stat-row" key={browser.value}>
                                    <span>{browser.value}</span>
                                    <strong>{formatCount(browser.count)}</strong>
                                </div>
                            ))}
                        </div>
                        <div>
                            <h3>Devices</h3>
                            {summary.devices.slice(0, 8).map((device) => (
                                <div className="admin-stat-row" key={device.value}>
                                    <span>{device.value}</span>
                                    <strong>{formatCount(device.count)}</strong>
                                </div>
                            ))}
                        </div>
                        <div>
                            <h3>Countries</h3>
                            {summary.countries.slice(0, 8).map((country) => (
                                <div className="admin-stat-row" key={country.value}>
                                    <span>{country.value}</span>
                                    <strong>{formatCount(country.count)}</strong>
                                </div>
                            ))}
                        </div>
                    </div>

                    {summary.recentErrors.length > 0 ? (
                        <div className="admin-rum-errors">
                            <h3>Recent errors</h3>
                            {summary.recentErrors.map((item, index) => (
                                <div key={`${item.timestamp}-${index}`}>
                                    <strong>{item.errorName ?? 'Error'}</strong>
                                    <span>{item.trackId ?? item.songId ?? item.releaseId ?? 'unknown'}</span>
                                    <p>{item.errorMessage}</p>
                                </div>
                            ))}
                        </div>
                    ) : null}
                </>
            ) : null}
        </div>
    );
}
