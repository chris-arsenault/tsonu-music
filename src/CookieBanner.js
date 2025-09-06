// CookieBanner.tsx
import React, { useEffect, useState } from 'react';
import { getStoredConsent, storeConsent, loadGA, setConsentDenied } from './cookie-consent';


export default function CookieBanner({ measurementId, respectDoNotTrack = true }) {
    const [, setConsent] = useState(() => getStoredConsent());
    const [show, setShow] = useState(false);

    // On mount: if already granted, load GA. If denied, set consent mode to denied.
    useEffect(() => {
        const dnt = typeof navigator !== 'undefined' && ('doNotTrack' in navigator) && (navigator.doNotTrack === '1' || (navigator).msDoNotTrack === '1');
        const stored = getStoredConsent();

        if (respectDoNotTrack && dnt && stored === 'unset') {
            storeConsent('denied');
            setConsent('denied');
        }

        const current = getStoredConsent();
        if (current === 'granted') {
            loadGA(measurementId);
            setShow(false);
        } else if (current === 'denied') {
            setConsentDenied();
            setShow(false);
        } else {
            setShow(true);
        }
    }, [measurementId, respectDoNotTrack]);

    const accept = () => {
        storeConsent('granted');
        setConsent('granted');
        loadGA(measurementId);
        setShow(false);
    };

    const decline = () => {
        storeConsent('denied');
        setConsent('denied');
        setConsentDenied();
        setShow(false);
    };

    if (!show) return null;

    return (
        <div style={styles.wrap} role="dialog" aria-live="polite" aria-label="Cookie consent">
            <div style={styles.box}>
                <div style={styles.text}>
                    We use cookies for <strong>analytics</strong> to improve this site. Do you consent?
                </div>
                <div style={styles.btnRow}>
                    <button onClick={decline} style={{ ...styles.btn, ...styles.secondary }} aria-label="Decline analytics cookies">
                        Decline
                    </button>
                    <button onClick={accept} style={{ ...styles.btn, ...styles.primary }} aria-label="Accept analytics cookies">
                        Accept
                    </button>
                </div>
            </div>
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    wrap: {
        position: 'fixed',
        inset: 'auto 0 0 0',
        display: 'flex',
        justifyContent: 'center',
        padding: '12px',
        zIndex: 9999,
        pointerEvents: 'none',
    },
    box: {
        pointerEvents: 'auto',
        maxWidth: 720,
        width: '100%',
        background: '#111',
        color: '#fff',
        borderRadius: 12,
        boxShadow: '0 10px 30px rgba(0,0,0,0.35)',
        padding: '14px 16px',
        display: 'flex',
        gap: 12,
        alignItems: 'center',
        flexWrap: 'wrap',
    },
    text: { flex: 1, lineHeight: 1.4, fontSize: 14 },
    btnRow: { display: 'flex', gap: 8 },
    btn: {
        borderRadius: 10,
        border: 0,
        padding: '10px 14px',
        fontWeight: 600,
        cursor: 'pointer',
        fontSize: 14,
    },
    primary: { background: '#22c55e', color: '#0b1b10' },
    secondary: { background: '#2a2a2a', color: '#fff' },
};