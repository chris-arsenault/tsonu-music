/**
 * URL of a processor bundled by `vite-plugins/audio-worklet.ts` into a single import-free script,
 * ready to hand to `audioWorklet.addModule`.
 */
declare module '*?audio-worklet' {
    const url: string;
    export default url;
}
