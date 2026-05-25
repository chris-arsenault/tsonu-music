import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

interface Props {
    icon?: LucideIcon;
    title: string;
    body?: string;
    action?: ReactNode;
}

export function EmptyState({ icon: Icon, title, body, action }: Props) {
    return (
        <div className="admin-empty">
            {Icon ? <Icon aria-hidden="true" /> : null}
            <strong>{title}</strong>
            {body ? <p>{body}</p> : null}
            {action ? <div className="admin-empty__action">{action}</div> : null}
        </div>
    );
}
