import {
    AuthenticationDetails,
    CognitoUser,
    CognitoUserPool,
    type CognitoUserSession,
} from 'amazon-cognito-identity-js';
import { getRuntimeConfig } from './runtime-config';

function getUserPool(): CognitoUserPool {
    const config = getRuntimeConfig();
    if (!config.cognitoUserPoolId || !config.cognitoClientId) {
        throw new Error('Missing Cognito configuration.');
    }

    return new CognitoUserPool({
        UserPoolId: config.cognitoUserPoolId,
        ClientId: config.cognitoClientId,
    });
}

function getCurrentUser(): CognitoUser | null {
    try {
        return getUserPool().getCurrentUser();
    } catch {
        return null;
    }
}

export function signIn(username: string, password: string): Promise<CognitoUserSession> {
    const user = new CognitoUser({ Username: username, Pool: getUserPool() });
    const details = new AuthenticationDetails({ Username: username, Password: password });

    return new Promise((resolve, reject) => {
        user.authenticateUser(details, {
            onSuccess: (session) => resolve(session),
            onFailure: (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))),
        });
    });
}

export function signOut(): void {
    getCurrentUser()?.signOut();
}

export function getSession(): Promise<CognitoUserSession | null> {
    const user = getCurrentUser();
    if (!user) {
        return Promise.resolve(null);
    }

    return new Promise((resolve) => {
        user.getSession((error: Error | null, session: CognitoUserSession | null) => {
            resolve(error || !session ? null : session);
        });
    });
}

export async function getIdToken(): Promise<string | null> {
    const session = await getSession();
    return session?.getIdToken().getJwtToken() ?? null;
}
