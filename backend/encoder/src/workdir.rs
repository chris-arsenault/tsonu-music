use crate::{EncoderError, WorkPaths, WORK_ROOT};
use encode_contract::EncodeJob;
use std::fs;
use std::path::{Path, PathBuf};
use tracing::warn;

pub(crate) fn prepare_work_dir(job: &EncodeJob) -> Result<WorkPaths, EncoderError> {
    let extension = source_extension(&job.input.key)?;
    let root = PathBuf::from(WORK_ROOT).join(&job.job_id);

    if root.exists() {
        fs::remove_dir_all(&root).map_err(|source| EncoderError::Io {
            action: "remove stale work directory",
            path: root.clone(),
            source,
        })?;
    }

    let input_root = root.join("input");
    let output_root = root.join("output");
    fs::create_dir_all(&input_root).map_err(|source| EncoderError::Io {
        action: "create input work directory",
        path: input_root.clone(),
        source,
    })?;
    fs::create_dir_all(&output_root).map_err(|source| EncoderError::Io {
        action: "create output work directory",
        path: output_root.clone(),
        source,
    })?;

    Ok(WorkPaths {
        source: input_root.join(format!("source.{extension}")),
        output_root,
    })
}

pub(crate) fn cleanup_work_dir(job_id: &str) {
    let root = PathBuf::from(WORK_ROOT).join(job_id);
    if let Err(error) = fs::remove_dir_all(&root) {
        if error.kind() != std::io::ErrorKind::NotFound {
            warn!(
                job_id,
                path = %root.display(),
                error = %error,
                "Failed to clean encoder work directory"
            );
        }
    }
}

pub(crate) fn source_extension(input_key: &str) -> Result<String, EncoderError> {
    let extension = Path::new(input_key)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| {
            EncoderError::InvalidEvent(format!(
                "source key has no supported extension: {input_key}"
            ))
        })?;

    match extension.as_str() {
        "wav" | "aif" | "aiff" | "flac" => Ok(extension),
        _ => Err(EncoderError::InvalidEvent(format!(
            "source key extension must be wav, aif, aiff, or flac: {input_key}"
        ))),
    }
}
