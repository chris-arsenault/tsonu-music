use std::env;
use std::error::Error as StdError;
use std::fmt;

pub(crate) const DEFAULT_FFMPEG_PATH: &str = "/opt/bin/ffmpeg";
pub(crate) const DEFAULT_FFPROBE_PATH: &str = "/opt/bin/ffprobe";
pub(crate) const WORK_ROOT: &str = "/tmp/tsonu-encoder";

pub(crate) fn required_env(name: &'static str) -> Result<String, ConfigError> {
    env::var(name).map_err(|_| ConfigError::missing_env(name))
}

#[derive(Debug)]
pub struct ConfigError {
    message: String,
}

impl ConfigError {
    pub(crate) fn missing_env(name: &'static str) -> Self {
        Self {
            message: format!("missing required environment variable {name}"),
        }
    }

    pub(crate) fn db_connect(error: String) -> Self {
        Self {
            message: format!("failed to connect to catalog database: {error}"),
        }
    }
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl StdError for ConfigError {}
