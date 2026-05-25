import type { ReactNode } from 'react';

interface Props {
    kicker?: string;
    title: ReactNode;
    subline?: ReactNode;
    actions?: ReactNode;
}

export function StickyDetailHeader({ kicker, title, subline, actions }: Props) {
    return (
        <header className="admin-detail-header">
            <div className="admin-detail-header__heading">
                {kicker ? <p className="admin-kicker">{kicker}</p> : null}
                <h2>{title}</h2>
                {subline ? <div className="admin-detail-header__subline">{subline}</div> : null}
            </div>
            {actions ? <div className="admin-detail-header__actions">{actions}</div> : null}
        </header>
    );
}
