#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

FFMPEG_VERSION="${FFMPEG_VERSION:-7.0.2}"
FFMPEG_ARCHITECTURE="${FFMPEG_ARCHITECTURE:-amd64}"
FFMPEG_ARCHIVE_URL="${FFMPEG_ARCHIVE_URL:-https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz}"
FFMPEG_ARCHIVE_SHA256="${FFMPEG_ARCHIVE_SHA256:-abda8d77ce8309141f83ab8edf0596834087c52467f6badf376a6a2a4c87cf67}"
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1719619200}"

CACHE_DIR="${ROOT_DIR}/backend/target/ffmpeg-cache"
ARTIFACT_DIR="${ROOT_DIR}/backend/target/lambda-layers/ffmpeg"
ARCHIVE_PATH="${CACHE_DIR}/ffmpeg-${FFMPEG_VERSION}-${FFMPEG_ARCHITECTURE}-static.tar.xz"
LAYER_ZIP="${ARTIFACT_DIR}/ffmpeg-layer.zip"
LAYER_SHA256="${ARTIFACT_DIR}/ffmpeg-layer.zip.sha256"

MAX_LAYER_ZIP_BYTES=$((250 * 1024 * 1024))
MAX_LAYER_UNZIPPED_BYTES=$((220 * 1024 * 1024))

mkdir -p "${CACHE_DIR}" "${ARTIFACT_DIR}"

download_archive() {
  if [[ -f "${ARCHIVE_PATH}" ]]; then
    if printf '%s  %s\n' "${FFMPEG_ARCHIVE_SHA256}" "${ARCHIVE_PATH}" | sha256sum -c - >/dev/null 2>&1; then
      return
    fi

    rm -f "${ARCHIVE_PATH}"
  fi

  curl \
    --fail \
    --location \
    --show-error \
    --retry 3 \
    --user-agent "tsonu-music-build/1.0" \
    --output "${ARCHIVE_PATH}" \
    "${FFMPEG_ARCHIVE_URL}"
}

sum_file_sizes() {
  find "$1" -type f -printf '%s\n' | awk '{ total += $1 } END { print total + 0 }'
}

download_archive
printf '%s  %s\n' "${FFMPEG_ARCHIVE_SHA256}" "${ARCHIVE_PATH}" | sha256sum -c -

work_dir="$(mktemp -d)"
trap 'rm -rf "${work_dir}"' EXIT

extract_dir="${work_dir}/extract"
layer_dir="${work_dir}/layer"
mkdir -p "${extract_dir}" "${layer_dir}/bin" "${layer_dir}/share/doc/ffmpeg"

tar -xJf "${ARCHIVE_PATH}" -C "${extract_dir}"

ffmpeg_src="$(find "${extract_dir}" -type f -name ffmpeg -perm -111 | sort | head -n 1)"
ffprobe_src="$(find "${extract_dir}" -type f -name ffprobe -perm -111 | sort | head -n 1)"

if [[ -z "${ffmpeg_src}" || -z "${ffprobe_src}" ]]; then
  echo "ffmpeg or ffprobe was not found in ${ARCHIVE_PATH}" >&2
  exit 1
fi

release_dir="$(dirname "${ffmpeg_src}")"

cp -p "${ffmpeg_src}" "${layer_dir}/bin/ffmpeg"
cp -p "${ffprobe_src}" "${layer_dir}/bin/ffprobe"
chmod 0755 "${layer_dir}/bin/ffmpeg" "${layer_dir}/bin/ffprobe"

cp -p "${release_dir}/GPLv3.txt" "${layer_dir}/share/doc/ffmpeg/GPLv3.txt"
cp -p "${release_dir}/readme.txt" "${layer_dir}/share/doc/ffmpeg/readme.txt"

cat >"${layer_dir}/FFMPEG_LAYER_MANIFEST.json" <<EOF
{
  "name": "johnvansickle-ffmpeg-static",
  "version": "${FFMPEG_VERSION}",
  "architecture": "x86_64",
  "archiveUrl": "${FFMPEG_ARCHIVE_URL}",
  "archiveSha256": "${FFMPEG_ARCHIVE_SHA256}",
  "license": "GPL-3.0-or-later",
  "binaries": {
    "ffmpeg": "/opt/bin/ffmpeg",
    "ffprobe": "/opt/bin/ffprobe"
  }
}
EOF

"${layer_dir}/bin/ffmpeg" -version >/dev/null
"${layer_dir}/bin/ffprobe" -version >/dev/null

unzipped_bytes="$(sum_file_sizes "${layer_dir}")"
if (( unzipped_bytes > MAX_LAYER_UNZIPPED_BYTES )); then
  echo "Layer unzipped size ${unzipped_bytes} exceeds ${MAX_LAYER_UNZIPPED_BYTES}" >&2
  exit 1
fi

find "${layer_dir}" -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +

rm -f "${LAYER_ZIP}" "${LAYER_SHA256}"
(
  cd "${layer_dir}"
  find . -type f | LC_ALL=C sort | zip -X -q -9 "${LAYER_ZIP}" -@
)

zip_bytes="$(stat -c '%s' "${LAYER_ZIP}")"
if (( zip_bytes > MAX_LAYER_ZIP_BYTES )); then
  echo "Layer zip size ${zip_bytes} exceeds ${MAX_LAYER_ZIP_BYTES}" >&2
  exit 1
fi

sha256sum "${LAYER_ZIP}" >"${LAYER_SHA256}"

echo "Built ${LAYER_ZIP}"
echo "Layer zip bytes: ${zip_bytes}"
echo "Layer unzipped bytes: ${unzipped_bytes}"
cat "${LAYER_SHA256}"
