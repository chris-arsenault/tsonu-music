import { afterEach, describe, expect, test, vi } from 'vitest';
import {
    signIn,
    submitSoftwareTokenMfa,
    type SoftwareTokenMfaChallenge,
} from './auth';

const cognitoMocks = vi.hoisted(() => ({
    authenticateUser: vi.fn(),
    associateSoftwareToken: vi.fn(),
    sendMFACode: vi.fn(),
    verifySoftwareToken: vi.fn(),
}));

vi.mock('./runtime-config', () => ({
    getRuntimeConfig: () => ({
        cognitoClientId: 'client-id',
        cognitoUserPoolId: 'pool-id',
    }),
}));

vi.mock('amazon-cognito-identity-js', () => {
    class AuthenticationDetails {
        data: unknown;

        constructor(data: unknown) {
            this.data = data;
        }
    }

    class CognitoUserPool {
        data: unknown;

        constructor(data: unknown) {
            this.data = data;
        }
    }

    class CognitoUser {
        username: string;

        constructor(data: { Username: string }) {
            this.username = data.Username;
        }

        authenticateUser = cognitoMocks.authenticateUser;
        associateSoftwareToken = cognitoMocks.associateSoftwareToken;
        sendMFACode = cognitoMocks.sendMFACode;
        verifySoftwareToken = cognitoMocks.verifySoftwareToken;
    }

    return {
        AuthenticationDetails,
        CognitoUser,
        CognitoUserPool,
    };
});

afterEach(() => {
    vi.clearAllMocks();
});

describe('signIn MFA handling', () => {
    test('returns a software-token challenge when Cognito asks for a TOTP code', async () => {
        cognitoMocks.authenticateUser.mockImplementation((_details, callbacks) => {
            callbacks.totpRequired('SOFTWARE_TOKEN_MFA', { delivery: 'software-token' });
        });

        const result = await signIn(' admin@example.com ', 'password');

        expect(result).toMatchObject({
            kind: 'software-token-mfa',
            username: 'admin@example.com',
            challengeName: 'SOFTWARE_TOKEN_MFA',
            challengeParameters: { delivery: 'software-token' },
        });
    });

    test('stops sign-in without local enrollment when Cognito requires MFA setup', async () => {
        cognitoMocks.authenticateUser.mockImplementation((_details, callbacks) => {
            callbacks.mfaSetup('MFA_SETUP', { required: true });
        });

        const result = await signIn('admin@example.com', 'password');

        expect(cognitoMocks.associateSoftwareToken).not.toHaveBeenCalled();
        expect(cognitoMocks.verifySoftwareToken).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            kind: 'mfa-enrollment-required',
            username: 'admin@example.com',
            challengeName: 'MFA_SETUP',
            challengeParameters: { required: true },
        });
    });

    test('submits software-token MFA codes with Cognito challenge type', async () => {
        const session = { token: 'session' };
        const challenge = {
            kind: 'software-token-mfa',
            user: {
                sendMFACode: cognitoMocks.sendMFACode,
            },
        } as unknown as SoftwareTokenMfaChallenge;
        cognitoMocks.sendMFACode.mockImplementation((_code, callbacks) => {
            callbacks.onSuccess(session);
        });

        await expect(submitSoftwareTokenMfa(challenge, '123-456')).resolves.toBe(session);
        expect(cognitoMocks.sendMFACode).toHaveBeenCalledWith(
            '123456',
            expect.objectContaining({
                onSuccess: expect.any(Function),
                onFailure: expect.any(Function),
            }),
            'SOFTWARE_TOKEN_MFA',
        );
    });
});
