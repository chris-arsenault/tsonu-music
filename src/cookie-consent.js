// cookie-consent.ts
const LS_KEY = 'cookie_consent_analytics_v1';

export function getStoredConsent(): ConsentState {
    if (typeof window === 'undefined') return 'unset';
    return (localStorage.getItem(LS_KEY)) || 'unset';
}

export function storeConsent(state) {
    if (typeof window === 'undefined') return;
    localStorage.setItem(LS_KEY, state);
}

// Load GA4 only after consent (conditional loading approach)
export function loadGA(measurementId: string) {
    if (typeof window === 'undefined') return;

    // Don’t double-load
    if (document.querySelector(`script[src*="gtag/js?id=${measurementId}"]`)) return;

    // gtag loader
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
    document.head.appendChild(script);

    // bootstrap dataLayer + config
    (window).dataLayer = (window).dataLayer || [];
    function gtag(){ (window).dataLayer.push(arguments); }
    (window).gtag = gtag;

    gtag('js', new Date());
    // If you use consent mode, explicitly set it granted on accept:
    gtag('consent', 'update', { analytics_storage: 'granted' });

    gtag('config', measurementId, {
        anonymize_ip: true,   // optional privacy tweak
    });
}

// Optional: apply “denied” to GA consent mode without loading GA
export function setConsentDenied() {
    if (typeof window === 'undefined') return;
    (window).dataLayer = (window).dataLayer || [];
    function gtag(){ (window).dataLayer.push(arguments); }
    (window).gtag = gtag;
    gtag('consent', 'default', { analytics_storage: 'denied' });
}