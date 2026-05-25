import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
    children: ReactNode;
    fallbackTitle?: string;
}

interface State {
    error: Error | undefined;
}

export class ErrorBoundary extends Component<Props, State> {
    state: State = { error: undefined };

    static getDerivedStateFromError(error: Error): State {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        console.error('Admin shell crashed:', error, info.componentStack);
    }

    handleRetry = () => {
        this.setState({ error: undefined });
    };

    handleReload = () => {
        window.location.reload();
    };

    render() {
        if (!this.state.error) {
            return this.props.children;
        }
        const message = this.state.error.message || String(this.state.error);
        const stack = this.state.error.stack;
        return (
            <div className="admin-error-boundary" role="alert">
                <h2>{this.props.fallbackTitle ?? 'Something broke in the admin console.'}</h2>
                <p>The error has been logged to the browser console. You can try recovering, or reload the page.</p>
                <pre>{stack ?? message}</pre>
                <div className="admin-button-row">
                    <button type="button" className="admin-button" onClick={this.handleRetry}>Try again</button>
                    <button type="button" className="admin-button admin-button--primary" onClick={this.handleReload}>Reload page</button>
                </div>
            </div>
        );
    }
}
