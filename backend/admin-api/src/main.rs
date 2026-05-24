use admin_api::{connect_pool_from_env, handle_request, AppState};
use aws_sdk_cloudfront::Client as CloudFrontClient;
use aws_sdk_cloudwatchlogs::Client as CloudWatchLogsClient;
use aws_sdk_lambda::Client as LambdaClient;
use aws_sdk_s3::Client as S3Client;
use lambda_http::{run, service_fn, Error};
use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env().add_directive("info".parse()?),
        )
        .without_time()
        .init();

    let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
    let db = connect_pool_from_env().await?;
    let state = Arc::new(AppState::from_env(
        db,
        S3Client::new(&aws_config),
        CloudFrontClient::new(&aws_config),
        CloudWatchLogsClient::new(&aws_config),
        LambdaClient::new(&aws_config),
    )?);

    run(service_fn(move |request| {
        handle_request(request, Arc::clone(&state))
    }))
    .await
}
