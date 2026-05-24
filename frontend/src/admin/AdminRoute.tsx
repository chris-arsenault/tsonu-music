import { LoaderCircle } from 'lucide-react';
import { useAuth } from '../use-auth';
import AdminApp from './AdminApp';
import { Login } from './Login';
import './AdminApp.css';

export function AdminRoute() {
    const { status, signIn } = useAuth();

    if (status === 'loading') {
        return (
            <main className="admin-login-shell">
                <div className="admin-loading">
                    <LoaderCircle aria-hidden="true" />
                    <span>Loading session</span>
                </div>
            </main>
        );
    }

    if (status === 'authed') {
        return <AdminApp />;
    }

    return <Login onLogin={signIn} />;
}
