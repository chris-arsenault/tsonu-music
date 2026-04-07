import { useMemo, CSSProperties } from "react";

type Props = {
    url: string;
    showCaption?: boolean;
    maxWidth?: number;
    height?: number;
    className?: string;
    style?: CSSProperties;
};

export default function InstagramIframe({
    url,
    showCaption = false,
    maxWidth = 540,
    height = 680,
    className,
    style,
}: Props) {
    const cleanUrl = useMemo(() => {
        try { const u = new URL(url); u.search = ""; return u.toString(); }
        catch { return url; }
    }, [url]);

    const iframeSrc = useMemo(() => {
        const u = new URL(cleanUrl);
        if (!u.pathname.endsWith("/")) u.pathname += "/";
        u.pathname += "embed/";
        if (showCaption) u.searchParams.set("cr", "1");
        return u.toString();
    }, [cleanUrl, showCaption]);

    return (
        <div
            className={className}
            style={{ maxWidth, width: "100%", ...style }}
        >
            <iframe
                title="Instagram embed"
                src={iframeSrc}
                loading="lazy"
                style={{ border: 0, width: "100%", minWidth: 326, maxWidth: "100%" }}
                height={height}
                frameBorder={0}
            />
            {/* Fallback link if iframe is blocked */}
            <noscript>
                <a href={cleanUrl} target="_blank" rel="noreferrer">View this post on Instagram</a>
            </noscript>
        </div>
    );
}