import { useState, type FormEvent } from 'react';
import { ArrowLeft, ExternalLink, KeyRound, ShieldAlert, ShieldCheck } from 'lucide-react';
import {
    signIn,
    submitSoftwareTokenMfa,
    type MfaEnrollmentRequiredChallenge,
    type SoftwareTokenMfaChallenge,
} from '../auth';

const MFA_ENROLLMENT_URL = 'https://mail.ahara.io';

interface LoginProps {
    onLogin: () => void;
}

type LoginStep =
    | { kind: 'password' }
    | { kind: 'software-token-mfa'; challenge: SoftwareTokenMfaChallenge }
    | { kind: 'mfa-enrollment-required'; challenge: MfaEnrollmentRequiredChallenge };

export function Login({ onLogin }: Readonly<LoginProps>) {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [otpCode, setOtpCode] = useState('');
    const [step, setStep] = useState<LoginStep>({ kind: 'password' });
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const isEnrollmentRequired = step.kind === 'mfa-enrollment-required';
    const isMfaChallenge = step.kind === 'software-token-mfa';
    const isPasswordStep = step.kind === 'password';
    const heading = isEnrollmentRequired ? 'MFA Enrollment Required' : isMfaChallenge ? 'Authenticator Code' : 'Tsonu Login';
    const icon = isPasswordStep
        ? <KeyRound aria-hidden="true" />
        : isEnrollmentRequired
            ? <ShieldAlert aria-hidden="true" />
            : <ShieldCheck aria-hidden="true" />;

    function handleOtpCodeChange(value: string): void {
        setOtpCode(value.replace(/\D/g, '').slice(0, 6));
    }

    function resetPasswordStep(): void {
        setStep({ kind: 'password' });
        setPassword('');
        setOtpCode('');
        setError('');
    }

    function handleSubmit(event: FormEvent<HTMLFormElement>): void {
        event.preventDefault();
        setError('');
        setLoading(true);

        if (step.kind === 'software-token-mfa') {
            submitSoftwareTokenMfa(step.challenge, otpCode)
                .then(() => onLogin())
                .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))
                .finally(() => setLoading(false));
            return;
        }

        if (step.kind === 'mfa-enrollment-required') {
            setLoading(false);
            return;
        }

        signIn(username, password)
            .then((result) => {
                if (result.kind === 'signed-in') {
                    onLogin();
                    return;
                }

                setOtpCode('');
                setStep(result.kind === 'mfa-enrollment-required'
                    ? { kind: 'mfa-enrollment-required', challenge: result }
                    : { kind: 'software-token-mfa', challenge: result });
            })
            .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))
            .finally(() => setLoading(false));
    }

    return (
        <main className="admin-login-shell">
            <form className="admin-login-form" onSubmit={handleSubmit}>
                <div className="admin-login-form__header">
                    {icon}
                    <div>
                        <p className="admin-kicker">Admin</p>
                        <h1>{heading}</h1>
                    </div>
                </div>
                {error ? <div className="admin-alert admin-alert--error">{error}</div> : null}
                {isPasswordStep ? (
                    <>
                        <div className="admin-field">
                            <label htmlFor="admin-username">Username or Email</label>
                            <input
                                id="admin-username"
                                autoComplete="username"
                                value={username}
                                onChange={(event) => setUsername(event.currentTarget.value)}
                                required
                            />
                        </div>
                        <div className="admin-field">
                            <label htmlFor="admin-password">Password</label>
                            <input
                                id="admin-password"
                                type="password"
                                autoComplete="current-password"
                                value={password}
                                onChange={(event) => setPassword(event.currentTarget.value)}
                                required
                            />
                        </div>
                    </>
                ) : null}
                {isEnrollmentRequired ? (
                    <div className="admin-login-enrollment">
                        <strong>Authenticator enrollment is required.</strong>
                        <p>Enroll in Ahara Business, then return here and sign in again.</p>
                    </div>
                ) : null}
                {isMfaChallenge ? (
                    <div className="admin-field">
                        <label htmlFor="admin-otp-code">6-Digit Code</label>
                        <input
                            id="admin-otp-code"
                            autoComplete="one-time-code"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            maxLength={6}
                            value={otpCode}
                            onChange={(event) => handleOtpCodeChange(event.currentTarget.value)}
                            required
                        />
                    </div>
                ) : null}
                {isEnrollmentRequired ? (
                    <div className="admin-button-row">
                        <a
                            className="admin-button admin-button--primary"
                            href={MFA_ENROLLMENT_URL}
                            rel="noreferrer"
                            target="_blank"
                        >
                            <ExternalLink aria-hidden="true" />
                            Open Ahara Business
                        </a>
                        <button className="admin-button" type="button" disabled={loading} onClick={resetPasswordStep}>
                            <ArrowLeft aria-hidden="true" />
                            Back to Sign In
                        </button>
                    </div>
                ) : (
                    <button className="admin-button admin-button--primary" type="submit" disabled={loading}>
                        {isPasswordStep ? <KeyRound aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
                        {loading ? 'Working' : isPasswordStep ? 'Sign In' : 'Verify'}
                    </button>
                )}
                {isMfaChallenge ? (
                    <button className="admin-button" type="button" disabled={loading} onClick={resetPasswordStep}>
                        <ArrowLeft aria-hidden="true" />
                        Different Account
                    </button>
                ) : null}
            </form>
        </main>
    );
}
