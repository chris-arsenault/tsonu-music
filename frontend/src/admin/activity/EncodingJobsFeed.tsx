import { ChevronDown, ChevronRight, ExternalLink, FileAudio, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { formatBytes, formatRelativeTime, jobIdFromKey } from '../admin-helpers';
import { useCatalog } from '../catalog-store';
import type { EncodeStatus } from '../admin-types';
import { EmptyState } from '../shared/EmptyState';
import { StatusPill } from '../shared/StatusPill';
import { useActiveJobsPolling } from '../shared/useJobPolling';
import { useBusy } from '../shared/useBusy';
import { useSearchParam } from '../shared/useSearchParam';

type StatusFilter = 'all' | EncodeStatus;

interface Props {
    onNavigateSong: (songId: string) => void;
}

export function EncodingJobsFeed({ onNavigateSong }: Props) {
    const { jobList, jobs, loadJob, refreshJobs } = useCatalog();
    const { run } = useBusy();
    const [filterRaw, setFilterRaw] = useSearchParam('status', 'all');
    const filter = filterRaw as StatusFilter;
    const setFilter = (next: StatusFilter) => setFilterRaw(next);
    const [expandedId, setExpandedId] = useState<string>();

    useEffect(() => {
        const ids = (jobList?.objects ?? []).slice(0, 25).map((object) => jobIdFromKey(object.key));
        for (const id of ids) {
            if (!jobs[id]) {
                void loadJob(id).catch(() => undefined);
            }
        }
    }, [jobList, jobs, loadJob]);

    const rows = useMemo(() => {
        const objects = jobList?.objects ?? [];
        const items = objects.map((object) => {
            const id = jobIdFromKey(object.key);
            return {
                key: object.key,
                id,
                size: object.sizeBytes,
                job: jobs[id],
            };
        });
        if (filter === 'all') return items;
        return items.filter((item) => item.job?.status === filter);
    }, [jobList, jobs, filter]);

    const activeJobIds = useMemo(() => (
        rows.map((row) => row.id).filter((id) => {
            const job = jobs[id];
            return !job || job.status === 'queued' || job.status === 'running';
        }).slice(0, 25)
    ), [rows, jobs]);
    useActiveJobsPolling(activeJobIds);

    return (
        <div className="admin-activity">
            <header className="admin-activity__header">
                <div>
                    <p className="admin-kicker">Operations</p>
                    <h2>Encoding jobs</h2>
                </div>
                <div className="admin-button-row">
                    <select value={filter} onChange={(event) => setFilter(event.currentTarget.value as StatusFilter)}>
                        <option value="all">All statuses</option>
                        <option value="queued">Queued</option>
                        <option value="running">Running</option>
                        <option value="succeeded">Succeeded</option>
                        <option value="failed">Failed</option>
                        <option value="canceled">Canceled</option>
                    </select>
                    <button type="button" className="admin-icon-button" title="Refresh" onClick={() => void run('Refreshing jobs', refreshJobs)}>
                        <RefreshCw aria-hidden="true" />
                    </button>
                </div>
            </header>

            {rows.length === 0 ? (
                <EmptyState
                    icon={FileAudio}
                    title="No encode jobs"
                    body="Jobs appear here as you start encodes from the Songs tab."
                />
            ) : (
                <div className="admin-activity__list">
                    {rows.map((row) => {
                        const expanded = expandedId === row.id;
                        return (
                            <div key={row.key} className={`admin-activity__row ${expanded ? 'is-expanded' : ''}`}>
                                <button
                                    type="button"
                                    className="admin-activity__row-head"
                                    onClick={() => setExpandedId(expanded ? undefined : row.id)}
                                >
                                    <span className="admin-activity__chevron">
                                        {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                                    </span>
                                    <StatusPill kind="encode" value={(row.job?.status ?? 'missing')} />
                                    <div className="admin-activity__title">
                                        <strong>{row.id}</strong>
                                        {row.job ? <small className="admin-muted">{row.job.songId} · {row.job.recordingId}</small> : null}
                                    </div>
                                    <span className="admin-muted">{formatRelativeTime(row.job?.finishedAt ?? row.job?.startedAt ?? row.job?.requestedAt)}</span>
                                    <span className="admin-muted">{formatBytes(row.size)}</span>
                                </button>
                                {expanded ? (
                                    <div className="admin-activity__body">
                                        {row.job ? (
                                            <>
                                                <dl className="admin-activity__meta">
                                                    {row.job.requestedAt ? <><dt>Requested</dt><dd>{row.job.requestedAt}</dd></> : null}
                                                    {row.job.startedAt ? <><dt>Started</dt><dd>{row.job.startedAt}</dd></> : null}
                                                    {row.job.finishedAt ? <><dt>Finished</dt><dd>{row.job.finishedAt}</dd></> : null}
                                                    {row.job.metadata ? (
                                                        <>
                                                            <dt>Output</dt>
                                                            <dd>{row.job.metadata.codecName} · {row.job.metadata.sampleRateHz} Hz · {row.job.metadata.channels}ch · {Math.round(row.job.metadata.durationSeconds)}s</dd>
                                                        </>
                                                    ) : null}
                                                    <dt>Input</dt>
                                                    <dd>{row.job.input.bucket}/{row.job.input.key}</dd>
                                                </dl>
                                                {row.job.error ? (
                                                    <pre className="admin-job-detail__error">{row.job.error.message}{row.job.error.details ? `\n${row.job.error.details}` : ''}</pre>
                                                ) : null}
                                                {row.job.output.assets.length > 0 ? (
                                                    <details>
                                                        <summary>Output assets ({row.job.output.assets.length})</summary>
                                                        <ul className="admin-activity__assets">
                                                            {row.job.output.assets.map((asset) => (
                                                                <li key={asset.assetId}>
                                                                    <code>{asset.path}</code>
                                                                    <small className="admin-muted">{asset.mimeType} · {formatBytes(asset.fileSizeBytes)}</small>
                                                                </li>
                                                            ))}
                                                        </ul>
                                                    </details>
                                                ) : null}
                                                <div className="admin-button-row">
                                                    <button
                                                        type="button"
                                                        className="admin-button"
                                                        onClick={() => void run('Refreshing job', () => loadJob(row.id))}
                                                    >
                                                        <RefreshCw aria-hidden="true" /> Refresh
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="admin-button"
                                                        onClick={() => onNavigateSong(row.job!.songId)}
                                                    >
                                                        <ExternalLink aria-hidden="true" /> Open song
                                                    </button>
                                                </div>
                                            </>
                                        ) : (
                                            <button
                                                type="button"
                                                className="admin-button"
                                                onClick={() => void run('Loading job', () => loadJob(row.id))}
                                            >
                                                Load job details
                                            </button>
                                        )}
                                    </div>
                                ) : null}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
