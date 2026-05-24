import { createContext } from 'react';

export type AuthStatus = 'loading' | 'authed' | 'unauthed';

export interface AuthContextValue {
    status: AuthStatus;
    signIn: () => void;
    signOut: () => void;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);
