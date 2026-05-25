locals {
  admin_api_hostname = "api.music.tsonu.com"
  rum_log_group_arn  = "arn:aws:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:${aws_rum_app_monitor.player.cw_log_group}"

  admin_api_allowed_origins = [
    for origin in local.media_cors_origins : origin
    if origin != "https://media.tsonu.com"
  ]
}

data "aws_iam_policy_document" "admin_api" {
  statement {
    sid    = "ListManagedManifestPrefixes"
    effect = "Allow"

    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.media_storage["media"].arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values = [
        # Legacy album-era objects, kept readable for any straggling
        # publications. Current code reads/writes under recordings/*.
        "albums/*",
        "draft/encodes/*",
        "recordings/*",
      ]
    }
  }

  statement {
    sid    = "ReadManifestObjects"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]

    resources = [
      "${aws_s3_bucket.media_storage["media"].arn}/albums/*",
      "${aws_s3_bucket.media_storage["media"].arn}/artwork/*",
      "${aws_s3_bucket.media_storage["media"].arn}/draft/encodes/*",
      "${aws_s3_bucket.media_storage["media"].arn}/recordings/*",
    ]
  }

  statement {
    sid    = "WriteManagedMediaObjects"
    effect = "Allow"

    actions = [
      "s3:PutObject",
    ]

    resources = [
      # `recordings/*` is where the publish step copies encoded HLS / FLAC
      # outputs out of `draft/encodes/*`. `artwork/*` is the destination
      # for presigned cover-art uploads. `albums/*` is the pre-rename
      # public prefix; left in for now so the role can re-publish any
      # album-era release that hasn't been migrated.
      "${aws_s3_bucket.media_storage["media"].arn}/albums/*",
      "${aws_s3_bucket.media_storage["media"].arn}/artwork/*",
      "${aws_s3_bucket.media_storage["media"].arn}/recordings/*",
    ]
  }

  statement {
    sid    = "InvalidatePublishedMediaManifests"
    effect = "Allow"

    actions = [
      "cloudfront:CreateInvalidation",
    ]

    resources = [
      module.frontend.distribution_arn,
    ]
  }

  statement {
    sid    = "InvokeEncoderLambda"
    effect = "Allow"

    actions = [
      "lambda:InvokeFunction",
    ]

    resources = [
      aws_lambda_function.encoder.arn,
    ]
  }

  statement {
    sid    = "QueryPlayerRumLogs"
    effect = "Allow"

    actions = [
      "logs:GetQueryResults",
      "logs:StartQuery",
    ]

    resources = [
      local.rum_log_group_arn,
      "${local.rum_log_group_arn}:*",
    ]
  }

  statement {
    sid    = "PresignSourceMasterUploads"
    effect = "Allow"

    actions = [
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
      "s3:PutObject",
    ]

    resources = [
      "${aws_s3_bucket.media_storage["masters"].arn}/masters/*",
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

module "admin_api" {
  source = "git::https://github.com/chris-arsenault/ahara-tf-patterns.git//modules/alb-api"

  prefix    = "${local.prefix}-admin"
  hostname  = local.admin_api_hostname
  zone_name = "tsonu.com"

  vpc     = module.ctx.vpc
  alb     = module.ctx.alb
  cognito = module.ctx.cognito

  environment = merge(local.db_env, {
    ALLOWED_ORIGINS          = join(",", local.admin_api_allowed_origins)
    ENCODER_FUNCTION_NAME    = aws_lambda_function.encoder.function_name
    FRONTEND_DISTRIBUTION_ID = module.frontend.distribution_id
    MASTERS_BUCKET           = aws_s3_bucket.media_storage["masters"].id
    MEDIA_BASE_URL           = "https://${local.media_hostname}"
    MEDIA_BUCKET             = aws_s3_bucket.media_storage["media"].id
    RUM_LOG_GROUP_NAME       = aws_rum_app_monitor.player.cw_log_group
    RUST_LOG                 = "info"
  })

  iam_policy = [data.aws_iam_policy_document.admin_api.json]

  lambdas = {
    api = {
      binary = "${path.module}/../../backend/target/lambda/admin-api/bootstrap"
      routes = [
        {
          priority      = 240
          paths         = ["/health"]
          methods       = ["GET", "HEAD"]
          authenticated = false
        },
        {
          priority      = 241
          paths         = ["/catalog", "/catalog/*"]
          methods       = ["GET", "HEAD"]
          authenticated = false
        },
        {
          priority      = 242
          paths         = ["/admin", "/admin/*"]
          authenticated = true
        },
      ]
    }
  }
}
