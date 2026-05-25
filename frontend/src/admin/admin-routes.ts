export type AdminSection = 'releases' | 'songs' | 'activity';

export interface ParsedAdminRoute {
    section: AdminSection;
    selectedId: string | undefined;
    subview: string | undefined;
}

export function parseAdminRoute(route: string): ParsedAdminRoute {
    const pathname = route.split(/[?#]/)[0] || '/admin';
    const parts = pathname.replace(/^\/admin\/?/, '').split('/').filter(Boolean);
    const rawSection = parts[0];

    let section: AdminSection;
    if (rawSection === 'songs') section = 'songs';
    else if (rawSection === 'activity' || rawSection === 'encoding' || rawSection === 'stats') section = 'activity';
    else section = 'releases';

    let selectedId: string | undefined;
    let subview: string | undefined;
    if ((section === 'releases' && parts[1]) || (section === 'songs' && parts[1])) {
        selectedId = decodeURIComponent(parts[1]);
        subview = parts[2];
    } else if (section === 'activity' && parts[0] === 'stats') {
        subview = 'stats';
    } else if (section === 'activity' && parts[1]) {
        subview = parts[1];
    }

    return { section, selectedId, subview };
}

export function buildAdminPath(section: AdminSection, selectedId?: string, subview?: string): string {
    if (section === 'activity') {
        return subview ? `/admin/activity/${subview}` : '/admin/activity';
    }
    if (selectedId) {
        return subview
            ? `/admin/${section}/${encodeURIComponent(selectedId)}/${subview}`
            : `/admin/${section}/${encodeURIComponent(selectedId)}`;
    }
    return `/admin/${section}`;
}
