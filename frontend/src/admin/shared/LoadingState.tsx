import { LoaderCircle } from 'lucide-react';

interface Props {
    label?: string;
    rows?: number;
}

export function ListLoadingSkeleton({ rows = 6 }: Pick<Props, 'rows'>) {
    return (
        <div className="admin-skeleton-list" aria-busy="true" aria-label="Loading">
            {Array.from({ length: rows }).map((_, index) => (
                <div key={index} className="admin-skeleton-row" />
            ))}
        </div>
    );
}

export function DetailLoadingSpinner({ label = 'Loading' }: Props) {
    return (
        <div className="admin-loading admin-loading--inline" role="status">
            <LoaderCircle aria-hidden="true" />
            <span>{label}</span>
        </div>
    );
}
