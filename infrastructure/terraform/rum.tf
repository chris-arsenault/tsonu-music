data "aws_region" "current" {}

locals {
  rum_allow_cookies          = false
  rum_playback_event_version = 1
  rum_session_sample_rate    = 1
  rum_telemetries = [
    "errors",
    "performance",
    "http",
  ]
}

resource "aws_cognito_identity_pool" "rum" {
  identity_pool_name               = "${local.prefix}-rum"
  allow_unauthenticated_identities = true

  tags = {
    Service = "player-rum"
  }
}

data "aws_iam_policy_document" "rum_unauthenticated_assume_role" {
  statement {
    sid     = "AllowCognitoRumIdentityPool"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = ["cognito-identity.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "cognito-identity.amazonaws.com:aud"
      values   = [aws_cognito_identity_pool.rum.id]
    }

    condition {
      test     = "ForAnyValue:StringLike"
      variable = "cognito-identity.amazonaws.com:amr"
      values   = ["unauthenticated"]
    }
  }
}

resource "aws_iam_role" "rum_unauthenticated" {
  name               = "${local.prefix}-rum-unauthenticated"
  assume_role_policy = data.aws_iam_policy_document.rum_unauthenticated_assume_role.json

  tags = {
    Service = "player-rum"
  }
}

resource "aws_cognito_identity_pool_roles_attachment" "rum" {
  identity_pool_id = aws_cognito_identity_pool.rum.id

  roles = {
    unauthenticated = aws_iam_role.rum_unauthenticated.arn
  }
}

resource "aws_rum_app_monitor" "player" {
  name           = "${local.prefix}-player"
  domain_list    = local.frontend_hostnames
  cw_log_enabled = true

  app_monitor_configuration {
    allow_cookies       = local.rum_allow_cookies
    enable_xray         = false
    guest_role_arn      = aws_iam_role.rum_unauthenticated.arn
    identity_pool_id    = aws_cognito_identity_pool.rum.id
    session_sample_rate = local.rum_session_sample_rate
    telemetries         = local.rum_telemetries
  }

  custom_events {
    status = "ENABLED"
  }

  tags = {
    Service = "player-rum"
  }
}

data "aws_iam_policy_document" "rum_put_events" {
  statement {
    sid       = "AllowPutRumEvents"
    effect    = "Allow"
    actions   = ["rum:PutRumEvents"]
    resources = [aws_rum_app_monitor.player.arn]
  }
}

resource "aws_iam_role_policy" "rum_put_events" {
  name   = "${local.prefix}-rum-put-events"
  role   = aws_iam_role.rum_unauthenticated.id
  policy = data.aws_iam_policy_document.rum_put_events.json
}
