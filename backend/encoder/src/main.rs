use aws_sdk_s3::Client as S3Client;
use encoder::{handle_event, EncoderState};
use lambda_runtime::{run, service_fn, Error};
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
    let state = Arc::new(EncoderState::from_env(S3Client::new(&aws_config)).await?);

    run(service_fn(move |event| {
        handle_event(event, Arc::clone(&state))
    }))
    .await
}
