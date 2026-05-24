import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { getSession, signOut as cognitoSignOut } from './auth';
import { AuthContext, type AuthStatus } from './auth-context-value';

export function AuthProvider({ children }: Readonly<{ children: ReactNode }>) {
    const [status, setStatus] = useState<AuthStatus>('loading');

    useEffect(() => {
        let mounted = true;

        getSession()
            .then((session) => {
                if (mounted) {
                    setStatus(session ? 'authed' : 'unauthed');
                }
            })
            .catch(() => {
                if (mounted) {
                    setStatus('unauthed');
                }
            });

        return () => {
            mounted = false;
        };
    }, []);

    const signIn = useCallback(() => setStatus('authed'), []);

    const signOut = useCallback(() => {
        cognitoSignOut();
        setStatus('unauthed');
    }, []);

    const value = useMemo(() => ({ status, signIn, signOut }), [status, signIn, signOut]);

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
