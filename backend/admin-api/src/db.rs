use super::{
    draft_album_key, encode_job_key, ApiError, CatalogArtist, CatalogEntityType, DraftAlbum,
    EncodeJob, ObjectList, ObjectSummary, PublishedAlbum, PublishedCatalog, PublishedCatalogAlbum,
    PublishedStatus, Visibility, WriteResult, ARTIST_NAME, ARTIST_SLUG,
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::Value;
use sqlx::postgres::PgPoolOptions;
use sqlx::types::Json;
use sqlx::{PgPool, Row};
use std::env;
use tracing::error;

const DB_POOL_MAX_CONNECTIONS: u32 = 5;

#[derive(Debug)]
pub struct DbJsonObject {
    pub text: String,
    pub e_tag: Option<String>,
}

pub async fn connect_pool_from_env() -> Result<PgPool, Box<dyn std::error::Error + Send + Sync>> {
    let host = env::var("DB_HOST")?;
    let port = env::var("DB_PORT").unwrap_or_else(|_| "5432".to_string());
    let db_name = env::var("DB_NAME")?;
    let username = env::var("DB_USERNAME")?;
    let password = env::var("DB_PASSWORD")?;
    let url = format!("postgres://{username}:{password}@{host}:{port}/{db_name}?sslmode=require");

    Ok(PgPoolOptions::new()
        .max_connections(DB_POOL_MAX_CONNECTIONS)
        .connect(&url)
        .await?)
}

pub async fn get_draft_album(pool: &PgPool, album_id: &str) -> Result<DbJsonObject, ApiError> {
    let row = sqlx::query(
        "SELECT document::text AS document, revision
         FROM music_draft_albums
         WHERE album_id = $1",
    )
    .bind(album_id)
    .fetch_optional(pool)
    .await
    .map_err(map_db_read_error)?
    .ok_or_else(|| ApiError::not_found(format!("draft album not found: {album_id}")))?;

    Ok(DbJsonObject {
        text: row.get::<String, _>("document"),
        e_tag: Some(revision_etag(row.get("revision"))),
    })
}

pub async fn list_draft_albums(pool: &PgPool) -> Result<ObjectList, ApiError> {
    let rows = sqlx::query(
        "SELECT album_id, revision, octet_length(document::text) AS size_bytes
         FROM music_draft_albums
         ORDER BY updated_at DESC, album_id ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(map_db_read_error)?;

    Ok(ObjectList {
        bucket: "rds".to_string(),
        prefix: "draft/albums/".to_string(),
        objects: rows
            .into_iter()
            .map(|row| {
                let album_id: String = row.get("album_id");
                ObjectSummary {
                    key: draft_album_key(&album_id),
                    e_tag: Some(revision_etag(row.get("revision"))),
                    size_bytes: i64::from(row.get::<i32, _>("size_bytes")),
                }
            })
            .collect(),
    })
}

pub async fn put_draft_album(
    pool: &PgPool,
    album_id: &str,
    document: &Value,
    if_match: Option<&str>,
    if_none_match: Option<&str>,
) -> Result<WriteResult, ApiError> {
    let album = draft_album_fields(album_id, document)?;

    let revision = if if_none_match == Some("*") {
        let row = sqlx::query(
            "INSERT INTO music_draft_albums
                (album_id, release_id, slug, title, release_type, release_date, publish_state, document)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (album_id) DO NOTHING
             RETURNING revision",
        )
        .bind(album_id)
        .bind(&album.release_id)
        .bind(&album.slug)
        .bind(&album.title)
        .bind(&album.release_type)
        .bind(&album.release_date)
        .bind(&album.publish_state)
        .bind(Json(document.clone()))
        .fetch_optional(pool)
        .await
        .map_err(map_db_write_error)?;

        row.map(|row| row.get("revision")).ok_or_else(|| {
            ApiError::precondition_failed(
                "write_precondition_failed",
                "draft album already exists; fetch the current revision and retry",
            )
        })?
    } else if let Some(if_match) = if_match {
        let expected_revision = parse_revision_etag(if_match)?;
        let row = sqlx::query(
            "UPDATE music_draft_albums
             SET release_id = $2,
                 slug = $3,
                 title = $4,
                 release_type = $5,
                 release_date = $6,
                 publish_state = $7,
                 document = $8,
                 revision = revision + 1,
                 updated_at = now()
             WHERE album_id = $1 AND revision = $9
             RETURNING revision",
        )
        .bind(album_id)
        .bind(&album.release_id)
        .bind(&album.slug)
        .bind(&album.title)
        .bind(&album.release_type)
        .bind(&album.release_date)
        .bind(&album.publish_state)
        .bind(Json(document.clone()))
        .bind(expected_revision)
        .fetch_optional(pool)
        .await
        .map_err(map_db_write_error)?;

        row.map(|row| row.get("revision")).ok_or_else(|| {
            ApiError::precondition_failed(
                "write_precondition_failed",
                "draft album revision changed; fetch the latest revision and retry",
            )
        })?
    } else {
        return Err(ApiError::precondition_required(
            "send If-None-Match: * to create or If-Match: <revision> to update",
        ));
    };

    Ok(WriteResult {
        bucket: "rds".to_string(),
        key: draft_album_key(album_id),
        e_tag: Some(revision_etag(revision)),
        version_id: None,
    })
}

pub async fn put_encode_job(pool: &PgPool, job: &EncodeJob) -> Result<(), ApiError> {
    let document = serde_json::to_value(job).map_err(|err| {
        error!(job_id = job.job_id, error = %err, "Failed to serialize encode job for database");
        ApiError::internal("job_serialize_failed", "failed to serialize encode job")
    })?;

    upsert_encode_job_document(pool, job, document).await
}

pub async fn upsert_encode_job_document(
    pool: &PgPool,
    job: &EncodeJob,
    document: Value,
) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO music_encode_jobs
            (job_id, album_id, track_id, status, document, requested_at, started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (job_id) DO UPDATE SET
             album_id = EXCLUDED.album_id,
             track_id = EXCLUDED.track_id,
             status = EXCLUDED.status,
             document = EXCLUDED.document,
             requested_at = EXCLUDED.requested_at,
             started_at = EXCLUDED.started_at,
             finished_at = EXCLUDED.finished_at,
             updated_at = now()",
    )
    .bind(&job.job_id)
    .bind(&job.album_id)
    .bind(&job.track_id)
    .bind(job_status(job))
    .bind(Json(document))
    .bind(parse_optional_rfc3339(Some(job.requested_at.as_str())))
    .bind(parse_optional_rfc3339(job.started_at.as_deref()))
    .bind(parse_optional_rfc3339(job.finished_at.as_deref()))
    .execute(pool)
    .await
    .map_err(map_db_write_error)?;

    Ok(())
}

pub async fn get_encode_job(pool: &PgPool, job_id: &str) -> Result<EncodeJob, ApiError> {
    let row = sqlx::query(
        "SELECT document::text AS document
         FROM music_encode_jobs
         WHERE job_id = $1",
    )
    .bind(job_id)
    .fetch_optional(pool)
    .await
    .map_err(map_db_read_error)?
    .ok_or_else(|| ApiError::not_found(format!("encode job not found: {job_id}")))?;

    serde_json::from_str(&row.get::<String, _>("document")).map_err(|err| {
        error!(job_id, error = %err, "Stored encode job cannot be parsed");
        ApiError::internal("invalid_stored_job", "stored encode job cannot be parsed")
    })
}

pub async fn list_encode_jobs(pool: &PgPool) -> Result<ObjectList, ApiError> {
    let rows = sqlx::query(
        "SELECT job_id, octet_length(document::text) AS size_bytes
         FROM music_encode_jobs
         ORDER BY updated_at DESC, job_id ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(map_db_read_error)?;

    Ok(ObjectList {
        bucket: "rds".to_string(),
        prefix: "jobs/".to_string(),
        objects: rows
            .into_iter()
            .map(|row| {
                let job_id: String = row.get("job_id");
                ObjectSummary {
                    key: encode_job_key(&job_id),
                    e_tag: None,
                    size_bytes: i64::from(row.get::<i32, _>("size_bytes")),
                }
            })
            .collect(),
    })
}

pub async fn replace_publication(
    pool: &PgPool,
    album: &PublishedAlbum,
    total_duration_seconds: f64,
) -> Result<WriteResult, ApiError> {
    let album_document = serde_json::to_value(album).map_err(|err| {
        error!(album_id = album.album_id, error = %err, "Failed to serialize published album");
        ApiError::internal(
            "published_album_serialize_failed",
            "failed to serialize published album",
        )
    })?;
    let links = serde_json::to_value(&album.links).map_err(|err| {
        error!(album_id = album.album_id, error = %err, "Failed to serialize album links");
        ApiError::internal(
            "album_links_serialize_failed",
            "failed to serialize album links",
        )
    })?;

    let mut tx = pool.begin().await.map_err(map_db_write_error)?;
    sqlx::query(
        "INSERT INTO music_published_albums
            (album_id, release_id, slug, title, subtitle, artist_name, release_type, release_date,
             visibility, published_at, description, copyright, artwork, credits, links, tags,
             track_count, total_duration_seconds, document)
         VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         ON CONFLICT (album_id) DO UPDATE SET
             release_id = EXCLUDED.release_id,
             slug = EXCLUDED.slug,
             title = EXCLUDED.title,
             subtitle = EXCLUDED.subtitle,
             artist_name = EXCLUDED.artist_name,
             release_type = EXCLUDED.release_type,
             release_date = EXCLUDED.release_date,
             visibility = EXCLUDED.visibility,
             published_at = EXCLUDED.published_at,
             description = EXCLUDED.description,
             copyright = EXCLUDED.copyright,
             artwork = EXCLUDED.artwork,
             credits = EXCLUDED.credits,
             links = EXCLUDED.links,
             tags = EXCLUDED.tags,
             track_count = EXCLUDED.track_count,
             total_duration_seconds = EXCLUDED.total_duration_seconds,
             document = EXCLUDED.document,
             updated_at = now()",
    )
    .bind(&album.album_id)
    .bind(&album.release_id)
    .bind(&album.slug)
    .bind(&album.title)
    .bind(&album.subtitle)
    .bind(&album.artist_name)
    .bind(&album.release_type)
    .bind(&album.release_date)
    .bind(visibility_value(album.visibility))
    .bind(parse_required_rfc3339(&album.published_at)?)
    .bind(&album.description)
    .bind(&album.copyright)
    .bind(Json(album.artwork.clone()))
    .bind(album.credits.clone().map(Json))
    .bind(if links.is_null() {
        None
    } else {
        Some(Json(links))
    })
    .bind(&album.tags)
    .bind(album.tracks.len() as i32)
    .bind(total_duration_seconds)
    .bind(Json(album_document))
    .execute(&mut *tx)
    .await
    .map_err(map_db_write_error)?;

    sqlx::query("DELETE FROM music_published_tracks WHERE album_id = $1")
        .bind(&album.album_id)
        .execute(&mut *tx)
        .await
        .map_err(map_db_write_error)?;

    for track in &album.tracks {
        let document = serde_json::to_value(track).map_err(|err| {
            error!(album_id = album.album_id, track_id = track.track_id, error = %err, "Failed to serialize published track");
            ApiError::internal(
                "published_track_serialize_failed",
                "failed to serialize published track",
            )
        })?;
        let playback = serde_json::to_value(&track.playback).map_err(|err| {
            error!(album_id = album.album_id, track_id = track.track_id, error = %err, "Failed to serialize published track playback");
            ApiError::internal(
                "playback_serialize_failed",
                "failed to serialize published track playback",
            )
        })?;
        let published_job_id = published_job_id(track)?;

        sqlx::query(
            "INSERT INTO music_published_tracks
                (album_id, track_id, disc_number, track_number, slug, title, duration_seconds,
                 explicit, isrc, description, credits, playback, published_job_id, document)
             VALUES
                ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)",
        )
        .bind(&album.album_id)
        .bind(&track.track_id)
        .bind(track.disc_number as i32)
        .bind(track.track_number as i32)
        .bind(&track.slug)
        .bind(&track.title)
        .bind(track.duration_seconds)
        .bind(track.explicit)
        .bind(&track.isrc)
        .bind(&track.description)
        .bind(track.credits.clone().map(Json))
        .bind(Json(playback))
        .bind(published_job_id)
        .bind(Json(document))
        .execute(&mut *tx)
        .await
        .map_err(map_db_write_error)?;
    }

    tx.commit().await.map_err(map_db_write_error)?;

    Ok(WriteResult {
        bucket: "rds".to_string(),
        key: format!("published/albums/{}", album.album_id),
        e_tag: None,
        version_id: None,
    })
}

pub async fn get_public_catalog(pool: &PgPool) -> Result<PublishedCatalog, ApiError> {
    let rows = sqlx::query(
        "SELECT album_id, release_id, slug, title, subtitle, release_type, release_date,
                visibility, artwork, track_count, total_duration_seconds, tags, links
         FROM music_published_albums
         WHERE visibility = 'public'
         ORDER BY release_date DESC, title ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(map_db_read_error)?;

    let albums = rows
        .into_iter()
        .map(|row| {
            let links: Option<Json<Value>> = row.get("links");
            let parsed_links = links
                .map(|value| serde_json::from_value(value.0))
                .transpose()
                .map_err(|err| {
                    error!(error = %err, "Stored public album links cannot be parsed");
                    ApiError::internal(
                        "invalid_stored_links",
                        "stored public album links cannot be parsed",
                    )
                })?;

            Ok(PublishedCatalogAlbum {
                album_id: row.get("album_id"),
                release_id: row.get("release_id"),
                slug: row.get("slug"),
                title: row.get("title"),
                subtitle: row.get("subtitle"),
                release_type: row.get("release_type"),
                release_date: row.get("release_date"),
                status: PublishedStatus::Published,
                visibility: parse_visibility(row.get::<String, _>("visibility").as_str())?,
                manifest_path: format!("/catalog/albums/{}", row.get::<String, _>("slug")),
                artwork: row.get::<Json<Value>, _>("artwork").0,
                track_count: row.get::<i32, _>("track_count") as usize,
                total_duration_seconds: row.get("total_duration_seconds"),
                tags: row.get("tags"),
                links: parsed_links,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;

    Ok(PublishedCatalog {
        schema_version: 1,
        entity_type: CatalogEntityType::Catalog,
        generated_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
        artist: CatalogArtist {
            name: ARTIST_NAME.to_string(),
            slug: ARTIST_SLUG.to_string(),
        },
        albums,
    })
}

pub async fn get_public_album_by_slug(pool: &PgPool, slug: &str) -> Result<DbJsonObject, ApiError> {
    let row = sqlx::query(
        "SELECT document::text AS document, updated_at
         FROM music_published_albums
         WHERE slug = $1 AND visibility IN ('public', 'unlisted')",
    )
    .bind(slug)
    .fetch_optional(pool)
    .await
    .map_err(map_db_read_error)?
    .ok_or_else(|| ApiError::not_found(format!("published album not found: {slug}")))?;

    Ok(DbJsonObject {
        text: row.get("document"),
        e_tag: Some(timestamp_etag(row.get("updated_at"))),
    })
}

fn draft_album_fields(album_id: &str, document: &Value) -> Result<DraftAlbum, ApiError> {
    let album: DraftAlbum = serde_json::from_value(document.clone()).map_err(|err| {
        error!(album_id, error = %err, "Draft album payload cannot be parsed");
        ApiError::bad_request("invalid_album", "draft album payload cannot be parsed")
    })?;

    if album.album_id != album_id {
        return Err(ApiError::bad_request(
            "album_id_mismatch",
            "draft album albumId does not match request albumId",
        ));
    }

    Ok(album)
}

fn revision_etag(revision: i64) -> String {
    format!("\"rev-{revision}\"")
}

fn timestamp_etag(timestamp: DateTime<Utc>) -> String {
    format!("\"{}\"", timestamp.timestamp_millis())
}

fn parse_revision_etag(value: &str) -> Result<i64, ApiError> {
    let normalized = value
        .trim()
        .trim_start_matches("W/")
        .trim_matches('"')
        .strip_prefix("rev-")
        .ok_or_else(|| {
            ApiError::bad_request(
                "invalid_revision",
                "If-Match must be the revision ETag returned by the album endpoint",
            )
        })?
        .parse::<i64>()
        .map_err(|_| {
            ApiError::bad_request(
                "invalid_revision",
                "If-Match must be the revision ETag returned by the album endpoint",
            )
        })?;

    Ok(normalized)
}

fn parse_optional_rfc3339(value: Option<&str>) -> Option<DateTime<Utc>> {
    value
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc))
}

fn parse_required_rfc3339(value: &str) -> Result<DateTime<Utc>, ApiError> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|err| {
            ApiError::bad_request(
                "invalid_published_at",
                format!("publishedAt must be RFC3339: {err}"),
            )
        })
}

fn visibility_value(visibility: Visibility) -> &'static str {
    match visibility {
        Visibility::Public => "public",
        Visibility::Unlisted => "unlisted",
    }
}

fn parse_visibility(value: &str) -> Result<Visibility, ApiError> {
    match value {
        "public" => Ok(Visibility::Public),
        "unlisted" => Ok(Visibility::Unlisted),
        _ => Err(ApiError::internal(
            "invalid_stored_visibility",
            "stored album visibility is invalid",
        )),
    }
}

fn job_status(job: &EncodeJob) -> &'static str {
    match job.status {
        encode_contract::EncodeStatus::Queued => "queued",
        encode_contract::EncodeStatus::Running => "running",
        encode_contract::EncodeStatus::Succeeded => "succeeded",
        encode_contract::EncodeStatus::Failed => "failed",
        encode_contract::EncodeStatus::Canceled => "canceled",
    }
}

fn published_job_id(track: &super::PublishedTrack) -> Result<&str, ApiError> {
    let hls_path = track.playback.hls.path.as_str();
    hls_path
        .split("/tracks/")
        .nth(1)
        .and_then(|tail| tail.split('/').nth(1))
        .filter(|job_id| job_id.starts_with("job_"))
        .ok_or_else(|| {
            ApiError::internal(
                "invalid_published_playback_path",
                "published playback path does not include a job id",
            )
        })
}

fn map_db_read_error(err: sqlx::Error) -> ApiError {
    error!(error = %err, "Database read failed");
    ApiError::internal("db_read_failed", "failed to read catalog metadata")
}

fn map_db_write_error(err: sqlx::Error) -> ApiError {
    if let sqlx::Error::Database(db_err) = &err {
        if db_err.code().as_deref() == Some("23505") {
            return ApiError::new(
                lambda_http::http::StatusCode::CONFLICT,
                "db_unique_conflict",
                "catalog metadata conflicts with an existing record",
            );
        }
    }

    error!(error = %err, "Database write failed");
    ApiError::internal("db_write_failed", "failed to write catalog metadata")
}
