import { RefreshCw, Trash2, Wrench } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { cleanupMaintenance, getMaintenanceReport } from '../admin-api';
import { formatRelativeTime } from '../admin-helpers';
import type {
    MaintenanceCleanupRequest,
    MaintenanceReport,
    OrphanReleaseTrack,
    StaleDraftRecording,
    StaleEncodeJob,
    StalePublishedSong,
} from '../admin-types';
import { useNotifications } from '../notifications';
import { ConfirmPopover } from '../shared/ConfirmPopover';
import { EmptyState } from '../shared/EmptyState';
import { StatusPill } from '../shared/StatusPill';
import { useBusy } from '../shared/useBusy';

type SectionKey = 'recording' | 'track' | 'job' | 'publishedSong';

interface RowBase {
    key: string;
    section: SectionKey;
    title: string;
    detail: string;
    reason: string;
    status?: StaleEncodeJob['status'];
    age?: string;
}

function recordingKey(item: Pick<StaleDraftRecording, 'songId' | 'recordingId'>): string {
    return `recording:${item.songId}:${item.recordingId}`;
}

function trackKey(item: Pick<OrphanReleaseTrack, 'releaseId' | 'trackId'>): string {
    return `track:${item.releaseId}:${item.trackId}`;
}

function jobKey(item: Pick<StaleEncodeJob, 'jobId'>): string {
    return `job:${item.jobId}`;
}

function publishedSongKey(item: Pick<StalePublishedSong, 'songId'>): string {
    return `publishedSong:${item.songId}`;
}

function reasonLabel(reason: string): string {
    return reason
        .split('_')
        .filter(Boolean)
        .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
        .join(' ');
}

function rowsFor(report: MaintenanceReport | undefined): RowBase[] {
    if (!report) return [];
    return [
        ...report.staleDraftRecordings.map((item): RowBase => ({
            key: recordingKey(item),
            section: 'recording',
            title: item.recordingTitle || item.recordingId,
            detail: `${item.songTitle || item.songId} · ${item.recordingId}`,
            reason: item.reason,
        })),
        ...report.orphanReleaseTracks.map((item): RowBase => ({
            key: trackKey(item),
            section: 'track',
            title: item.trackTitle || item.trackId,
            detail: `${item.releaseTitle || item.releaseId} · ${item.songId} · ${item.recordingId}`,
            reason: item.reason,
        })),
        ...report.staleEncodeJobs.map((item): RowBase => ({
            key: jobKey(item),
            section: 'job',
            title: item.jobId,
            detail: `${item.songId} · ${item.recordingId}`,
            reason: item.reason,
            status: item.status,
            age: item.finishedAt ?? item.requestedAt,
        })),
        ...report.stalePublishedSongs.map((item): RowBase => ({
            key: publishedSongKey(item),
            section: 'publishedSong',
            title: item.title || item.songId,
            detail: `${item.slug} · ${item.songId}`,
            reason: item.reason,
        })),
    ];
}

function sectionLabel(section: SectionKey): string {
    switch (section) {
        case 'recording': return 'Draft recordings';
        case 'track': return 'Release tracks';
        case 'job': return 'Encode jobs';
        case 'publishedSong': return 'Published songs';
    }
}

export function MaintenancePanel() {
    const { busy, run } = useBusy();
    const { notify } = useNotifications();
    const [report, setReport] = useState<MaintenanceReport>();
    const [selected, setSelected] = useState<Set<string>>(() => new Set());

    async function refresh() {
        const next = await getMaintenanceReport();
        setReport(next);
        setSelected((current) => {
            const valid = new Set(rowsFor(next).map((row) => row.key));
            return new Set([...current].filter((key) => valid.has(key)));
        });
    }

    useEffect(() => {
        void run('Loading maintenance report', async () => {
            const next = await getMaintenanceReport();
            setReport(next);
            setSelected(new Set());
        });
    }, [run]);

    const rows = useMemo(() => rowsFor(report), [report]);
    const grouped = useMemo(() => {
        const map = new Map<SectionKey, RowBase[]>();
        for (const row of rows) {
            map.set(row.section, [...(map.get(row.section) ?? []), row]);
        }
        return map;
    }, [rows]);
    const selectedCount = selected.size;

    function toggle(key: string) {
        setSelected((current) => {
            const next = new Set(current);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    }

    function toggleSection(section: SectionKey, checked: boolean) {
        const keys = grouped.get(section)?.map((row) => row.key) ?? [];
        setSelected((current) => {
            const next = new Set(current);
            for (const key of keys) {
                if (checked) next.add(key);
                else next.delete(key);
            }
            return next;
        });
    }

    function cleanupRequest(): MaintenanceCleanupRequest {
        if (!report) return {};
        return {
            draftRecordings: report.staleDraftRecordings
                .filter((item) => selected.has(recordingKey(item)))
                .map(({ songId, recordingId }) => ({ songId, recordingId })),
            releaseTracks: report.orphanReleaseTracks
                .filter((item) => selected.has(trackKey(item)))
                .map(({ releaseId, trackId }) => ({ releaseId, trackId })),
            encodeJobIds: report.staleEncodeJobs
                .filter((item) => selected.has(jobKey(item)))
                .map((item) => item.jobId),
            publishedSongIds: report.stalePublishedSongs
                .filter((item) => selected.has(publishedSongKey(item)))
                .map((item) => item.songId),
        };
    }

    async function cleanupSelected() {
        if (selectedCount === 0) return;
        await run('Cleaning stale entries', async () => {
            const response = await cleanupMaintenance(cleanupRequest());
            setReport(response.report);
            setSelected(new Set());
            const deletedTotal = Object.values(response.deleted).reduce((sum, value) => sum + value, 0);
            notify(`Deleted ${deletedTotal} stale entr${deletedTotal === 1 ? 'y' : 'ies'}.`);
        });
    }

    const total = report
        ? report.totals.staleDraftRecordings
            + report.totals.orphanReleaseTracks
            + report.totals.staleEncodeJobs
            + report.totals.stalePublishedSongs
        : rows.length;

    return (
        <div className="admin-activity">
            <header className="admin-activity__header">
                <div>
                    <p className="admin-kicker">Maintenance</p>
                    <h2>Stale catalog entries</h2>
                    {report ? <small className="admin-muted">Scanned {formatRelativeTime(report.generatedAt)}</small> : null}
                </div>
                <div className="admin-button-row">
                    <button type="button" className="admin-icon-button" title="Refresh" onClick={() => void run('Refreshing maintenance report', refresh)}>
                        <RefreshCw aria-hidden="true" />
                    </button>
                    <ConfirmPopover
                        label={`Delete ${selectedCount} selected stale entr${selectedCount === 1 ? 'y' : 'ies'}?`}
                        confirmLabel="Delete"
                        tone="danger"
                        onConfirm={() => void cleanupSelected()}
                    >
                        {(open) => (
                            <button
                                type="button"
                                className="admin-button admin-button--danger"
                                disabled={selectedCount === 0 || Boolean(busy)}
                                onClick={open}
                            >
                                <Trash2 aria-hidden="true" /> {busy === 'Cleaning stale entries' ? 'Cleaning...' : `Delete selected (${selectedCount})`}
                            </button>
                        )}
                    </ConfirmPopover>
                </div>
            </header>

            {!report && busy ? (
                <div className="admin-empty-state">Loading maintenance report...</div>
            ) : total === 0 ? (
                <EmptyState
                    icon={Wrench}
                    title="No stale entries"
                    body="Draft recordings, release tracks, encode jobs, and published song rows are aligned."
                />
            ) : (
                <div className="admin-maintenance">
                    {(['recording', 'track', 'job', 'publishedSong'] as SectionKey[]).map((section) => {
                        const sectionRows = grouped.get(section) ?? [];
                        if (sectionRows.length === 0) return null;
                        const selectedInSection = sectionRows.filter((row) => selected.has(row.key)).length;
                        return (
                            <section key={section} className="admin-maintenance__section">
                                <header className="admin-maintenance__section-head">
                                    <label className="admin-check">
                                        <input
                                            type="checkbox"
                                            checked={selectedInSection === sectionRows.length}
                                            ref={(input) => {
                                                if (input) input.indeterminate = selectedInSection > 0 && selectedInSection < sectionRows.length;
                                            }}
                                            onChange={(event) => toggleSection(section, event.currentTarget.checked)}
                                        />
                                        {sectionLabel(section)}
                                    </label>
                                    <span className="admin-muted">{sectionRows.length}</span>
                                </header>
                                <div className="admin-activity__list">
                                    {sectionRows.map((row) => (
                                        <label key={row.key} className="admin-maintenance__row">
                                            <input
                                                type="checkbox"
                                                checked={selected.has(row.key)}
                                                onChange={() => toggle(row.key)}
                                            />
                                            <div className="admin-activity__title">
                                                <strong>{row.title}</strong>
                                                <small className="admin-muted">{row.detail}</small>
                                            </div>
                                            {row.status ? <StatusPill kind="encode" value={row.status} /> : null}
                                            {row.age ? <span className="admin-muted">{formatRelativeTime(row.age)}</span> : null}
                                            <span className="admin-maintenance__reason">{reasonLabel(row.reason)}</span>
                                        </label>
                                    ))}
                                </div>
                            </section>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
