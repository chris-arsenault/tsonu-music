use super::{
    map_db_read_error, map_db_write_error, parse_required_rfc3339, parse_visibility,
    timestamp_etag, visibility_value, DbJsonObject,
};
use crate::{
    ApiError, CatalogArtist, CatalogEntityType, PublishedCatalog, PublishedCatalogRelease,
    PublishedCatalogSong, PublishedRelease, PublishedSong, PublishedSongPlacement, PublishedStatus,
    Visibility, WriteResult, ARTIST_NAME, ARTIST_SLUG,
};
use chrono::{SecondsFormat, Utc};
use serde_json::Value;
use sqlx::types::Json;
use sqlx::{PgPool, Row};
use tracing::error;

pub async fn replace_publication(
    pool: &PgPool,
    release: &PublishedRelease,
    songs: &[PublishedSong],
    total_duration_seconds: f64,
) -> Result<WriteResult, ApiError> {
    let release_document = serde_json::to_value(release).map_err(|err| {
        error!(release_id = release.release_id, error = %err, "Failed to serialize published release");
        ApiError::internal(
            "published_release_serialize_failed",
            "failed to serialize published release",
        )
    })?;
    let links = serde_json::to_value(&release.links).map_err(|err| {
        error!(release_id = release.release_id, error = %err, "Failed to serialize release links");
        ApiError::internal(
            "release_links_serialize_failed",
            "failed to serialize release links",
        )
    })?;

    let mut tx = pool.begin().await.map_err(map_db_write_error)?;

    for song in songs {
        let document = serde_json::to_value(song).map_err(|err| {
            error!(song_id = song.song_id, error = %err, "Failed to serialize published song");
            ApiError::internal(
                "published_song_serialize_failed",
                "failed to serialize published song",
            )
        })?;
        sqlx::query(
            "INSERT INTO music_published_songs (song_id, slug, title, artist_name, document)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (song_id) DO UPDATE SET
                 slug = EXCLUDED.slug,
                 title = EXCLUDED.title,
                 artist_name = EXCLUDED.artist_name,
                 document = EXCLUDED.document,
                 updated_at = now()",
        )
        .bind(&song.song_id)
        .bind(&song.slug)
        .bind(&song.title)
        .bind(&song.artist_name)
        .bind(Json(document))
        .execute(&mut *tx)
        .await
        .map_err(map_db_write_error)?;
    }

    sqlx::query(
        "INSERT INTO music_published_releases
            (release_id, slug, title, subtitle, artist_name, release_kind, release_status,
             release_date, visibility, published_at, description, copyright, artwork, credits,
             links, tags, track_count, total_duration_seconds, document)
         VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         ON CONFLICT (release_id) DO UPDATE SET
             slug = EXCLUDED.slug,
             title = EXCLUDED.title,
             subtitle = EXCLUDED.subtitle,
             artist_name = EXCLUDED.artist_name,
             release_kind = EXCLUDED.release_kind,
             release_status = EXCLUDED.release_status,
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
    .bind(&release.release_id)
    .bind(&release.slug)
    .bind(&release.title)
    .bind(&release.subtitle)
    .bind(&release.artist_name)
    .bind(&release.release_kind)
    .bind(&release.release_status)
    .bind(&release.release_date)
    .bind(visibility_value(release.visibility))
    .bind(parse_required_rfc3339(&release.published_at)?)
    .bind(&release.description)
    .bind(&release.copyright)
    .bind(Json(release.artwork.clone()))
    .bind(release.credits.clone().map(Json))
    .bind(if links.is_null() {
        None
    } else {
        Some(Json(links))
    })
    .bind(&release.tags)
    .bind(release.tracks.len() as i32)
    .bind(total_duration_seconds)
    .bind(Json(release_document))
    .execute(&mut *tx)
    .await
    .map_err(map_db_write_error)?;

    sqlx::query("DELETE FROM music_published_release_tracks WHERE release_id = $1")
        .bind(&release.release_id)
        .execute(&mut *tx)
        .await
        .map_err(map_db_write_error)?;

    for track in &release.tracks {
        let document = serde_json::to_value(track).map_err(|err| {
            error!(release_id = release.release_id, track_id = track.track_id, error = %err, "Failed to serialize published release track");
            ApiError::internal(
                "published_track_serialize_failed",
                "failed to serialize published release track",
            )
        })?;
        let playback = serde_json::to_value(&track.playback).map_err(|err| {
            error!(release_id = release.release_id, track_id = track.track_id, error = %err, "Failed to serialize published release track playback");
            ApiError::internal(
                "playback_serialize_failed",
                "failed to serialize published release track playback",
            )
        })?;
        sqlx::query(
            "INSERT INTO music_published_release_tracks
                (release_id, track_id, song_id, recording_id, disc_number, track_number, slug,
                 title, song_title, recording_title, duration_seconds, explicit, isrc, description,
                 credits, playback, document)
             VALUES
                ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)",
        )
        .bind(&release.release_id)
        .bind(&track.track_id)
        .bind(&track.song_id)
        .bind(&track.recording_id)
        .bind(track.disc_number as i32)
        .bind(track.track_number as i32)
        .bind(&track.slug)
        .bind(&track.title)
        .bind(&track.song_title)
        .bind(&track.recording_title)
        .bind(track.duration_seconds)
        .bind(track.explicit)
        .bind(&track.isrc)
        .bind(&track.description)
        .bind(track.credits.clone().map(Json))
        .bind(Json(playback))
        .bind(Json(document))
        .execute(&mut *tx)
        .await
        .map_err(map_db_write_error)?;
    }

    tx.commit().await.map_err(map_db_write_error)?;

    Ok(WriteResult {
        bucket: "rds".to_string(),
        key: format!("published/releases/{}", release.release_id),
        e_tag: None,
        version_id: None,
    })
}

pub async fn get_public_catalog(pool: &PgPool) -> Result<PublishedCatalog, ApiError> {
    let release_rows = sqlx::query(
        "SELECT release_id, slug, title, subtitle, release_kind, release_status, release_date,
                visibility, artwork, track_count, total_duration_seconds, tags, links
         FROM music_published_releases
         WHERE visibility = 'public'
         ORDER BY release_date DESC, title ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(map_db_read_error)?;

    let releases = release_rows
        .into_iter()
        .map(|row| {
            let links: Option<Json<Value>> = row.get("links");
            let parsed_links = links
                .map(|value| serde_json::from_value(value.0))
                .transpose()
                .map_err(|err| {
                    error!(error = %err, "Stored public release links cannot be parsed");
                    ApiError::internal(
                        "invalid_stored_links",
                        "stored public release links cannot be parsed",
                    )
                })?;

            Ok(PublishedCatalogRelease {
                release_id: row.get("release_id"),
                slug: row.get("slug"),
                title: row.get("title"),
                subtitle: row.get("subtitle"),
                release_kind: row.get("release_kind"),
                release_status: row.get("release_status"),
                release_date: row.get("release_date"),
                status: PublishedStatus::Published,
                visibility: parse_visibility(row.get::<String, _>("visibility").as_str())?,
                manifest_path: format!("/catalog/releases/{}", row.get::<String, _>("slug")),
                artwork: row.get::<Json<Value>, _>("artwork").0,
                track_count: row.get::<i32, _>("track_count") as usize,
                total_duration_seconds: row.get("total_duration_seconds"),
                tags: row.get("tags"),
                links: parsed_links,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;

    let song_rows = sqlx::query(
        "SELECT DISTINCT s.song_id, s.slug, s.title, s.artist_name, s.document
         FROM music_published_songs s
         JOIN music_published_release_tracks t ON t.song_id = s.song_id
         JOIN music_published_releases r ON r.release_id = t.release_id
         WHERE r.visibility = 'public'
         ORDER BY s.title ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(map_db_read_error)?;

    let songs = song_rows
        .into_iter()
        .map(|row| {
            let document: Value = row.get::<Json<Value>, _>("document").0;
            Ok(PublishedCatalogSong {
                song_id: row.get("song_id"),
                slug: row.get("slug"),
                title: row.get("title"),
                artist_name: row.get("artist_name"),
                tags: document
                    .get("tags")
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|err| {
                        error!(error = %err, "Stored public song tags cannot be parsed");
                        ApiError::internal(
                            "invalid_stored_tags",
                            "stored public song tags cannot be parsed",
                        )
                    })?,
                artwork: document.get("artwork").cloned(),
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
        releases,
        songs,
    })
}

pub async fn get_public_release_by_slug(
    pool: &PgPool,
    slug: &str,
) -> Result<DbJsonObject, ApiError> {
    let row = sqlx::query(
        "SELECT document::text AS document, updated_at
         FROM music_published_releases
         WHERE slug = $1 AND visibility IN ('public', 'unlisted')",
    )
    .bind(slug)
    .fetch_optional(pool)
    .await
    .map_err(map_db_read_error)?
    .ok_or_else(|| ApiError::not_found(format!("published release not found: {slug}")))?;

    Ok(DbJsonObject {
        text: row.get("document"),
        e_tag: Some(timestamp_etag(row.get("updated_at"))),
    })
}

pub async fn get_published_release_visibility(
    pool: &PgPool,
    release_id: &str,
) -> Result<Option<Visibility>, ApiError> {
    let row = sqlx::query(
        "SELECT visibility
         FROM music_published_releases
         WHERE release_id = $1",
    )
    .bind(release_id)
    .fetch_optional(pool)
    .await
    .map_err(map_db_read_error)?;

    row.map(|row| parse_visibility(row.get::<String, _>("visibility").as_str()))
        .transpose()
}

pub async fn get_public_song_by_slug(pool: &PgPool, slug: &str) -> Result<PublishedSong, ApiError> {
    let row = sqlx::query(
        "SELECT document::text AS document
         FROM music_published_songs
         WHERE slug = $1",
    )
    .bind(slug)
    .fetch_optional(pool)
    .await
    .map_err(map_db_read_error)?
    .ok_or_else(|| ApiError::not_found(format!("published song not found: {slug}")))?;

    let mut song: PublishedSong =
        serde_json::from_str(&row.get::<String, _>("document")).map_err(|err| {
            error!(slug, error = %err, "Stored published song cannot be parsed");
            ApiError::internal(
                "invalid_stored_song",
                "stored published song cannot be parsed",
            )
        })?;

    let placement_rows = sqlx::query(
        "SELECT r.release_id, r.slug AS release_slug, r.title AS release_title, r.release_kind,
                r.artwork AS release_artwork,
                t.track_id, t.slug AS track_slug, t.recording_id, t.track_number,
                COALESCE((t.document->>'aiAssistedComposition')::boolean, false) AS ai_assisted_composition
         FROM music_published_release_tracks t
         JOIN music_published_releases r ON r.release_id = t.release_id
         WHERE t.song_id = $1 AND r.visibility IN ('public', 'unlisted')
         ORDER BY r.release_date DESC, r.title ASC, t.disc_number ASC, t.track_number ASC",
    )
    .bind(&song.song_id)
    .fetch_all(pool)
    .await
    .map_err(map_db_read_error)?;

    song.placements = placement_rows
        .into_iter()
        .map(|row| PublishedSongPlacement {
            release_id: row.get("release_id"),
            release_slug: row.get("release_slug"),
            release_title: row.get("release_title"),
            release_kind: row.get("release_kind"),
            track_id: row.get("track_id"),
            track_slug: row.get("track_slug"),
            recording_id: row.get("recording_id"),
            track_number: row.get::<i32, _>("track_number") as u32,
            ai_assisted_composition: row.get("ai_assisted_composition"),
            release_artwork: row.get::<Json<Value>, _>("release_artwork").0,
        })
        .collect();

    if song.placements.is_empty() {
        return Err(ApiError::not_found(format!(
            "published song not found: {slug}"
        )));
    }

    Ok(song)
}
