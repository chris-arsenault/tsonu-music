import type { ReactNode } from 'react';

interface Props {
    list: ReactNode;
    detail: ReactNode;
}

export function ListDetailLayout({ list, detail }: Props) {
    return (
        <div className="admin-listdetail">
            <aside className="admin-listdetail__list">{list}</aside>
            <section className="admin-listdetail__detail">{detail}</section>
        </div>
    );
}
