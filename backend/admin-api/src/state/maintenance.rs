use super::AppState;
use crate::{
    db, ApiError, MaintenanceCleanupRequest, MaintenanceCleanupResponse, StaleMediaPrefix,
};
use aws_sdk_s3::types::{Delete, ObjectIdentifier};
use std::collections::{HashMap, HashSet};
use tracing::error;

const DRAFT_ENCODE_PREFIX: &str = "draft/encodes/";
const RECORDINGS_PREFIX: &str = "recordings/";
const CURRENT_RECORDING_FILES_SEGMENT: &str = "files";
const S3_DELETE_BATCH_SIZE: usize = 1000;

#[derive(Debug, Clone)]
struct MediaObjectSummary {
    key: String,
    size_bytes: u64,
}

#[derive(Debug)]
struct LegacyMediaPrefix {
    prefix: String,
    reason: &'static str,
}

#[derive(Debug, Default)]
struct PrefixSummary {
    object_count: usize,
    size_bytes: u64,
    reason: &'static str,
}

impl AppState {
    pub(crate) async fn maintenance_report(&self) -> Result<crate::MaintenanceReport, ApiError> {
        let mut report = db::maintenance_report(&self.db).await?;
        let active_paths = db::active_media_paths(&self.db).await?;
        report.stale_media_prefixes = self.stale_media_prefixes(&active_paths).await?;
        report.totals.stale_media_prefixes = report.stale_media_prefixes.len();
        Ok(report)
    }

    pub(crate) async fn cleanup_maintenance(
        &self,
        request: MaintenanceCleanupRequest,
    ) -> Result<MaintenanceCleanupResponse, ApiError> {
        let report = self.maintenance_report().await?;
        validate_media_cleanup_request(&request, &report)?;
        let media_prefixes = dedupe_strings(request.media_prefixes.clone());

        let mut response = db::cleanup_maintenance(&self.db, request).await?;
        for prefix in &media_prefixes {
            self.delete_media_prefix(prefix).await?;
        }
        db::remove_recording_files_with_prefixes(&self.db, &media_prefixes).await?;
        response.deleted.media_prefixes = media_prefixes.len();
        response.report = self.maintenance_report().await?;
        Ok(response)
    }

    async fn stale_media_prefixes(
        &self,
        active_paths: &HashSet<String>,
    ) -> Result<Vec<StaleMediaPrefix>, ApiError> {
        let mut objects = self.list_media_objects(DRAFT_ENCODE_PREFIX).await?;
        objects.extend(self.list_media_objects(RECORDINGS_PREFIX).await?);
        Ok(stale_media_prefixes_from_objects(&objects, active_paths))
    }

    async fn list_media_objects(&self, prefix: &str) -> Result<Vec<MediaObjectSummary>, ApiError> {
        let mut objects = Vec::new();
        let mut continuation_token = None;

        loop {
            let mut request = self
                .s3
                .list_objects_v2()
                .bucket(&self.media_bucket)
                .prefix(prefix);
            if let Some(token) = continuation_token {
                request = request.continuation_token(token);
            }

            let output = request.send().await.map_err(|err| {
                let detail = error_chain(&err);
                error!(
                    prefix,
                    detail = %detail,
                    error = ?err,
                    "Failed to list media objects for maintenance"
                );
                ApiError::internal(
                    "s3_list_failed",
                    format!("failed to list media prefix {prefix}: {detail}"),
                )
            })?;

            objects.extend(output.contents().iter().filter_map(|object| {
                let key = object.key()?.to_string();
                (!key.ends_with('/')).then(|| MediaObjectSummary {
                    key,
                    size_bytes: object.size().unwrap_or_default().max(0) as u64,
                })
            }));

            if output.is_truncated().unwrap_or(false) {
                continuation_token = output.next_continuation_token().map(str::to_string);
                if continuation_token.is_none() {
                    return Err(ApiError::internal(
                        "s3_list_pagination_failed",
                        "S3 list response was truncated without a continuation token",
                    ));
                }
            } else {
                break;
            }
        }

        Ok(objects)
    }

    async fn delete_media_prefix(&self, prefix: &str) -> Result<(), ApiError> {
        let keys = self
            .list_media_objects(prefix)
            .await?
            .into_iter()
            .map(|object| object.key)
            .collect::<Vec<_>>();

        for chunk in keys.chunks(S3_DELETE_BATCH_SIZE) {
            self.delete_media_keys(chunk).await?;
        }

        Ok(())
    }

    async fn delete_media_keys(&self, keys: &[String]) -> Result<(), ApiError> {
        if keys.is_empty() {
            return Ok(());
        }

        let mut delete = Delete::builder().quiet(true);
        for key in keys {
            let object = ObjectIdentifier::builder()
                .key(key.as_str())
                .build()
                .map_err(|err| {
                    ApiError::internal(
                        "s3_delete_build_failed",
                        format!("failed to build S3 delete object: {err}"),
                    )
                })?;
            delete = delete.objects(object);
        }
        let delete = delete.build().map_err(|err| {
            ApiError::internal(
                "s3_delete_build_failed",
                format!("failed to build S3 delete request: {err}"),
            )
        })?;

        let output = self
            .s3
            .delete_objects()
            .bucket(&self.media_bucket)
            .delete(delete)
            .send()
            .await
            .map_err(|err| {
                let detail = error_chain(&err);
                error!(
                    detail = %detail,
                    error = ?err,
                    "Failed to delete stale media objects"
                );
                ApiError::internal(
                    "s3_delete_failed",
                    format!("failed to delete stale media objects: {detail}"),
                )
            })?;

        if let Some(first_error) = output.errors().first() {
            return Err(ApiError::internal(
                "s3_delete_failed",
                format!(
                    "failed to delete {}: {}",
                    first_error.key().unwrap_or("(unknown object)"),
                    first_error
                        .message()
                        .unwrap_or("S3 returned an object delete error")
                ),
            ));
        }

        Ok(())
    }
}

fn validate_media_cleanup_request(
    request: &MaintenanceCleanupRequest,
    report: &crate::MaintenanceReport,
) -> Result<(), ApiError> {
    let allowed = report
        .stale_media_prefixes
        .iter()
        .map(|item| item.prefix.as_str())
        .collect::<HashSet<_>>();
    for prefix in &request.media_prefixes {
        if !allowed.contains(prefix.as_str()) {
            return Err(ApiError::bad_request(
                "invalid_cleanup_target",
                format!("media prefix {prefix} is not currently a stale cleanup candidate"),
            ));
        }
    }
    Ok(())
}

fn stale_media_prefixes_from_objects(
    objects: &[MediaObjectSummary],
    active_paths: &HashSet<String>,
) -> Vec<StaleMediaPrefix> {
    let active_legacy_prefixes = active_paths
        .iter()
        .filter_map(|path| legacy_media_prefix_for_key(path).map(|legacy| legacy.prefix))
        .collect::<HashSet<_>>();
    let mut prefixes = HashMap::<String, PrefixSummary>::new();
    for object in objects {
        let Some(legacy) = legacy_media_prefix_for_key(&object.key) else {
            continue;
        };
        if active_legacy_prefixes.contains(&legacy.prefix) {
            continue;
        }
        let entry = prefixes
            .entry(legacy.prefix)
            .or_insert_with(|| PrefixSummary {
                reason: legacy.reason,
                ..PrefixSummary::default()
            });
        entry.object_count += 1;
        entry.size_bytes += object.size_bytes;
    }

    let mut stale = prefixes
        .into_iter()
        .map(|(prefix, summary)| StaleMediaPrefix {
            prefix,
            object_count: summary.object_count,
            size_bytes: summary.size_bytes,
            reason: summary.reason.to_string(),
        })
        .collect::<Vec<_>>();
    stale.sort_by(|left, right| left.prefix.cmp(&right.prefix));
    stale
}

fn legacy_media_prefix_for_key(key: &str) -> Option<LegacyMediaPrefix> {
    if let Some(rest) = key.strip_prefix(DRAFT_ENCODE_PREFIX) {
        let job_id = first_segment(rest)?;
        if job_id.starts_with("job_") {
            return Some(LegacyMediaPrefix {
                prefix: format!("{DRAFT_ENCODE_PREFIX}{job_id}/"),
                reason: "legacy_draft_encode_output",
            });
        }
    }

    let rest = key.strip_prefix(RECORDINGS_PREFIX)?;
    let recording_id = first_segment(rest)?;
    let rest = rest.strip_prefix(recording_id)?.strip_prefix('/')?;
    let media_set = first_segment(rest)?;
    if recording_id.starts_with("recording_")
        && media_set.starts_with("job_")
        && media_set != CURRENT_RECORDING_FILES_SEGMENT
    {
        return Some(LegacyMediaPrefix {
            prefix: format!("{RECORDINGS_PREFIX}{recording_id}/{media_set}/"),
            reason: "legacy_public_recording_copy",
        });
    }

    None
}

fn first_segment(value: &str) -> Option<&str> {
    value
        .split('/')
        .next()
        .filter(|segment| !segment.is_empty())
}

fn dedupe_strings(items: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut deduped = Vec::new();
    for item in items {
        if seen.insert(item.clone()) {
            deduped.push(item);
        }
    }
    deduped
}

fn error_chain<E: std::error::Error + 'static>(err: &E) -> String {
    let mut parts = vec![err.to_string()];
    let mut current = err.source();
    while let Some(inner) = current {
        let text = inner.to_string();
        if !text.is_empty() && parts.last().map(String::as_str) != Some(text.as_str()) {
            parts.push(text);
        }
        current = inner.source();
    }
    parts.join(": ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(key: &str, size_bytes: u64) -> MediaObjectSummary {
        MediaObjectSummary {
            key: key.to_string(),
            size_bytes,
        }
    }

    #[test]
    fn identifies_legacy_media_prefixes() {
        assert_eq!(
            legacy_media_prefix_for_key("draft/encodes/job_a/hls/master.m3u8")
                .unwrap()
                .prefix,
            "draft/encodes/job_a/"
        );
        assert_eq!(
            legacy_media_prefix_for_key("recordings/recording_a/job_a/hls/master.m3u8")
                .unwrap()
                .prefix,
            "recordings/recording_a/job_a/"
        );
        assert!(legacy_media_prefix_for_key(
            "recordings/recording_a/files/20260526/hls/master.m3u8"
        )
        .is_none());
        assert!(legacy_media_prefix_for_key("artwork/releases/release_a/cover.jpg").is_none());
    }

    #[test]
    fn groups_unreferenced_legacy_media_prefixes() {
        let active_paths = HashSet::from([String::from(
            "recordings/recording_live/job_keep/hls/master.m3u8",
        )]);
        let stale = stale_media_prefixes_from_objects(
            &[
                object("draft/encodes/job_old/hls/master.m3u8", 100),
                object("draft/encodes/job_old/hls/segment0.ts", 200),
                object("recordings/recording_live/job_keep/hls/master.m3u8", 300),
                object("recordings/recording_live/job_keep/hls/segment0.ts", 300),
                object("recordings/recording_live/job_old/hls/master.m3u8", 400),
                object(
                    "recordings/recording_live/files/20260526/hls/master.m3u8",
                    500,
                ),
            ],
            &active_paths,
        );

        assert_eq!(stale.len(), 2);
        assert_eq!(stale[0].prefix, "draft/encodes/job_old/");
        assert_eq!(stale[0].object_count, 2);
        assert_eq!(stale[0].size_bytes, 300);
        assert_eq!(stale[1].prefix, "recordings/recording_live/job_old/");
    }
}
