module "cognito_app" {
  source  = "git::https://github.com/chris-arsenault/ahara-tf-patterns.git//modules/cognito-app"
  name    = "${local.prefix}-app"
  cognito = module.ctx.cognito
}
