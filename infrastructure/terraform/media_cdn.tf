locals {
  media_hostname  = "media.tsonu.com"
  media_zone      = "tsonu.com"
  media_origin_id = "${local.prefix}-media-s3"

  cloudfront_logs_canonical_user_id = "c4c1ede66af53448b93c283ce9448c4ba468c9432aa01d700d3878632f77d2d0"

  media_short_cache_patterns = [
    "*.json",
    "*.m3u8",
  ]

  media_immutable_cache_patterns = [
    "*.aac",
    "*.avif",
    "*.flac",
    "*.gif",
    "*.jpg",
    "*.jpeg",
    "*.m4s",
    "*.mp3",
    "*.png",
    "*.ts",
    "*.webp",
  ]

  media_cors_headers = [
    "Access-Control-Request-Headers",
    "Access-Control-Request-Method",
    "Origin",
  ]
}

data "aws_route53_zone" "media" {
  name         = "${local.media_zone}."
  private_zone = false
}

data "aws_canonical_user_id" "current" {}

resource "aws_cloudfront_origin_access_control" "media" {
  name                              = "${local.prefix}-media-oac"
  description                       = "OAC for ${local.media_hostname}"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_s3_bucket" "media_logs" {
  bucket = "${local.prefix}-media-cdn-logs"

  tags = {
    StorageRole = "media-cdn-logs"
  }
}

resource "aws_s3_bucket_public_access_block" "media_logs" {
  bucket                  = aws_s3_bucket.media_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "media_logs" {
  bucket = aws_s3_bucket.media_logs.id

  rule {
    object_ownership = "BucketOwnerPreferred"
  }
}

resource "aws_s3_bucket_acl" "media_logs" {
  bucket = aws_s3_bucket.media_logs.id

  access_control_policy {
    owner {
      id = data.aws_canonical_user_id.current.id
    }

    grant {
      permission = "FULL_CONTROL"

      grantee {
        id   = data.aws_canonical_user_id.current.id
        type = "CanonicalUser"
      }
    }

    grant {
      permission = "FULL_CONTROL"

      grantee {
        id   = local.cloudfront_logs_canonical_user_id
        type = "CanonicalUser"
      }
    }
  }

  depends_on = [aws_s3_bucket_ownership_controls.media_logs]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media_logs" {
  bucket = aws_s3_bucket.media_logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "media_logs" {
  bucket = aws_s3_bucket.media_logs.id

  rule {
    id     = "expire-cloudfront-logs"
    status = "Enabled"

    filter {
      prefix = ""
    }

    expiration {
      days = 400
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_iam_policy_document" "media_logs" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.media_logs.arn,
      "${aws_s3_bucket.media_logs.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "media_logs" {
  bucket = aws_s3_bucket.media_logs.id
  policy = data.aws_iam_policy_document.media_logs.json
}

resource "aws_acm_certificate" "media" {
  domain_name       = local.media_hostname
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "media_cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.media.domain_validation_options :
    dvo.domain_name => {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  }

  allow_overwrite = true
  zone_id         = data.aws_route53_zone.media.zone_id
  name            = each.value.name
  type            = each.value.type
  ttl             = 60
  records         = [each.value.value]
}

resource "aws_acm_certificate_validation" "media" {
  certificate_arn         = aws_acm_certificate.media.arn
  validation_record_fqdns = [for record in aws_route53_record.media_cert_validation : record.fqdn]
}

resource "aws_cloudfront_distribution" "media" {
  enabled         = true
  is_ipv6_enabled = true
  aliases         = [local.media_hostname]
  comment         = "${local.prefix} media CDN"
  http_version    = "http2and3"
  price_class     = "PriceClass_100"

  origin {
    domain_name              = aws_s3_bucket.media_storage["media"].bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.media.id
    origin_id                = local.media_origin_id
  }

  logging_config {
    bucket          = aws_s3_bucket.media_logs.bucket_domain_name
    include_cookies = false
    prefix          = "media/"
  }

  dynamic "ordered_cache_behavior" {
    for_each = local.media_short_cache_patterns

    content {
      path_pattern           = ordered_cache_behavior.value
      allowed_methods        = ["GET", "HEAD", "OPTIONS"]
      cached_methods         = ["GET", "HEAD", "OPTIONS"]
      target_origin_id       = local.media_origin_id
      viewer_protocol_policy = "redirect-to-https"
      compress               = true
      min_ttl                = 0
      default_ttl            = 60
      max_ttl                = 300

      forwarded_values {
        headers      = local.media_cors_headers
        query_string = false

        cookies {
          forward = "none"
        }
      }
    }
  }

  dynamic "ordered_cache_behavior" {
    for_each = local.media_immutable_cache_patterns

    content {
      path_pattern           = ordered_cache_behavior.value
      allowed_methods        = ["GET", "HEAD", "OPTIONS"]
      cached_methods         = ["GET", "HEAD", "OPTIONS"]
      target_origin_id       = local.media_origin_id
      viewer_protocol_policy = "redirect-to-https"
      compress               = true
      min_ttl                = 3600
      default_ttl            = 31536000
      max_ttl                = 31536000

      forwarded_values {
        headers      = local.media_cors_headers
        query_string = false

        cookies {
          forward = "none"
        }
      }
    }
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD", "OPTIONS"]
    target_origin_id       = local.media_origin_id
    viewer_protocol_policy = "redirect-to-https"
    compress               = true
    min_ttl                = 0
    default_ttl            = 300
    max_ttl                = 3600

    forwarded_values {
      headers      = local.media_cors_headers
      query_string = false

      cookies {
        forward = "none"
      }
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.media.certificate_arn
    minimum_protocol_version = "TLSv1.2_2021"
    ssl_support_method       = "sni-only"
  }

  depends_on = [aws_s3_bucket_acl.media_logs]
}

resource "aws_route53_record" "media" {
  zone_id = data.aws_route53_zone.media.zone_id
  name    = local.media_hostname
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.media.domain_name
    zone_id                = aws_cloudfront_distribution.media.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "media_ipv6" {
  zone_id = data.aws_route53_zone.media.zone_id
  name    = local.media_hostname
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.media.domain_name
    zone_id                = aws_cloudfront_distribution.media.hosted_zone_id
    evaluate_target_health = false
  }
}
