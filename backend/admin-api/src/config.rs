use std::env;
use std::error::Error as StdError;
use std::fmt;

pub(crate) const ARTIST_NAME: &str = "Tsonu";
pub(crate) const ARTIST_SLUG: &str = "tsonu";
pub(crate) const DRAFT_SONG_PREFIX: &str = "draft/songs/";
pub(crate) const DRAFT_RELEASE_PREFIX: &str = "draft/releases/";
pub(crate) const PUBLIC_RECORDING_PREFIX: &str = "recordings/";
pub(crate) const DEFAULT_UPLOAD_URL_EXPIRY_SECONDS: u64 = 900;
pub(crate) const MAX_UPLOAD_URL_EXPIRY_SECONDS: u64 = 3600;

pub(crate) const DEFAULT_ALLOWED_ORIGINS: &[&str] = &[
    "https://music.tsonu.com",
    "https://tsonu.com",
    "https://www.tsonu.com",
    "https://music.ahara.io",
    "http://localhost:3000",
    "http://localhost:5173",
];

#[derive(Debug)]
pub struct ConfigError {
    pub(crate) name: &'static str,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "missing required environment variable {}", self.name)
    }
}

impl StdError for ConfigError {}

pub(crate) fn split_env_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect()
}

pub(crate) fn required_env(name: &'static str) -> Result<String, ConfigError> {
    env::var(name).map_err(|_| ConfigError { name })
}
