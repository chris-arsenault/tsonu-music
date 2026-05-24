export type StableId =
    | `album_${string}`
    | `release_${string}`
    | `track_${string}`
    | `asset_${string}`
    | `job_${string}`;

export type ReleaseType = 'album' | 'ep' | 'single' | 'demo' | 'preview' | 'collection';
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
    albums: CatalogAlbumSummary[];
}

export interface CatalogAlbumSummary {
    albumId: StableId;
    releaseId: StableId;
    slug: string;
    title: string;
    subtitle?: string;
    releaseType: ReleaseType;
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

export interface PublishedAlbumManifest {
    schemaVersion: 1;
    entityType: 'album';
    albumId: StableId;
    releaseId: StableId;
    slug: string;
    title: string;
    subtitle?: string;
    artistName: string;
    releaseType: ReleaseType;
    releaseDate: string;
    status: 'published';
    visibility: Visibility;
    publishedAt: string;
    description?: string;
    copyright?: string;
    artwork: CatalogArtwork;
    credits?: CatalogCredit[];
    links?: ExternalLink[];
    tracks: PublishedTrack[];
}

export interface PublishedTrack {
    trackId: StableId;
    discNumber: number;
    trackNumber: number;
    slug: string;
    title: string;
    durationSeconds: number;
    explicit: boolean;
    isrc?: string;
    description?: string;
    credits?: CatalogCredit[];
    playback: TrackPlayback;
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
