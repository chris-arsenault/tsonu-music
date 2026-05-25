use super::AppState;
use crate::{
    infer_upload_format, master_key, validate_filename, validate_stable_id, ApiError,
    SourceMasterDraft, UploadHeaders, UploadUrlRequest, UploadUrlResponse,
    DEFAULT_UPLOAD_URL_EXPIRY_SECONDS, MAX_UPLOAD_URL_EXPIRY_SECONDS,
};
use aws_sdk_s3::presigning::PresigningConfig;
use chrono::{SecondsFormat, Utc};
use std::time::Duration;
use tracing::error;

impl AppState {
    pub(crate) async fn create_upload_url(
        &self,
        request: UploadUrlRequest,
    ) -> Result<UploadUrlResponse, ApiError> {
        validate_stable_id("recording", &request.recording_id, "recordingId")?;
        validate_filename(&request.filename)?;

        let upload_format =
            infer_upload_format(&request.filename, request.content_type.as_deref())?;
        let expires_in_seconds = request
            .expires_in_seconds
            .unwrap_or(DEFAULT_UPLOAD_URL_EXPIRY_SECONDS);

        if !(60..=MAX_UPLOAD_URL_EXPIRY_SECONDS).contains(&expires_in_seconds) {
            return Err(ApiError::bad_request(
                "invalid_expiry",
                format!("expiresInSeconds must be between 60 and {MAX_UPLOAD_URL_EXPIRY_SECONDS}"),
            ));
        }

        let key = master_key(&request.recording_id, upload_format.extension);
        let presigning_config = PresigningConfig::expires_in(Duration::from_secs(
            expires_in_seconds,
        ))
        .map_err(|err| {
            error!(error = %err, "Failed to create S3 presigning config");
            ApiError::internal("presign_config_failed", "failed to configure upload URL")
        })?;

        let presigned = self
            .s3
            .put_object()
            .bucket(&self.masters_bucket)
            .key(&key)
            .content_type(upload_format.content_type)
            .presigned(presigning_config)
            .await
            .map_err(|err| {
                error!(key, error = %err, "Failed to presign S3 upload");
                ApiError::internal("presign_failed", "failed to create upload URL")
            })?;

        Ok(UploadUrlResponse {
            bucket: self.masters_bucket.clone(),
            key: key.clone(),
            url: presigned.uri().to_string(),
            method: "PUT",
            headers: UploadHeaders {
                content_type: upload_format.content_type.to_string(),
            },
            expires_in_seconds,
            source_master: SourceMasterDraft {
                bucket: self.masters_bucket.clone(),
                key,
                format: upload_format.format.to_string(),
                uploaded_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
            },
        })
    }
}
