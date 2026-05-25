use super::AppState;
use crate::{
    build_player_rum_query, build_rum_summary, db, ApiError, RumSummaryQuery, RumSummaryResponse,
    MAX_RUM_QUERY_RESULTS, RUM_QUERY_POLL_ATTEMPTS, RUM_QUERY_POLL_INTERVAL,
};
use aws_sdk_cloudwatchlogs::types::QueryStatus;
use chrono::{Duration as ChronoDuration, SecondsFormat, Utc};
use std::collections::HashMap;
use tokio::time::sleep;
use tracing::error;

impl AppState {
    pub(crate) async fn get_rum_summary(
        &self,
        query: RumSummaryQuery,
    ) -> Result<RumSummaryResponse, ApiError> {
        let end_time = Utc::now();
        let start_time = end_time - ChronoDuration::hours(i64::from(query.hours));
        let query_string = build_player_rum_query();
        let started = self
            .cloudwatch_logs
            .start_query()
            .log_group_name(&self.rum_log_group_name)
            .start_time(start_time.timestamp())
            .end_time(end_time.timestamp())
            .limit(MAX_RUM_QUERY_RESULTS)
            .query_string(query_string)
            .send()
            .await
            .map_err(|err| {
                error!(error = %err, log_group = self.rum_log_group_name, "Failed to start RUM Logs Insights query");
                ApiError::bad_gateway("rum_query_start_failed", "failed to start RUM stats query")
            })?;

        let query_id = started.query_id().ok_or_else(|| {
            ApiError::bad_gateway(
                "rum_query_missing_id",
                "CloudWatch Logs did not return a query id",
            )
        })?;
        let rows = self.await_logs_query(query_id).await?;

        let mut summary = build_rum_summary(
            &self.rum_log_group_name,
            query_id,
            query.hours,
            start_time.to_rfc3339_opts(SecondsFormat::Secs, true),
            end_time.to_rfc3339_opts(SecondsFormat::Secs, true),
            rows,
        );
        summary.backend_play_events =
            db::get_backend_play_summary(&self.db, start_time, end_time).await?;

        Ok(summary)
    }

    async fn await_logs_query(
        &self,
        query_id: &str,
    ) -> Result<Vec<HashMap<String, String>>, ApiError> {
        for _ in 0..RUM_QUERY_POLL_ATTEMPTS {
            let output = self
                .cloudwatch_logs
                .get_query_results()
                .query_id(query_id)
                .send()
                .await
                .map_err(|err| {
                    error!(query_id, error = %err, "Failed to read RUM Logs Insights query results");
                    ApiError::bad_gateway(
                        "rum_query_results_failed",
                        "failed to read RUM stats query results",
                    )
                })?;

            match output.status() {
                Some(QueryStatus::Complete) => {
                    return Ok(output
                        .results()
                        .iter()
                        .map(|fields| {
                            let mut row = HashMap::new();
                            for field in fields {
                                if let (Some(name), Some(value)) = (field.field(), field.value()) {
                                    row.insert(name.to_string(), value.to_string());
                                }
                            }
                            row
                        })
                        .collect());
                }
                Some(QueryStatus::Failed) => {
                    return Err(ApiError::bad_gateway(
                        "rum_query_failed",
                        "RUM stats query failed",
                    ))
                }
                Some(QueryStatus::Cancelled) => {
                    return Err(ApiError::bad_gateway(
                        "rum_query_cancelled",
                        "RUM stats query was cancelled",
                    ))
                }
                Some(QueryStatus::Timeout) => {
                    return Err(ApiError::bad_gateway(
                        "rum_query_timeout",
                        "RUM stats query timed out",
                    ))
                }
                _ => sleep(RUM_QUERY_POLL_INTERVAL).await,
            }
        }

        Err(ApiError::bad_gateway(
            "rum_query_poll_timeout",
            "RUM stats query did not complete before the API timeout budget",
        ))
    }
}
