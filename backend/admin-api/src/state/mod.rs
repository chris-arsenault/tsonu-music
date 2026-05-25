mod analytics;
mod encoding;
mod publishing;
mod rum;
mod uploads;

use crate::{required_env, split_env_list, ConfigError, DEFAULT_ALLOWED_ORIGINS};
use aws_sdk_cloudfront::Client as CloudFrontClient;
use aws_sdk_cloudwatchlogs::Client as CloudWatchLogsClient;
use aws_sdk_lambda::Client as LambdaClient;
use aws_sdk_s3::Client as S3Client;
use lambda_http::http::{HeaderMap, HeaderValue};
use lambda_http::{Body, Response};
use sqlx::PgPool;
use std::env;

#[derive(Clone)]
pub struct AppState {
    db: PgPool,
    s3: S3Client,
    cloudfront: CloudFrontClient,
    cloudwatch_logs: CloudWatchLogsClient,
    lambda: LambdaClient,
    encoder_function_name: String,
    masters_bucket: String,
    media_bucket: String,
    media_base_url: String,
    frontend_distribution_id: String,
    rum_log_group_name: String,
    allowed_origins: Vec<String>,
}

impl AppState {
    pub fn from_env(
        db: PgPool,
        s3: S3Client,
        cloudfront: CloudFrontClient,
        cloudwatch_logs: CloudWatchLogsClient,
        lambda: LambdaClient,
    ) -> Result<Self, ConfigError> {
        Ok(Self {
            db,
            s3,
            cloudfront,
            cloudwatch_logs,
            lambda,
            encoder_function_name: required_env("ENCODER_FUNCTION_NAME")?,
            masters_bucket: required_env("MASTERS_BUCKET")?,
            media_bucket: required_env("MEDIA_BUCKET")?,
            media_base_url: required_env("MEDIA_BASE_URL")?,
            frontend_distribution_id: required_env("FRONTEND_DISTRIBUTION_ID")?,
            rum_log_group_name: required_env("RUM_LOG_GROUP_NAME")?,
            allowed_origins: env::var("ALLOWED_ORIGINS")
                .ok()
                .map(|origins| split_env_list(&origins))
                .filter(|origins| !origins.is_empty())
                .unwrap_or_else(|| {
                    DEFAULT_ALLOWED_ORIGINS
                        .iter()
                        .map(|origin| (*origin).to_string())
                        .collect()
                }),
        })
    }

    pub(crate) fn media_base_url(&self) -> &str {
        &self.media_base_url
    }

    pub(crate) fn db(&self) -> &PgPool {
        &self.db
    }

    pub(crate) fn cors_origin(&self, headers: &HeaderMap) -> Option<String> {
        let origin = headers.get("origin")?.to_str().ok()?;
        if self.allowed_origins.iter().any(|allowed| allowed == "*") {
            return Some("*".to_string());
        }

        self.allowed_origins
            .iter()
            .any(|allowed| allowed == origin)
            .then(|| origin.to_string())
    }

    pub(crate) fn decorate_response(
        &self,
        response: &mut Response<Body>,
        cors_origin: Option<String>,
    ) {
        let headers = response.headers_mut();
        headers.insert(
            "cache-control",
            HeaderValue::from_static("no-store, max-age=0"),
        );
        if let Some(origin) = cors_origin {
            if let Ok(origin) = HeaderValue::from_str(&origin) {
                headers.insert("access-control-allow-origin", origin);
                headers.insert("vary", HeaderValue::from_static("Origin"));
                headers.insert(
                    "access-control-allow-headers",
                    HeaderValue::from_static("Authorization, Content-Type"),
                );
                headers.insert(
                    "access-control-allow-methods",
                    HeaderValue::from_static("GET, HEAD, POST, PUT, DELETE, OPTIONS"),
                );
                headers.insert("access-control-max-age", HeaderValue::from_static("600"));
            }
        }
    }
}
