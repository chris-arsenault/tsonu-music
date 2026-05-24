# Per-project DB credentials are published by the shared Ahara db-migrate
# service after running migrations for `tsonu-music`.
data "aws_ssm_parameter" "db_username" {
  name = "/ahara/db/${local.prefix}/username"
}

data "aws_ssm_parameter" "db_password" {
  name = "/ahara/db/${local.prefix}/password"
}

data "aws_ssm_parameter" "db_database" {
  name = "/ahara/db/${local.prefix}/database"
}
