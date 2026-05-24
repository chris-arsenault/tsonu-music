import { useState, type FormEvent } from 'react';
import { KeyRound } from 'lucide-react';
import { signIn } from '../auth';

interface LoginProps {
    onLogin: () => void;
}

export function Login({ onLogin }: Readonly<LoginProps>) {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    function handleSubmit(event: FormEvent<HTMLFormElement>): void {
        event.preventDefault();
        setError('');
        setLoading(true);

        signIn(username, password)
            .then(() => onLogin())
            .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))
            .finally(() => setLoading(false));
    }

    return (
        <main className="admin-login-shell">
            <form className="admin-login-form" onSubmit={handleSubmit}>
                <div className="admin-login-form__header">
                    <KeyRound aria-hidden="true" />
                    <div>
                        <p className="admin-kicker">Admin</p>
                        <h1>Tsonu Login</h1>
                    </div>
                </div>
                {error ? <div className="admin-alert admin-alert--error">{error}</div> : null}
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
                <button className="admin-button admin-button--primary" type="submit" disabled={loading}>
                    <KeyRound aria-hidden="true" />
                    {loading ? 'Signing In' : 'Sign In'}
                </button>
            </form>
        </main>
    );
}
