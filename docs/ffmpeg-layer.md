# FFmpeg Lambda Layer

The encoder Lambda uses a dedicated layer containing static `ffmpeg` and
`ffprobe` binaries at:

```text
/opt/bin/ffmpeg
/opt/bin/ffprobe
```

Build the layer artifact before `terraform apply`:

```bash
scripts/build-ffmpeg-layer.sh
```

The script downloads the pinned John Van Sickle FFmpeg 7.0.2 static Linux
archive, verifies its SHA-256 digest, copies only `ffmpeg`, `ffprobe`, and
license/readme files into the Lambda layer layout, then creates:

```text
backend/target/lambda-layers/ffmpeg/ffmpeg-layer.zip
```

The zip is larger than Lambda's direct upload limit, so Terraform uploads it to
the private `tsonu-music-lambda-artifacts` S3 bucket and publishes the layer
from that object version. The unzipped layer remains below Lambda's combined
function-plus-layer limit.
