import type { EncodeStatus } from '../admin-types';
import type { DraftRecording } from '../admin-types';

export type PublishState = 'draft' | 'ready' | 'published' | 'withdrawn';

interface PublishProps {
    kind: 'publish';
    value: PublishState;
}

interface EncodeProps {
    kind: 'encode';
    value: EncodeStatus | 'missing';
}

interface VersionProps {
    kind: 'version';
    value: DraftRecording['versionType'];
}

type Props = PublishProps | EncodeProps | VersionProps;

const PUBLISH_LABELS: Record<PublishState, string> = {
    draft: 'Draft',
    ready: 'Ready',
    published: 'Published',
    withdrawn: 'Withdrawn',
};

const ENCODE_LABELS: Record<EncodeStatus | 'missing', string> = {
    queued: 'Queued',
    running: 'Running',
    succeeded: 'Encoded',
    failed: 'Failed',
    canceled: 'Canceled',
    missing: 'No job',
};

export function StatusPill(props: Props) {
    if (props.kind === 'publish') {
        return <span className={`admin-pill admin-pill--publish-${props.value}`}>{PUBLISH_LABELS[props.value]}</span>;
    }
    if (props.kind === 'encode') {
        return <span className={`admin-status admin-status--${props.value}`}>{ENCODE_LABELS[props.value]}</span>;
    }
    return <span className="admin-pill admin-pill--version">{props.value ? props.value.replace(/_/g, ' ') : 'Unspecified'}</span>;
}
