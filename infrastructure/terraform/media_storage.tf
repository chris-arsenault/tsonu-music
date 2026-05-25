data "aws_caller_identity" "current" {}

locals {
  media_storage_buckets = {
    masters = {
      name        = "${local.prefix}-masters"
      description = "Lossless source masters"
    }
    media = {
      name        = "${local.prefix}-media"
      description = "Generated streaming media and artwork"
    }
  }

  media_cors_origins = [
    "https://music.tsonu.com",
    "https://tsonu.com",
    "https://www.tsonu.com",
    "https://music.ahara.io",
    "https://media.tsonu.com",
    "http://localhost:3000",
  ]
}

data "aws_iam_policy_document" "media_storage_kms" {
  for_each = local.media_storage_buckets

  statement {
    sid    = "EnableRootAccountAccess"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
    actions   = ["kms:*"]
    resources = ["*"]
  }

  dynamic "statement" {
    for_each = each.key == "media" ? [1] : []

    content {
      sid    = "AllowCloudFrontDecrypt"
      effect = "Allow"

      principals {
        type        = "Service"
        identifiers = ["cloudfront.amazonaws.com"]
      }

      actions = [
        "kms:Decrypt",
        "kms:GenerateDataKey*",
      ]
      resources = ["*"]

      condition {
        test     = "StringEquals"
        variable = "AWS:SourceArn"
        values   = [aws_cloudfront_distribution.media.arn]
      }
    }
  }
}

resource "aws_kms_key" "media_storage" {
  for_each = local.media_storage_buckets

  description             = "KMS key for ${each.value.name} S3 bucket (${each.value.description})"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.media_storage_kms[each.key].json

  tags = {
    StorageRole = each.key
  }
}

resource "aws_kms_alias" "media_storage" {
  for_each = local.media_storage_buckets

  name          = "alias/${local.prefix}-${each.key}"
  target_key_id = aws_kms_key.media_storage[each.key].key_id
}

resource "aws_s3_bucket" "media_storage" {
  for_each = local.media_storage_buckets

  bucket = each.value.name

  tags = {
    StorageRole = each.key
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "media_storage" {
  for_each = aws_s3_bucket.media_storage

  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "media_storage" {
  for_each = aws_s3_bucket.media_storage

  bucket = each.value.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "media_storage" {
  for_each = aws_s3_bucket.media_storage

  bucket = each.value.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media_storage" {
  for_each = aws_s3_bucket.media_storage

  bucket = each.value.id

  rule {
    bucket_key_enabled = true

    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.media_storage[each.key].arn
      sse_algorithm     = "aws:kms"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "media_storage" {
  for_each = aws_s3_bucket.media_storage

  bucket = each.value.id

  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"

    filter {
      prefix = ""
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_iam_policy_document" "media_storage_bucket" {
  for_each = aws_s3_bucket.media_storage

  dynamic "statement" {
    for_each = each.key == "media" ? [1] : []

    content {
      sid    = "AllowCloudFrontRead"
      effect = "Allow"

      principals {
        type        = "Service"
        identifiers = ["cloudfront.amazonaws.com"]
      }

      actions = ["s3:GetObject"]
      resources = [
        # `albums/*` is the pre-rename public prefix; kept for any
        # album-era publication that hasn't been re-published yet.
        # `recordings/*` is where the publish step copies encoded HLS
        # and FLAC outputs out of `draft/encodes/*`.
        "${each.value.arn}/albums/*",
        "${each.value.arn}/artwork/*",
        "${each.value.arn}/recordings/*",
        "${each.value.arn}/waveforms/*",
      ]

      condition {
        test     = "StringEquals"
        variable = "AWS:SourceArn"
        values   = [aws_cloudfront_distribution.media.arn]
      }
    }
  }

  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      each.value.arn,
      "${each.value.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "media_storage" {
  for_each = aws_s3_bucket.media_storage

  bucket = each.value.id
  policy = data.aws_iam_policy_document.media_storage_bucket[each.key].json
}

resource "aws_s3_bucket_cors_configuration" "masters" {
  bucket = aws_s3_bucket.media_storage["masters"].id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["PUT", "POST", "GET", "HEAD"]
    allowed_origins = local.media_cors_origins
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

resource "aws_s3_bucket_cors_configuration" "media" {
  bucket = aws_s3_bucket.media_storage["media"].id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "HEAD", "PUT"]
    allowed_origins = local.media_cors_origins
    expose_headers = [
      "Accept-Ranges",
      "Content-Length",
      "Content-Range",
      "ETag",
    ]
    max_age_seconds = 3000
  }
}
