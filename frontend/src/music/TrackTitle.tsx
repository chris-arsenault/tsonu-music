import type { PublishedReleaseTrack } from '../catalog/media-catalog';

type TrackTitleSource = Pick<PublishedReleaseTrack, 'title' | 'songTitle' | 'versionTitle'>;

export interface TrackTitleParts {
    primary: string;
    alternate?: string;
}

export function getTrackTitleParts(track: TrackTitleSource): TrackTitleParts {
    const primary = cleanTitle(track.songTitle) || cleanTitle(track.title) || 'Untitled';
    const versionTitle = cleanTitle(track.versionTitle);
    if (versionTitle && !sameTitle(versionTitle, primary)) {
        return { primary, alternate: versionTitle };
    }

    const title = cleanTitle(track.title);
    if (!title || sameTitle(title, primary)) {
        return { primary };
    }

    return {
        primary,
        alternate: parentheticalTitle(primary, title) ?? title,
    };
}

export function getTrackTitleLabel(track: TrackTitleSource): string {
    const title = getTrackTitleParts(track);
    return title.alternate ? `${title.primary} - ${title.alternate}` : title.primary;
}

export function TrackTitle({ track }: { track: TrackTitleSource }) {
    const title = getTrackTitleParts(track);
    return (
        <span className="track-title">
            <span className="track-title__primary">{title.primary}</span>
            {title.alternate ? <sub className="track-title__alternate">{title.alternate}</sub> : null}
        </span>
    );
}

function cleanTitle(value: string | undefined): string {
    return value?.trim().replace(/\s+/g, ' ') ?? '';
}

function sameTitle(left: string, right: string): boolean {
    return cleanTitle(left).toLocaleLowerCase() === cleanTitle(right).toLocaleLowerCase();
}

function parentheticalTitle(primary: string, title: string): string | undefined {
    const prefix = `${primary} (`;
    if (!title.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase()) || !title.endsWith(')')) {
        return undefined;
    }
    return cleanTitle(title.slice(prefix.length, -1));
}
