output "masters_bucket_name" {
  description = "S3 bucket name for uploaded lossless source masters."
  value       = aws_s3_bucket.media_storage["masters"].id
}

output "masters_bucket_arn" {
  description = "S3 bucket ARN for uploaded lossless source masters."
  value       = aws_s3_bucket.media_storage["masters"].arn
}

output "masters_kms_key_arn" {
  description = "KMS key ARN used for the source masters bucket."
  value       = aws_kms_key.media_storage["masters"].arn
}

output "media_bucket_name" {
  description = "S3 bucket name for generated HLS, artwork, and waveform data."
  value       = aws_s3_bucket.media_storage["media"].id
}

output "media_bucket_arn" {
  description = "S3 bucket ARN for generated HLS, artwork, and waveform data."
  value       = aws_s3_bucket.media_storage["media"].arn
}

output "media_kms_key_arn" {
  description = "KMS key ARN used for the generated media bucket."
  value       = aws_kms_key.media_storage["media"].arn
}

output "media_cdn_hostname" {
  description = "Custom hostname for the generated media CloudFront distribution."
  value       = local.media_hostname
}

output "media_cdn_distribution_id" {
  description = "CloudFront distribution ID for generated media delivery."
  value       = aws_cloudfront_distribution.media.id
}

output "media_cdn_distribution_arn" {
  description = "CloudFront distribution ARN for generated media delivery."
  value       = aws_cloudfront_distribution.media.arn
}

output "media_cdn_logs_bucket_name" {
  description = "S3 bucket name for media CloudFront access logs."
  value       = aws_s3_bucket.media_logs.id
}

output "admin_api_hostname" {
  description = "Shared ALB hostname for authenticated catalog administration."
  value       = module.admin_api.hostname
}

output "admin_api_lambda_name" {
  description = "Lambda function name serving the catalog administration API."
  value       = module.admin_api.function_names["api"]
}

output "cognito_client_id" {
  description = "Cognito app client ID used by the Tsonu admin frontend."
  value       = module.cognito_app.client_id
}

output "encoder_lambda_name" {
  description = "Lambda function name for one-track-at-a-time audio encoding."
  value       = aws_lambda_function.encoder.function_name
}

output "encoder_lambda_arn" {
  description = "Lambda function ARN for one-track-at-a-time audio encoding."
  value       = aws_lambda_function.encoder.arn
}

output "ffmpeg_layer_arn" {
  description = "Lambda layer ARN containing static ffmpeg and ffprobe binaries."
  value       = aws_lambda_layer_version.ffmpeg.arn
}

output "lambda_artifacts_bucket_name" {
  description = "Private S3 bucket used for Lambda artifacts too large for direct upload."
  value       = aws_s3_bucket.lambda_artifacts.id
}

output "rum_app_monitor_id" {
  description = "CloudWatch RUM app monitor application ID for the streaming player."
  value       = aws_rum_app_monitor.player.app_monitor_id
}

output "rum_app_monitor_name" {
  description = "CloudWatch RUM app monitor name for the streaming player."
  value       = aws_rum_app_monitor.player.name
}

output "rum_log_group_name" {
  description = "CloudWatch Logs group that receives CloudWatch RUM telemetry copies."
  value       = aws_rum_app_monitor.player.cw_log_group
}

output "rum_identity_pool_id" {
  description = "Shared Cognito identity pool ID used by the browser RUM client."
  value       = module.ctx.rum.identity_pool_id
}

output "rum_unauthenticated_role_arn" {
  description = "Shared IAM role ARN assumed by unauthenticated browser RUM clients."
  value       = module.ctx.rum.guest_role_arn
}
