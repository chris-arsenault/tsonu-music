import { useEffect, useState } from 'react';

export function useObjectUrl(file: File | undefined): string | undefined {
    const [url, setUrl] = useState<string>();

    useEffect(() => {
        if (!file) {
            setUrl(undefined);
            return undefined;
        }

        const nextUrl = URL.createObjectURL(file);
        setUrl(nextUrl);
        return () => URL.revokeObjectURL(nextUrl);
    }, [file]);

    return url;
}
