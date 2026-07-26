#!/usr/bin/env bash
# Re-pulls the mood beds from catalyst-castellum and mixes each one's stems into a single file.
#
# The stems are per-instrument (pulse1, pulse2, triangle, noise), so any one of them occupies a narrow
# part of the spectrum. Mixed, each bed carries bass, midrange, and treble at once, which is what the
# band levels and excitation channels exist to separate.
set -euo pipefail

# Music remains local and ignored; the rest of the Visualizer Lab is checked in.
source_root="${1:-../../../catalyst-castellum/public/audio}"
out="$(cd "$(dirname "$0")" && pwd)/audio"

command -v ffmpeg >/dev/null || { echo "ffmpeg not on PATH" >&2; exit 1; }
[ -d "$source_root" ] || { echo "no audio at $source_root" >&2; exit 1; }

mkdir -p "$out"
for mood_dir in "$source_root"/*/; do
    mood="$(basename "$mood_dir")"
    mapfile -t stems < <(find "$mood_dir" -maxdepth 1 -name '*.ogg' | sort)
    [ "${#stems[@]}" -gt 0 ] || continue

    inputs=()
    for stem in "${stems[@]}"; do inputs+=(-i "$stem"); done

    # `normalize=0` keeps amix from dividing every input by the stem count, which would leave the bed
    # quiet enough that the peak followers never see a real transient. The limiter takes the peaks.
    ffmpeg -y -v error "${inputs[@]}" \
        -filter_complex "amix=inputs=${#stems[@]}:duration=longest:normalize=0,alimiter=limit=0.95" \
        -c:a libvorbis -q:a 5 "$out/$mood.ogg"

    echo "$mood: ${#stems[@]} stems"
done
