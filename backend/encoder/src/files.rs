use crate::{EncoderError, UploadedFile};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

pub(crate) fn collect_files(root: &Path) -> Result<Vec<PathBuf>, EncoderError> {
    let mut files = Vec::new();
    collect_files_into(root, &mut files)?;
    files.sort();
    Ok(files)
}

pub(crate) fn collect_files_into(
    path: &Path,
    files: &mut Vec<PathBuf>,
) -> Result<(), EncoderError> {
    for entry in fs::read_dir(path).map_err(|source| EncoderError::Io {
        action: "read generated output directory",
        path: path.to_path_buf(),
        source,
    })? {
        let entry = entry.map_err(|source| EncoderError::Io {
            action: "read generated output entry",
            path: path.to_path_buf(),
            source,
        })?;
        let entry_path = entry.path();
        if entry_path.is_dir() {
            collect_files_into(&entry_path, files)?;
        } else if entry_path.is_file() {
            files.push(entry_path);
        }
    }

    Ok(())
}

pub(crate) fn relative_s3_path(root: &Path, path: &Path) -> Result<String, EncoderError> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| EncoderError::InvalidRelativePath {
            root: root.to_path_buf(),
            path: path.to_path_buf(),
        })?;
    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(value) => {
                let value = value
                    .to_str()
                    .ok_or_else(|| EncoderError::PathEncoding(path.to_path_buf()))?;
                parts.push(value);
            }
            _ => {
                return Err(EncoderError::InvalidRelativePath {
                    root: root.to_path_buf(),
                    path: path.to_path_buf(),
                });
            }
        }
    }

    if parts.is_empty() {
        return Err(EncoderError::InvalidRelativePath {
            root: root.to_path_buf(),
            path: path.to_path_buf(),
        });
    }

    Ok(parts.join("/"))
}

pub(crate) fn join_s3_key(prefix: &str, relative_path: &str) -> String {
    format!(
        "{}/{}",
        prefix.trim_end_matches('/'),
        relative_path.trim_start_matches('/')
    )
}

pub(crate) fn file_integrity(path: &Path) -> Result<UploadedFile, EncoderError> {
    let mut file = fs::File::open(path).map_err(|source| EncoderError::Io {
        action: "open generated file",
        path: path.to_path_buf(),
        source,
    })?;
    let file_size_bytes = file
        .metadata()
        .map_err(|source| EncoderError::Io {
            action: "read generated file metadata",
            path: path.to_path_buf(),
            source,
        })?
        .len();

    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|source| EncoderError::Io {
            action: "read generated file",
            path: path.to_path_buf(),
            source,
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    Ok(UploadedFile {
        file_size_bytes,
        checksum_sha256: format!("{:x}", hasher.finalize()),
    })
}

pub(crate) fn content_type_for_path(path: &Path) -> &'static str {
    match path.extension().and_then(|value| value.to_str()) {
        Some("m3u8") => "application/vnd.apple.mpegurl",
        Some("ts") => "video/mp2t",
        Some("flac") => "audio/flac",
        Some("json") => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
}

pub(crate) fn path_arg(path: &Path) -> Result<String, EncoderError> {
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| EncoderError::PathEncoding(path.to_path_buf()))
}
