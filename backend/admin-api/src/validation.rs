use crate::{ApiError, DraftSourceMaster, UploadFormat, WritePreconditions};
use chrono::{DateTime, SecondsFormat, Utc};
use lambda_http::http::HeaderMap;
use serde_json::Value;

pub(crate) fn write_preconditions(headers: &HeaderMap) -> Result<WritePreconditions, ApiError> {
    let if_match = optional_header(headers, "if-match")?;
    let if_none_match = optional_header(headers, "if-none-match")?;

    if if_match.is_some() && if_none_match.is_some() {
        return Err(ApiError::bad_request(
            "ambiguous_precondition",
            "send either If-Match or If-None-Match, not both",
        ));
    }

    if if_match.is_none() && if_none_match.is_none() {
        return Err(ApiError::precondition_required(
            "send If-None-Match: * to create or If-Match: <etag> to update",
        ));
    }

    if let Some(value) = &if_none_match {
        if value != "*" {
            return Err(ApiError::bad_request(
                "invalid_if_none_match",
                "If-None-Match must be *",
            ));
        }
    }

    Ok(WritePreconditions {
        if_match,
        if_none_match,
    })
}

pub(crate) fn delete_precondition(headers: &HeaderMap) -> Result<String, ApiError> {
    optional_header(headers, "if-match")?
        .ok_or_else(|| ApiError::precondition_required("send If-Match: <etag> to delete a draft"))
}

pub(crate) fn optional_header(
    headers: &HeaderMap,
    name: &'static str,
) -> Result<Option<String>, ApiError> {
    headers
        .get(name)
        .map(|value| {
            value.to_str().map(str::to_string).map_err(|_| {
                ApiError::bad_request(
                    "invalid_header",
                    format!("{name} contains non-UTF-8 header data"),
                )
            })
        })
        .transpose()
}

pub(crate) fn header_str<'a>(headers: &'a HeaderMap, name: &'static str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

pub(crate) fn validate_draft_song_document(
    song_id: &str,
    document: &Value,
) -> Result<(), ApiError> {
    let object = document.as_object().ok_or_else(|| {
        ApiError::bad_request("invalid_song", "draft song document must be a JSON object")
    })?;

    require_string_field(object.get("entityType"), "entityType", "draftSong")?;
    require_string_field(object.get("songId"), "songId", song_id)?;

    if !object.get("recordings").is_some_and(Value::is_array) {
        return Err(ApiError::bad_request(
            "invalid_song",
            "draft song document must include a recordings array",
        ));
    }

    Ok(())
}

pub(crate) fn validate_draft_release_document(
    release_id: &str,
    document: &Value,
) -> Result<(), ApiError> {
    let object = document.as_object().ok_or_else(|| {
        ApiError::bad_request(
            "invalid_release",
            "draft release document must be a JSON object",
        )
    })?;

    require_string_field(object.get("entityType"), "entityType", "draftRelease")?;
    require_string_field(object.get("releaseId"), "releaseId", release_id)?;

    if !object.get("tracks").is_some_and(Value::is_array) {
        return Err(ApiError::bad_request(
            "invalid_release",
            "draft release document must include a tracks array",
        ));
    }

    Ok(())
}

pub(crate) fn validate_source_master(
    source_master: &DraftSourceMaster,
    masters_bucket: &str,
    recording_id: &str,
) -> Result<(), ApiError> {
    if source_master.bucket != masters_bucket {
        return Err(ApiError::bad_request(
            "invalid_source_master_bucket",
            "recording sourceMaster bucket does not match the configured masters bucket",
        ));
    }

    let expected_prefix = format!("masters/{recording_id}/source.");
    if !source_master.key.starts_with(&expected_prefix) {
        return Err(ApiError::bad_request(
            "invalid_source_master_key",
            format!("recording sourceMaster key must start with {expected_prefix}"),
        ));
    }

    let format = source_master
        .key
        .rsplit_once('.')
        .map(|(_, extension)| extension)
        .unwrap_or("");
    if !matches!(format, "wav" | "aif" | "aiff" | "flac") {
        return Err(ApiError::bad_request(
            "unsupported_source_master_format",
            "recording sourceMaster key must end with wav, aif, aiff, or flac",
        ));
    }

    if let Some(declared_format) = &source_master.format {
        let expected_format = if matches!(format, "aif" | "aiff") {
            "aiff"
        } else {
            format
        };
        if declared_format != expected_format {
            return Err(ApiError::bad_request(
                "source_master_format_mismatch",
                format!("recording sourceMaster format must be {expected_format}"),
            ));
        }
    }

    if source_master.sample_rate_hz == Some(0) || source_master.channels == Some(0) {
        return Err(ApiError::bad_request(
            "invalid_source_master_metadata",
            "recording sourceMaster sampleRateHz and channels must be positive when provided",
        ));
    }

    if let Some(uploaded_at) = &source_master.uploaded_at {
        DateTime::parse_from_rfc3339(uploaded_at).map_err(|err| {
            ApiError::bad_request(
                "invalid_source_master_uploaded_at",
                format!("recording sourceMaster uploadedAt must be RFC3339: {err}"),
            )
        })?;
    }

    Ok(())
}

pub(crate) fn normalize_updated_at(document: &mut Value) {
    if let Some(object) = document.as_object_mut() {
        object.insert(
            "updatedAt".to_string(),
            Value::String(Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)),
        );
    }
}

pub(crate) fn require_string_field(
    value: Option<&Value>,
    field: &'static str,
    expected: &str,
) -> Result<(), ApiError> {
    match value.and_then(Value::as_str) {
        Some(actual) if actual == expected => Ok(()),
        _ => Err(ApiError::bad_request(
            "invalid_manifest_field",
            format!("{field} must be {expected}"),
        )),
    }
}

pub(crate) fn validate_stable_id(
    prefix: &str,
    value: &str,
    field: &'static str,
) -> Result<(), ApiError> {
    let expected_prefix = format!("{prefix}_");
    let suffix = value.strip_prefix(&expected_prefix).ok_or_else(|| {
        ApiError::bad_request(
            "invalid_stable_id",
            format!("{field} must start with {expected_prefix}"),
        )
    })?;

    if !(3..=97).contains(&suffix.len()) {
        return Err(ApiError::bad_request(
            "invalid_stable_id",
            format!("{field} has an invalid length"),
        ));
    }

    let mut chars = suffix.chars();
    let first = chars.next().expect("suffix length checked");
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return Err(ApiError::bad_request(
            "invalid_stable_id",
            format!("{field} must have a lowercase alphanumeric first suffix character"),
        ));
    }

    if !chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-') {
        return Err(ApiError::bad_request(
            "invalid_stable_id",
            format!("{field} may only contain lowercase letters, digits, hyphens, and underscores"),
        ));
    }

    Ok(())
}

pub(crate) fn validate_optional_stable_id(
    prefix: &str,
    value: Option<&str>,
    field: &'static str,
) -> Result<(), ApiError> {
    if let Some(value) = value {
        validate_stable_id(prefix, value, field)?;
    }

    Ok(())
}

pub(crate) fn validate_session_id(value: &str, field: &'static str) -> Result<(), ApiError> {
    if !(8..=128).contains(&value.len()) {
        return Err(ApiError::bad_request(
            "invalid_session_id",
            format!("{field} has an invalid length"),
        ));
    }

    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(ApiError::bad_request(
            "invalid_session_id",
            format!("{field} may only contain letters, digits, hyphens, and underscores"),
        ));
    }

    Ok(())
}

pub(crate) fn validate_optional_short_text(
    value: Option<&str>,
    field: &'static str,
    max_len: usize,
) -> Result<(), ApiError> {
    if let Some(value) = value {
        if value.is_empty() || value.len() > max_len || value.chars().any(char::is_control) {
            return Err(ApiError::bad_request(
                "invalid_text_field",
                format!("{field} has an invalid value"),
            ));
        }
    }

    Ok(())
}

pub(crate) fn validate_optional_path(
    value: Option<&str>,
    field: &'static str,
) -> Result<(), ApiError> {
    if let Some(value) = value {
        if value.is_empty()
            || value.len() > 512
            || !value.starts_with('/')
            || value.chars().any(char::is_control)
        {
            return Err(ApiError::bad_request(
                "invalid_path",
                format!("{field} has an invalid value"),
            ));
        }
    }

    Ok(())
}

pub(crate) fn validate_optional_url_origin(
    value: Option<&str>,
    field: &'static str,
) -> Result<(), ApiError> {
    if let Some(value) = value {
        let valid = value.len() <= 256
            && (value.starts_with("https://") || value.starts_with("http://"))
            && !value.contains('?')
            && !value.contains('#')
            && !value.chars().any(char::is_control);
        if !valid {
            return Err(ApiError::bad_request(
                "invalid_origin",
                format!("{field} has an invalid value"),
            ));
        }
    }

    Ok(())
}

pub(crate) fn validate_optional_seconds(
    value: Option<f64>,
    field: &'static str,
) -> Result<(), ApiError> {
    if let Some(value) = value {
        if !value.is_finite() || !(0.0..=86_400.0).contains(&value) {
            return Err(ApiError::bad_request(
                "invalid_seconds",
                format!("{field} has an invalid value"),
            ));
        }
    }

    Ok(())
}

pub(crate) fn validate_artwork_dimensions(width: u32, height: u32) -> Result<(), ApiError> {
    if width == 0 || height == 0 || width > 12_000 || height > 12_000 {
        return Err(ApiError::bad_request(
            "invalid_artwork_dimensions",
            "artwork width and height must be between 1 and 12000 pixels",
        ));
    }

    Ok(())
}

pub(crate) fn validate_artwork_alt_text(value: &str) -> Result<(), ApiError> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 180 || trimmed.chars().any(char::is_control) {
        return Err(ApiError::bad_request(
            "invalid_artwork_alt_text",
            "artwork altText must be non-empty text up to 180 characters",
        ));
    }

    Ok(())
}

pub(crate) fn validate_slug(value: &str, field: &'static str) -> Result<(), ApiError> {
    if value.is_empty() || value.len() > 120 {
        return Err(ApiError::bad_request(
            "invalid_slug",
            format!("{field} has an invalid length"),
        ));
    }

    let mut previous_was_hyphen = false;
    for (index, c) in value.chars().enumerate() {
        let valid = c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-';
        if !valid {
            return Err(ApiError::bad_request(
                "invalid_slug",
                format!("{field} may only contain lowercase letters, digits, and hyphens"),
            ));
        }
        if c == '-' {
            if index == 0 || previous_was_hyphen {
                return Err(ApiError::bad_request(
                    "invalid_slug",
                    format!("{field} must not contain empty slug segments"),
                ));
            }
            previous_was_hyphen = true;
        } else {
            previous_was_hyphen = false;
        }
    }

    if previous_was_hyphen {
        return Err(ApiError::bad_request(
            "invalid_slug",
            format!("{field} must not end with a hyphen"),
        ));
    }

    Ok(())
}

pub(crate) fn validate_filename(filename: &str) -> Result<(), ApiError> {
    if filename.is_empty() || filename == "." || filename == ".." {
        return Err(ApiError::bad_request(
            "invalid_filename",
            "filename must not be empty",
        ));
    }

    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err(ApiError::bad_request(
            "invalid_filename",
            "filename must not contain path segments",
        ));
    }

    if !filename
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        return Err(ApiError::bad_request(
            "invalid_filename",
            "filename may only contain ASCII letters, digits, dot, hyphen, and underscore",
        ));
    }

    Ok(())
}

pub(crate) fn infer_artwork_format(
    filename: &str,
    requested_content_type: Option<&str>,
) -> Result<UploadFormat<'static>, ApiError> {
    let lower = filename.to_ascii_lowercase();
    let format = if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        UploadFormat {
            extension: "jpg",
            format: "jpeg",
            content_type: "image/jpeg",
        }
    } else if lower.ends_with(".png") {
        UploadFormat {
            extension: "png",
            format: "png",
            content_type: "image/png",
        }
    } else if lower.ends_with(".webp") {
        UploadFormat {
            extension: "webp",
            format: "webp",
            content_type: "image/webp",
        }
    } else if lower.ends_with(".avif") {
        UploadFormat {
            extension: "avif",
            format: "avif",
            content_type: "image/avif",
        }
    } else {
        return Err(ApiError::bad_request(
            "unsupported_artwork_format",
            "artwork must be JPG, PNG, WEBP, or AVIF",
        ));
    };

    if let Some(requested) = requested_content_type {
        let allowed = match format.format {
            "jpeg" => ["image/jpeg", "image/jpg", "image/pjpeg"].as_slice(),
            "png" => ["image/png"].as_slice(),
            "webp" => ["image/webp"].as_slice(),
            "avif" => ["image/avif"].as_slice(),
            _ => &[],
        };

        if !allowed.contains(&requested) {
            return Err(ApiError::bad_request(
                "content_type_mismatch",
                format!("{requested} is not valid for artwork {}", format.extension),
            ));
        }
    }

    Ok(format)
}

pub(crate) fn infer_upload_format(
    filename: &str,
    requested_content_type: Option<&str>,
) -> Result<UploadFormat<'static>, ApiError> {
    let lower = filename.to_ascii_lowercase();
    let format = if lower.ends_with(".wav") {
        UploadFormat {
            extension: "wav",
            format: "wav",
            content_type: "audio/wav",
        }
    } else if lower.ends_with(".aif") {
        UploadFormat {
            extension: "aif",
            format: "aiff",
            content_type: "audio/aiff",
        }
    } else if lower.ends_with(".aiff") {
        UploadFormat {
            extension: "aiff",
            format: "aiff",
            content_type: "audio/aiff",
        }
    } else if lower.ends_with(".flac") {
        UploadFormat {
            extension: "flac",
            format: "flac",
            content_type: "audio/flac",
        }
    } else {
        return Err(ApiError::bad_request(
            "unsupported_master_format",
            "source masters must be WAV, AIFF, or FLAC",
        ));
    };

    if let Some(requested) = requested_content_type {
        let allowed = match format.format {
            "wav" => ["audio/wav", "audio/x-wav", "audio/wave"].as_slice(),
            "aiff" => ["audio/aiff", "audio/x-aiff"].as_slice(),
            "flac" => ["audio/flac", "audio/x-flac"].as_slice(),
            _ => &[],
        };

        if !allowed.contains(&requested) {
            return Err(ApiError::bad_request(
                "content_type_mismatch",
                format!("{requested} is not valid for {}", format.extension),
            ));
        }
    }

    Ok(format)
}
