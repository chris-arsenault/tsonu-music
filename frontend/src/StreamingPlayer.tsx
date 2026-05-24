import { MusicPlayerProvider } from './music/MusicPlayerContext';
import StickyPlayer from './music/StickyPlayer';

interface StreamingPlayerProps {
    fallbackArtworkSrc: string;
}

export default function StreamingPlayer({ fallbackArtworkSrc }: StreamingPlayerProps) {
    return (
        <MusicPlayerProvider fallbackArtworkSrc={fallbackArtworkSrc}>
            <StickyPlayer />
        </MusicPlayerProvider>
    );
}
