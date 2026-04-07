export type ConsentState = 'granted' | 'denied' | 'unset';

const LS_KEY = 'cookie_consent_analytics_v1';

export function getStoredConsent(): ConsentState {
    if (typeof window === 'undefined') return 'unset';
    return (localStorage.getItem(LS_KEY) as ConsentState) || 'unset';
}

export function storeConsent(state: ConsentState): void {
    if (typeof window === 'undefined') return;
    localStorage.setItem(LS_KEY, state);
}

// Load GA4 only after consent (conditional loading approach)
export function loadGA(measurementId: string): void {
    if (typeof window === 'undefined') return;

    // Don't double-load
    if (document.querySelector(`script[src*="gtag/js?id=${measurementId}"]`)) return;

    // gtag loader
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
    document.head.appendChild(script);

    // bootstrap dataLayer + config
    const w = window as any;
    w.dataLayer = w.dataLayer || [];
    const gtag = (...args: any[]) => { w.dataLayer.push(args); };
    w.gtag = gtag;

    gtag('js', new Date());
    // If you use consent mode, explicitly set it granted on accept:
    gtag('consent', 'update', { analytics_storage: 'granted' });

    gtag('config', measurementId, {
        anonymize_ip: true,
    });
}

// Apply "denied" to GA consent mode without loading GA
export function setConsentDenied(): void {
    if (typeof window === 'undefined') return;
    const w = window as any;
    w.dataLayer = w.dataLayer || [];
    const gtag = (...args: any[]) => { w.dataLayer.push(args); };
    w.gtag = gtag;
    gtag('consent', 'default', { analytics_storage: 'denied' });
}
