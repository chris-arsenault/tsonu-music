use crate::{
    db, normalize_updated_at, parse_rum_summary_query, validate_draft_release_document,
    validate_draft_song_document, validate_slug, validate_stable_id, ApiError, AppState,
    ArtworkUploadUrlRequest, EncodeJobRequest, PlayEventRequest, PublishRequest, UploadUrlRequest,
};
use lambda_http::http::{Method, StatusCode};
use lambda_http::{Body, Error, Request, Response};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use tracing::{error, info};

pub async fn handle_request(
    request: Request,
    state: Arc<AppState>,
) -> Result<Response<Body>, Error> {
    let cors_origin = state.cors_origin(request.headers());
    let response = match dispatch(&request, &state).await {
        Ok(response) => response,
        Err(err) => {
            error!(
                status = err.status.as_u16(),
                code = err.code,
                message = %err.message,
                "Admin API request failed"
            );
            err.to_response()?
        }
    };

    let mut response = response;
    state.decorate_response(&mut response, cors_origin);
    Ok(response)
}

async fn dispatch(request: &Request, state: &AppState) -> Result<Response<Body>, ApiError> {
    let method = request.method();
    let path = request.uri().path();
    info!(method = method.as_str(), path, "Admin API request");

    match (method, parse_path(path)) {
        (&Method::GET, ApiPath::Health) => json_response(
            StatusCode::OK,
            json!({ "ok": true, "mediaBaseUrl": state.media_base_url() }),
        ),
        (&Method::HEAD, ApiPath::Health) => empty_response(StatusCode::NO_CONTENT),
        (&Method::GET, ApiPath::PublicCatalog | ApiPath::AdminCatalog) => {
            json_response(StatusCode::OK, db::get_public_catalog(state.db()).await?)
        }
        (&Method::GET, ApiPath::PublicRelease { slug }) => {
            validate_slug(&slug, "releaseSlug")?;
            let release = db::get_public_release_by_slug(state.db(), &slug).await?;
            raw_json_response(StatusCode::OK, release.text, release.e_tag.as_deref(), None)
        }
        (&Method::GET, ApiPath::PublicSong { slug }) => {
            validate_slug(&slug, "songSlug")?;
            json_response(
                StatusCode::OK,
                db::get_public_song_by_slug(state.db(), &slug).await?,
            )
        }
        (&Method::POST, ApiPath::PublicAnalyticsPlay) => {
            state.validate_public_write_origin(request.headers())?;
            let play_event: PlayEventRequest = parse_json_body(request.body())?;
            json_response(
                StatusCode::ACCEPTED,
                state
                    .record_backend_play_event(play_event, request.headers())
                    .await?,
            )
        }
        (&Method::GET, ApiPath::AdminSongs) => {
            json_response(StatusCode::OK, db::list_draft_songs(state.db()).await?)
        }
        (&Method::POST, ApiPath::AdminSongs) => create_admin_song_response(request, state).await,
        (_, ApiPath::AdminSong { song_id }) => {
            admin_song_response(method, song_id, request, state).await
        }
        (&Method::GET, ApiPath::AdminReleases) => {
            json_response(StatusCode::OK, db::list_draft_releases(state.db()).await?)
        }
        (&Method::POST, ApiPath::AdminReleases) => {
            create_admin_release_response(request, state).await
        }
        (_, ApiPath::AdminRelease { release_id }) => {
            admin_release_response(method, release_id, request, state).await
        }
        (&Method::GET, ApiPath::AdminJobs) => {
            json_response(StatusCode::OK, db::list_encode_jobs(state.db()).await?)
        }
        (&Method::GET, ApiPath::AdminJob { job_id }) => {
            validate_stable_id("job", &job_id, "jobId")?;
            json_response(
                StatusCode::OK,
                db::get_encode_job(state.db(), &job_id).await?,
            )
        }
        (&Method::GET, ApiPath::AdminRumSummary) => {
            let query = parse_rum_summary_query(request.uri().query())?;
            json_response(StatusCode::OK, state.get_rum_summary(query).await?)
        }
        (&Method::POST, path @ (ApiPath::AdminUploadUrl | ApiPath::AdminArtworkUploadUrl)) => {
            upload_url_response(path, request, state).await
        }
        (&Method::POST, ApiPath::AdminEncodeJobs) => {
            let request: EncodeJobRequest = parse_json_body(request.body())?;
            json_response(
                StatusCode::ACCEPTED,
                state.create_encode_job(request).await?,
            )
        }
        (&Method::POST, ApiPath::AdminPublish { release_id }) => {
            validate_stable_id("release", &release_id, "releaseId")?;
            let request = parse_optional_json_body::<PublishRequest>(request.body())?;
            json_response(
                StatusCode::OK,
                state.publish_release(release_id, request).await?,
            )
        }
        (_, ApiPath::NotFound) => Err(ApiError::not_found("route not found")),
        _ => Err(ApiError::method_not_allowed()),
    }
}

async fn create_admin_song_response(
    request: &Request,
    state: &AppState,
) -> Result<Response<Body>, ApiError> {
    let mut document: Value = parse_json_body(request.body())?;
    let song_id = document
        .get("songId")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("invalid_song", "songId is required"))?
        .to_string();
    validate_stable_id("song", &song_id, "songId")?;
    validate_draft_song_document(&song_id, &document)?;
    normalize_updated_at(&mut document);
    json_response(
        StatusCode::CREATED,
        db::create_draft_song(state.db(), &song_id, &document).await?,
    )
}

async fn admin_song_response(
    method: &Method,
    song_id: String,
    request: &Request,
    state: &AppState,
) -> Result<Response<Body>, ApiError> {
    validate_stable_id("song", &song_id, "songId")?;

    match *method {
        Method::GET => {
            let song = db::get_draft_song(state.db(), &song_id).await?;
            raw_json_response(StatusCode::OK, song.text, None, None)
        }
        Method::PUT => {
            let mut document: Value = parse_json_body(request.body())?;
            validate_draft_song_document(&song_id, &document)?;
            normalize_updated_at(&mut document);
            json_response(
                StatusCode::OK,
                db::update_draft_song(state.db(), &song_id, &document).await?,
            )
        }
        Method::DELETE => {
            db::delete_draft_song(state.db(), &song_id).await?;
            empty_response(StatusCode::NO_CONTENT)
        }
        _ => Err(ApiError::method_not_allowed()),
    }
}

async fn create_admin_release_response(
    request: &Request,
    state: &AppState,
) -> Result<Response<Body>, ApiError> {
    let mut document: Value = parse_json_body(request.body())?;
    let release_id = document
        .get("releaseId")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("invalid_release", "releaseId is required"))?
        .to_string();
    validate_stable_id("release", &release_id, "releaseId")?;
    validate_draft_release_document(&release_id, &document)?;
    normalize_updated_at(&mut document);
    json_response(
        StatusCode::CREATED,
        db::create_draft_release(state.db(), &release_id, &document).await?,
    )
}

async fn admin_release_response(
    method: &Method,
    release_id: String,
    request: &Request,
    state: &AppState,
) -> Result<Response<Body>, ApiError> {
    validate_stable_id("release", &release_id, "releaseId")?;

    match *method {
        Method::GET => {
            let release = db::get_draft_release(state.db(), &release_id).await?;
            raw_json_response(StatusCode::OK, release.text, None, None)
        }
        Method::PUT => {
            let mut document: Value = parse_json_body(request.body())?;
            validate_draft_release_document(&release_id, &document)?;
            normalize_updated_at(&mut document);
            json_response(
                StatusCode::OK,
                db::update_draft_release(state.db(), &release_id, &document).await?,
            )
        }
        Method::DELETE => {
            db::delete_draft_release(state.db(), &release_id).await?;
            empty_response(StatusCode::NO_CONTENT)
        }
        _ => Err(ApiError::method_not_allowed()),
    }
}

async fn upload_url_response(
    path: ApiPath,
    request: &Request,
    state: &AppState,
) -> Result<Response<Body>, ApiError> {
    match path {
        ApiPath::AdminUploadUrl => {
            let request: UploadUrlRequest = parse_json_body(request.body())?;
            json_response(StatusCode::OK, state.create_upload_url(request).await?)
        }
        ApiPath::AdminArtworkUploadUrl => {
            let request: ArtworkUploadUrlRequest = parse_json_body(request.body())?;
            json_response(
                StatusCode::OK,
                state.create_artwork_upload_url(request).await?,
            )
        }
        _ => unreachable!("upload_url_response only handles upload routes"),
    }
}

pub(crate) fn parse_path(path: &str) -> ApiPath {
    let parts = path
        .trim_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();

    match parts.as_slice() {
        ["health"] => ApiPath::Health,
        ["catalog"] => ApiPath::PublicCatalog,
        ["catalog", "releases", slug] => ApiPath::PublicRelease {
            slug: (*slug).to_string(),
        },
        ["catalog", "albums", slug] => ApiPath::PublicRelease {
            slug: (*slug).to_string(),
        },
        ["catalog", "songs", slug] => ApiPath::PublicSong {
            slug: (*slug).to_string(),
        },
        ["analytics", "play"] => ApiPath::PublicAnalyticsPlay,
        ["admin", "catalog"] => ApiPath::AdminCatalog,
        ["admin", "songs"] => ApiPath::AdminSongs,
        ["admin", "songs", song_id] => ApiPath::AdminSong {
            song_id: (*song_id).to_string(),
        },
        ["admin", "releases"] => ApiPath::AdminReleases,
        ["admin", "releases", release_id] => ApiPath::AdminRelease {
            release_id: (*release_id).to_string(),
        },
        ["admin", "jobs"] => ApiPath::AdminJobs,
        ["admin", "jobs", job_id] => ApiPath::AdminJob {
            job_id: (*job_id).to_string(),
        },
        ["admin", "rum", "summary"] => ApiPath::AdminRumSummary,
        ["admin", "upload-url"] => ApiPath::AdminUploadUrl,
        ["admin", "artwork-upload-url"] => ApiPath::AdminArtworkUploadUrl,
        ["admin", "encode-jobs"] => ApiPath::AdminEncodeJobs,
        ["admin", "publish", release_id] => ApiPath::AdminPublish {
            release_id: (*release_id).to_string(),
        },
        _ => ApiPath::NotFound,
    }
}

fn json_response(status: StatusCode, body: impl Serialize) -> Result<Response<Body>, ApiError> {
    let body = serde_json::to_string(&body).map_err(|err| {
        error!(error = %err, "Failed to serialize API response");
        ApiError::internal(
            "response_serialize_failed",
            "failed to serialize API response",
        )
    })?;

    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::Text(body))
        .map_err(|err| {
            error!(error = %err, "Failed to build API response");
            ApiError::internal("response_build_failed", "failed to build API response")
        })
}

fn raw_json_response(
    status: StatusCode,
    body: String,
    e_tag: Option<&str>,
    version_id: Option<&str>,
) -> Result<Response<Body>, ApiError> {
    let mut builder = Response::builder()
        .status(status)
        .header("content-type", "application/json");

    if let Some(e_tag) = e_tag {
        builder = builder.header("etag", e_tag);
    }

    if let Some(version_id) = version_id {
        builder = builder.header("x-s3-version-id", version_id);
    }

    builder.body(Body::Text(body)).map_err(|err| {
        error!(error = %err, "Failed to build raw JSON API response");
        ApiError::internal("response_build_failed", "failed to build API response")
    })
}

fn empty_response(status: StatusCode) -> Result<Response<Body>, ApiError> {
    Response::builder()
        .status(status)
        .body(Body::Empty)
        .map_err(|err| {
            error!(error = %err, "Failed to build empty API response");
            ApiError::internal("response_build_failed", "failed to build API response")
        })
}

fn parse_json_body<T: for<'de> Deserialize<'de>>(body: &Body) -> Result<T, ApiError> {
    if body.as_ref().is_empty() {
        return Err(ApiError::bad_request(
            "empty_body",
            "request body must be JSON",
        ));
    }

    serde_json::from_slice(body.as_ref()).map_err(|err| {
        ApiError::bad_request(
            "invalid_json",
            format!("request body is invalid JSON: {err}"),
        )
    })
}

fn parse_optional_json_body<T>(body: &Body) -> Result<T, ApiError>
where
    T: for<'de> Deserialize<'de> + Default,
{
    if body.as_ref().is_empty() {
        return Ok(T::default());
    }

    parse_json_body(body)
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ApiPath {
    Health,
    PublicCatalog,
    PublicRelease { slug: String },
    PublicSong { slug: String },
    PublicAnalyticsPlay,
    AdminCatalog,
    AdminSongs,
    AdminSong { song_id: String },
    AdminReleases,
    AdminRelease { release_id: String },
    AdminJobs,
    AdminJob { job_id: String },
    AdminRumSummary,
    AdminUploadUrl,
    AdminArtworkUploadUrl,
    AdminEncodeJobs,
    AdminPublish { release_id: String },
    NotFound,
}
