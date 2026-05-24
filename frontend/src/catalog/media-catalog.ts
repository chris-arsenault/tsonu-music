export type StableId =
    | `song_${string}`
    | `recording_${string}`
    | `release_${string}`
    | `track_${string}`
    | `asset_${string}`
    | `job_${string}`;

export type ReleaseKind = 'album' | 'ep' | 'single' | 'demo' | 'preview' | 'collection' | 'prerelease';
export type ReleaseStatus = 'official' | 'demo' | 'promo' | 'prerelease' | 'bootleg';
export type Visibility = 'public' | 'unlisted';
export type PlaybackQuality = 'aac-192' | 'aac-320' | 'flac-lossless';
export type PlaybackFormatKind = 'hls-rendition' | 'direct' | 'download';

export interface CatalogArtworkSource {
    path: string;
    url?: string;
    width: number;
    height: number;
    mimeType: string;
}

export interface CatalogArtwork {
    assetId: StableId;
    altText: string;
    sources: CatalogArtworkSource[];
}

export interface CatalogCredit {
    role: string;
    names: Array<{
        name: string;
        url?: string;
    }>;
}

export interface ExternalLink {
    label: string;
    url: string;
}

export interface PublishedCatalog {
    schemaVersion: 1;
    entityType: 'catalog';
    generatedAt: string;
    artist: {
        name: string;
        slug: string;
    };
    releases: CatalogReleaseSummary[];
    songs: CatalogSongSummary[];
}

export interface CatalogReleaseSummary {
    releaseId: StableId;
    slug: string;
    title: string;
    subtitle?: string;
    releaseKind: ReleaseKind;
    releaseStatus: ReleaseStatus;
    releaseDate: string;
    status: 'published';
    visibility: Visibility;
    manifestPath: string;
    artwork: CatalogArtwork;
    trackCount: number;
    totalDurationSeconds: number;
    tags?: string[];
    links?: ExternalLink[];
}

export interface CatalogSongSummary {
    songId: StableId;
    slug: string;
    title: string;
    artistName: string;
    tags?: string[];
}

export interface PublishedReleaseManifest {
    schemaVersion: 1;
    entityType: 'release';
    releaseId: StableId;
    slug: string;
    title: string;
    subtitle?: string;
    artistName: string;
    releaseKind: ReleaseKind;
    releaseStatus: ReleaseStatus;
    releaseDate: string;
    status: 'published';
    visibility: Visibility;
    publishedAt: string;
    description?: string;
    copyright?: string;
    artwork: CatalogArtwork;
    credits?: CatalogCredit[];
    links?: ExternalLink[];
    tracks: PublishedReleaseTrack[];
}

export interface PublishedReleaseTrack {
    trackId: StableId;
    songId: StableId;
    recordingId: StableId;
    discNumber: number;
    trackNumber: number;
    slug: string;
    title: string;
    songTitle: string;
    recordingTitle: string;
    versionTitle?: string;
    durationSeconds: number;
    explicit: boolean;
    isrc?: string;
    description?: string;
    credits?: CatalogCredit[];
    playback: TrackPlayback;
}

export interface PublishedSongManifest {
    schemaVersion: 1;
    entityType: 'song';
    songId: StableId;
    slug: string;
    title: string;
    artistName: string;
    description?: string;
    lyrics?: string;
    credits?: CatalogCredit[];
    tags?: string[];
    placements: PublishedSongPlacement[];
}

export interface PublishedSongPlacement {
    releaseId: StableId;
    releaseSlug: string;
    releaseTitle: string;
    releaseKind: ReleaseKind;
    trackId: StableId;
    trackSlug: string;
    recordingId: StableId;
    trackNumber: number;
}

export interface TrackPlayback {
    hls: {
        assetId: StableId;
        path: string;
        url?: string;
        mimeType: 'application/vnd.apple.mpegurl';
        codecs?: string[];
    };
    formats: PlaybackFormat[];
}

export interface PlaybackFormat {
    assetId: StableId;
    kind: PlaybackFormatKind;
    quality: PlaybackQuality;
    path: string;
    url?: string;
    mimeType: string;
    bitrateKbps?: number;
    sampleRateHz?: number;
    bitDepth?: number;
    channels?: number;
    fileSizeBytes?: number;
}
