terraform {
  required_version = ">= 1.12"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
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
      Project   = "tsonu-music"
      ManagedBy = "Terraform"
    }
  }
}

# Static marketing site served at music.tsonu.com (primary),
# with tsonu.com, www.tsonu.com, and music.ahara.io as additional aliases.
# All four hostnames resolve to the same CloudFront distribution.
module "frontend" {
  source = "git::https://github.com/chris-arsenault/ahara-tf-patterns.git//modules/website"

  prefix         = "tsonu-music"
  hostname       = "music.tsonu.com"
  aliases        = ["tsonu.com", "www.tsonu.com", "music.ahara.io"]
  site_directory = "${path.module}/../../frontend/build"
}
