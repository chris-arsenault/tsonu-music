use super::AppState;
use crate::{
    build_encode_job_event, db, validate_source_master, validate_stable_id, ApiError, DraftSong,
    EncodeJobCreateResponse, EncodeJobRequest,
};
use aws_sdk_lambda::primitives::Blob;
use aws_sdk_lambda::types::InvocationType;
use chrono::{SecondsFormat, Utc};
use encode_contract::{build_job_id, planned_output, EncodeJob};
use tracing::error;

impl AppState {
    pub(crate) async fn create_encode_job(
        &self,
        request: EncodeJobRequest,
    ) -> Result<EncodeJobCreateResponse, ApiError> {
        validate_stable_id("song", &request.song_id, "songId")?;
        validate_stable_id("recording", &request.recording_id, "recordingId")?;

        if let Some(job_id) = &request.job_id {
            validate_stable_id("job", job_id, "jobId")?;
        }

        let song_object = db::get_draft_song(&self.db, &request.song_id).await?;
        let song: DraftSong = serde_json::from_str(&song_object.text).map_err(|err| {
            error!(song_id = request.song_id, error = %err, "Stored draft song cannot be parsed for encode job");
            ApiError::internal("invalid_stored_song", "stored draft song cannot be parsed")
        })?;

        if song.song_id != request.song_id {
            return Err(ApiError::bad_request(
                "song_id_mismatch",
                "draft song songId does not match request songId",
            ));
        }

        let recording = song
            .recordings
            .iter()
            .find(|recording| recording.recording_id == request.recording_id)
            .ok_or_else(|| ApiError::not_found("recording not found in draft song"))?;

        let source_master = recording.source_master.as_ref().ok_or_else(|| {
            ApiError::bad_request(
                "missing_source_master",
                format!(
                    "recording {} does not have a sourceMaster",
                    recording.recording_id
                ),
            )
        })?;

        validate_source_master(source_master, &self.masters_bucket, &request.recording_id)?;

        let now = Utc::now();
        let requested_at = now.to_rfc3339_opts(SecondsFormat::Secs, true);
        let timestamp = now
            .format("%Y%m%dT%H%M%SZ")
            .to_string()
            .to_ascii_lowercase();
        let job_id = request
            .job_id
            .clone()
            .unwrap_or_else(|| build_job_id(&request.recording_id, &timestamp));
        validate_stable_id("job", &job_id, "jobId")?;

        let include_lossless = request.include_lossless.unwrap_or(false);
        let output = planned_output(
            &request.recording_id,
            &timestamp,
            self.media_bucket.clone(),
            include_lossless,
        );
        let prepared = build_encode_job_event(
            request,
            recording,
            source_master,
            job_id,
            requested_at,
            output,
            include_lossless,
        );
        let mut job = prepared.job;
        let job_key = prepared.job_key;
        db::put_encode_job(&self.db, &job).await?;
        db::prepare_recording_for_encode(&self.db, &job.song_id, &job.recording_id, &job.job_id)
            .await?;

        let payload = serde_json::to_vec(&prepared.event).map_err(|err| {
            error!(job_id = job.job_id, error = %err, "Failed to serialize encoder invocation payload");
            ApiError::internal(
                "encoder_payload_serialize_failed",
                "failed to serialize encoder invocation payload",
            )
        })?;

        let invoke_result = self
            .lambda
            .invoke()
            .function_name(&self.encoder_function_name)
            .invocation_type(InvocationType::Event)
            .payload(Blob::new(payload))
            .send()
            .await;

        let invocation_status_code = match invoke_result {
            Ok(output) if output.status_code() == 202 => output.status_code(),
            Ok(output) => {
                let details = format!("unexpected Lambda invoke status {}", output.status_code());
                self.mark_job_failed_after_invoke_error(&mut job, details.clone())
                    .await?;
                return Err(ApiError::bad_gateway(
                    "encoder_invoke_failed",
                    format!("encoder Lambda invocation failed: {details}"),
                ));
            }
            Err(err) => {
                let details = err.to_string();
                self.mark_job_failed_after_invoke_error(&mut job, details.clone())
                    .await?;
                return Err(ApiError::bad_gateway(
                    "encoder_invoke_failed",
                    format!("encoder Lambda invocation failed: {details}"),
                ));
            }
        };

        Ok(EncodeJobCreateResponse {
            job,
            job_key,
            encoder_function_name: self.encoder_function_name.clone(),
            invocation_status_code,
        })
    }

    async fn mark_job_failed_after_invoke_error(
        &self,
        job: &mut EncodeJob,
        details: String,
    ) -> Result<(), ApiError> {
        job.mark_failed(
            Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
            "encoder_invoke_failed",
            "encoder Lambda invocation failed",
            Some(details),
        );
        db::put_encode_job(&self.db, job).await
    }
}
