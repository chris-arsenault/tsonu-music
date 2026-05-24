locals {
  encoder_function_name       = "${local.prefix}-encoder"
  encoder_artifacts_bucket    = "${local.prefix}-lambda-artifacts"
  encoder_bootstrap_path      = "${path.module}/../../backend/target/lambda/encoder/bootstrap"
  encoder_bootstrap_zip_path  = "${path.module}/../../backend/target/lambda/encoder/bootstrap.zip"
  ffmpeg_layer_name           = "${local.prefix}-ffmpeg"
  ffmpeg_layer_zip_path       = "${path.module}/../../backend/target/lambda-layers/ffmpeg/ffmpeg-layer.zip"
  ffmpeg_layer_s3_key         = "lambda-layers/ffmpeg/ffmpeg-7.0.2-amd64-static.zip"
  ffmpeg_layer_source_hash    = fileexists(local.ffmpeg_layer_zip_path) ? filebase64sha256(local.ffmpeg_layer_zip_path) : null
  encoder_output_prefixes     = ["albums/*", "draft/encodes/*", "draft/jobs/*"]
  encoder_master_key_prefixes = ["masters/*"]
}

resource "aws_s3_bucket" "lambda_artifacts" {
  bucket = local.encoder_artifacts_bucket

  tags = {
    StorageRole = "lambda-artifacts"
  }
}

resource "aws_s3_bucket_public_access_block" "lambda_artifacts" {
  bucket                  = aws_s3_bucket.lambda_artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "lambda_artifacts" {
  bucket = aws_s3_bucket.lambda_artifacts.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "lambda_artifacts" {
  bucket = aws_s3_bucket.lambda_artifacts.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "lambda_artifacts" {
  bucket = aws_s3_bucket.lambda_artifacts.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "lambda_artifacts" {
  bucket = aws_s3_bucket.lambda_artifacts.id

  rule {
    id     = "expire-old-layer-artifacts"
    status = "Enabled"

    filter {
      prefix = ""
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_iam_policy_document" "lambda_artifacts_bucket" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.lambda_artifacts.arn,
      "${aws_s3_bucket.lambda_artifacts.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "lambda_artifacts" {
  bucket = aws_s3_bucket.lambda_artifacts.id
  policy = data.aws_iam_policy_document.lambda_artifacts_bucket.json
}

resource "aws_s3_object" "ffmpeg_layer" {
  bucket = aws_s3_bucket.lambda_artifacts.id
  key    = local.ffmpeg_layer_s3_key
  source = local.ffmpeg_layer_zip_path

  content_type           = "application/zip"
  server_side_encryption = "AES256"
  source_hash            = local.ffmpeg_layer_source_hash

  depends_on = [aws_s3_bucket_versioning.lambda_artifacts]
}

resource "aws_lambda_layer_version" "ffmpeg" {
  layer_name          = local.ffmpeg_layer_name
  description         = "Static ffmpeg and ffprobe 7.0.2 binaries for ${local.prefix} audio encoding"
  license_info        = "GPL-3.0-or-later"
  compatible_runtimes = ["provided.al2023"]
  compatible_architectures = [
    "x86_64",
  ]

  s3_bucket         = aws_s3_object.ffmpeg_layer.bucket
  s3_key            = aws_s3_object.ffmpeg_layer.key
  s3_object_version = aws_s3_object.ffmpeg_layer.version_id
  source_code_hash  = local.ffmpeg_layer_source_hash
}

data "archive_file" "encoder_lambda" {
  type        = "zip"
  source_file = local.encoder_bootstrap_path
  output_path = local.encoder_bootstrap_zip_path
}

data "aws_iam_policy_document" "encoder_assume" {
  statement {
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }

    actions = ["sts:AssumeRole"]
  }
}

resource "aws_iam_role" "encoder" {
  name               = "${local.encoder_function_name}-role"
  assume_role_policy = data.aws_iam_policy_document.encoder_assume.json
}

resource "aws_iam_role_policy_attachment" "encoder_basic" {
  role       = aws_iam_role.encoder.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "encoder" {
  statement {
    sid    = "ListSourceMasters"
    effect = "Allow"

    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.media_storage["masters"].arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = local.encoder_master_key_prefixes
    }
  }

  statement {
    sid    = "ReadSourceMasters"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]

    resources = [
      "${aws_s3_bucket.media_storage["masters"].arn}/masters/*",
    ]
  }

  statement {
    sid    = "ListEncoderMediaPrefixes"
    effect = "Allow"

    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.media_storage["media"].arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = local.encoder_output_prefixes
    }
  }

  statement {
    sid    = "WriteGeneratedMediaAndJobStatus"
    effect = "Allow"

    actions = [
      "s3:AbortMultipartUpload",
      "s3:GetObject",
      "s3:ListMultipartUploadParts",
      "s3:PutObject",
    ]

    resources = [
      "${aws_s3_bucket.media_storage["media"].arn}/albums/*",
      "${aws_s3_bucket.media_storage["media"].arn}/draft/encodes/*",
      "${aws_s3_bucket.media_storage["media"].arn}/draft/jobs/*",
    ]
  }

  statement {
    sid    = "UseMediaStorageKeys"
    effect = "Allow"

    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:GenerateDataKey",
      "kms:GenerateDataKeyWithoutPlaintext",
    ]

    resources = [
      aws_kms_key.media_storage["masters"].arn,
      aws_kms_key.media_storage["media"].arn,
    ]
  }
}

resource "aws_iam_role_policy" "encoder" {
  name   = local.encoder_function_name
  role   = aws_iam_role.encoder.id
  policy = data.aws_iam_policy_document.encoder.json
}

resource "aws_cloudwatch_log_group" "encoder" {
  name              = "/aws/lambda/${local.encoder_function_name}"
  retention_in_days = 14
}

resource "aws_lambda_function" "encoder" {
  function_name = local.encoder_function_name
  role          = aws_iam_role.encoder.arn
  handler       = "bootstrap"
  runtime       = "provided.al2023"
  architectures = ["x86_64"]
  timeout       = 180
  memory_size   = 2048

  filename         = data.archive_file.encoder_lambda.output_path
  source_code_hash = data.archive_file.encoder_lambda.output_base64sha256

  layers = [aws_lambda_layer_version.ffmpeg.arn]

  environment {
    variables = {
      FFMPEG_PATH    = "/opt/bin/ffmpeg"
      FFPROBE_PATH   = "/opt/bin/ffprobe"
      MASTERS_BUCKET = aws_s3_bucket.media_storage["masters"].id
      MEDIA_BUCKET   = aws_s3_bucket.media_storage["media"].id
      RUST_LOG       = "info"
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.encoder,
    aws_iam_role_policy_attachment.encoder_basic,
    aws_iam_role_policy.encoder,
  ]
}
