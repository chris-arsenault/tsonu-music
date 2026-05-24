terraform {
  required_version = ">= 1.12"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.8"
    }
  }
  backend "s3" {
    region       = "us-east-1"
    key          = "projects/tsonu-music.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = "us-east-1"
  default_tags {
    tags = {
      Project   = local.prefix
      ManagedBy = "Terraform"
    }
  }
}

locals {
  prefix = "tsonu-music"

  frontend_hostname = "music.tsonu.com"
  frontend_aliases  = ["tsonu.com", "www.tsonu.com", "music.ahara.io"]
  frontend_hostnames = concat(
    [local.frontend_hostname],
    local.frontend_aliases,
  )

  frontend_package             = jsondecode(file("${path.module}/../../frontend/package.json"))
  frontend_application_version = local.frontend_package.version
}

# Shared Ahara platform resources. Instantiate this once and pass the grouped
# outputs to any platform modules that need VPC, ALB, Cognito, or RDS context.
module "ctx" {
  source = "git::https://github.com/chris-arsenault/ahara-tf-patterns.git//modules/platform-context"
}

# Static marketing site served at music.tsonu.com (primary),
# with tsonu.com, www.tsonu.com, and music.ahara.io as additional aliases.
# All four hostnames resolve to the same CloudFront distribution.
module "frontend" {
  source = "git::https://github.com/chris-arsenault/ahara-tf-patterns.git//modules/website"

  prefix         = local.prefix
  hostname       = local.frontend_hostname
  aliases        = local.frontend_aliases
  site_directory = "${path.module}/../../frontend/build"
  runtime_config = {
    app = {
      adminApiBaseUrl = "https://${local.admin_api_hostname}"
      mediaBaseUrl    = "https://${local.media_hostname}"
      rum = {
        enabled              = true
        applicationId        = aws_rum_app_monitor.player.app_monitor_id
        applicationRegion    = data.aws_region.current.region
        applicationVersion   = local.frontend_application_version
        endpoint             = "https://dataplane.rum.${data.aws_region.current.region}.amazonaws.com"
        identityPoolId       = aws_cognito_identity_pool.rum.id
        guestRoleArn         = aws_iam_role.rum_unauthenticated.arn
        sessionSampleRate    = local.rum_session_sample_rate
        allowCookies         = local.rum_allow_cookies
        telemetries          = local.rum_telemetries
        playbackEventVersion = local.rum_playback_event_version
      }
    }
  }
  vpc = module.ctx.vpc
}
