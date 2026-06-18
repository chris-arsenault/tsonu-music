import {
    AuthenticationDetails,
    CognitoUser,
    CognitoUserPool,
    type CognitoUserSession,
    type ChallengeName,
} from 'amazon-cognito-identity-js';
import { getRuntimeConfig } from './runtime-config';

type ChallengeParameters = Record<string, unknown>;

export interface SignedInResult {
    kind: 'signed-in';
    session: CognitoUserSession;
}

export interface SoftwareTokenMfaChallenge {
    kind: 'software-token-mfa';
    user: CognitoUser;
    username: string;
    challengeName: 'SOFTWARE_TOKEN_MFA';
    challengeParameters: ChallengeParameters;
}

export interface MfaEnrollmentRequiredChallenge {
    kind: 'mfa-enrollment-required';
    username: string;
    challengeName: 'MFA_SETUP';
    challengeParameters: ChallengeParameters;
}

export type SignInResult = SignedInResult | SoftwareTokenMfaChallenge | MfaEnrollmentRequiredChallenge;

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

function toError(error: unknown): Error {
    if (error instanceof Error) {
        return error;
    }

    if (error && typeof error === 'object' && 'message' in error) {
        return new Error(String((error as { message: unknown }).message));
    }

    return new Error(String(error));
}

function toChallengeParameters(challengeParameters: unknown): ChallengeParameters {
    if (challengeParameters && typeof challengeParameters === 'object' && !Array.isArray(challengeParameters)) {
        return challengeParameters as ChallengeParameters;
    }

    return {};
}

function normalizeOtpCode(code: string): string {
    return code.replace(/\D/g, '');
}

function unsupportedChallenge(challengeName: ChallengeName): Error {
    return new Error(`Unsupported Cognito auth challenge: ${challengeName}.`);
}

export function signIn(username: string, password: string): Promise<SignInResult> {
    const trimmedUsername = username.trim();
    const user = new CognitoUser({ Username: trimmedUsername, Pool: getUserPool() });
    const details = new AuthenticationDetails({ Username: trimmedUsername, Password: password });

    return new Promise((resolve, reject) => {
        user.authenticateUser(details, {
            onSuccess: (session) => resolve({ kind: 'signed-in', session }),
            onFailure: (error: unknown) => reject(toError(error)),
            totpRequired: (challengeName, challengeParameters) => {
                if (challengeName !== 'SOFTWARE_TOKEN_MFA') {
                    reject(unsupportedChallenge(challengeName));
                    return;
                }

                resolve({
                    kind: 'software-token-mfa',
                    user,
                    username: trimmedUsername,
                    challengeName,
                    challengeParameters: toChallengeParameters(challengeParameters),
                });
            },
            mfaSetup: (challengeName, challengeParameters) => {
                if (challengeName !== 'MFA_SETUP') {
                    reject(unsupportedChallenge(challengeName));
                    return;
                }

                resolve({
                    kind: 'mfa-enrollment-required',
                    username: trimmedUsername,
                    challengeName,
                    challengeParameters: toChallengeParameters(challengeParameters),
                });
            },
            mfaRequired: (challengeName) => reject(unsupportedChallenge(challengeName)),
            selectMFAType: (challengeName) => reject(unsupportedChallenge(challengeName)),
            customChallenge: () => reject(unsupportedChallenge('CUSTOM_CHALLENGE')),
            newPasswordRequired: () => reject(unsupportedChallenge('NEW_PASSWORD_REQUIRED')),
        });
    });
}

export function submitSoftwareTokenMfa(
    challenge: SoftwareTokenMfaChallenge,
    code: string,
): Promise<CognitoUserSession> {
    return new Promise((resolve, reject) => {
        challenge.user.sendMFACode(
            normalizeOtpCode(code),
            {
                onSuccess: (session) => resolve(session),
                onFailure: (error: unknown) => reject(toError(error)),
            },
            'SOFTWARE_TOKEN_MFA',
        );
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
