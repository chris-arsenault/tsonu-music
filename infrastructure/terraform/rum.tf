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

resource "aws_rum_app_monitor" "player" {
  name           = "${local.prefix}-player"
  domain_list    = local.frontend_hostnames
  cw_log_enabled = true

  app_monitor_configuration {
    allow_cookies       = local.rum_allow_cookies
    enable_xray         = false
    guest_role_arn      = module.ctx.rum.guest_role_arn
    identity_pool_id    = module.ctx.rum.identity_pool_id
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
