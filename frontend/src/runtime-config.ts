export interface RumRuntimeConfig {
    enabled: boolean;
    applicationId?: string;
    applicationRegion?: string;
    applicationVersion?: string;
    endpoint?: string;
    identityPoolId?: string;
    guestRoleArn?: string;
    sessionSampleRate?: number;
    allowCookies?: boolean;
    telemetries?: string[];
    playbackEventVersion?: number;
}

export interface AppRuntimeConfig {
    adminApiBaseUrl: string;
    mediaBaseUrl: string;
    rum: RumRuntimeConfig;
}

declare global {
    interface Window {
        __APP_CONFIG__?: Partial<AppRuntimeConfig> & {
            app?: Partial<AppRuntimeConfig>;
        };
    }
}

const DEFAULT_RUNTIME_CONFIG: AppRuntimeConfig = {
    adminApiBaseUrl: 'https://api.music.tsonu.com',
    mediaBaseUrl: 'https://media.tsonu.com',
    rum: {
        enabled: false,
        applicationVersion: 'local',
        applicationRegion: 'us-east-1',
        endpoint: 'https://dataplane.rum.us-east-1.amazonaws.com',
        sessionSampleRate: 1,
        allowCookies: false,
        telemetries: ['errors', 'performance', 'http'],
        playbackEventVersion: 1,
    },
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function optionalStringList(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const strings = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
    return strings.length > 0 ? strings : undefined;
}

function readRumConfig(value: unknown): RumRuntimeConfig {
    if (!isRecord(value)) {
        return DEFAULT_RUNTIME_CONFIG.rum;
    }

    return {
        enabled: optionalBoolean(value.enabled) ?? DEFAULT_RUNTIME_CONFIG.rum.enabled,
        applicationId: optionalString(value.applicationId),
        applicationRegion: optionalString(value.applicationRegion) ?? DEFAULT_RUNTIME_CONFIG.rum.applicationRegion,
        applicationVersion: optionalString(value.applicationVersion) ?? DEFAULT_RUNTIME_CONFIG.rum.applicationVersion,
        endpoint: optionalString(value.endpoint) ?? DEFAULT_RUNTIME_CONFIG.rum.endpoint,
        identityPoolId: optionalString(value.identityPoolId),
        guestRoleArn: optionalString(value.guestRoleArn),
        sessionSampleRate: optionalNumber(value.sessionSampleRate) ?? DEFAULT_RUNTIME_CONFIG.rum.sessionSampleRate,
        allowCookies: optionalBoolean(value.allowCookies) ?? DEFAULT_RUNTIME_CONFIG.rum.allowCookies,
        telemetries: optionalStringList(value.telemetries) ?? DEFAULT_RUNTIME_CONFIG.rum.telemetries,
        playbackEventVersion: optionalNumber(value.playbackEventVersion) ?? DEFAULT_RUNTIME_CONFIG.rum.playbackEventVersion,
    };
}

export function getRuntimeConfig(): AppRuntimeConfig {
    const rawConfig = typeof window === 'undefined' ? undefined : window.__APP_CONFIG__;
    const appConfig = isRecord(rawConfig?.app) ? rawConfig.app : rawConfig;

    if (!isRecord(appConfig)) {
        return DEFAULT_RUNTIME_CONFIG;
    }

    return {
        adminApiBaseUrl: optionalString(appConfig.adminApiBaseUrl) ?? DEFAULT_RUNTIME_CONFIG.adminApiBaseUrl,
        mediaBaseUrl: optionalString(appConfig.mediaBaseUrl) ?? DEFAULT_RUNTIME_CONFIG.mediaBaseUrl,
        rum: readRumConfig(appConfig.rum),
    };
}
