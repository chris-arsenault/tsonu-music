use crate::{
    collect_files, content_type_for_path, db, file_integrity, join_s3_key, relative_s3_path,
    required_env, ConfigError, EncoderError, UploadedFile, DEFAULT_FFMPEG_PATH,
    DEFAULT_FFPROBE_PATH,
};
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client as S3Client;
use encode_contract::{EncodeJob, EncodeOutput};
use sqlx::PgPool;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::Path;
use tokio::io::AsyncWriteExt;

#[derive(Clone)]
pub struct EncoderState {
    pub(crate) db: PgPool,
    pub(crate) s3: S3Client,
    pub(crate) masters_bucket: String,
    pub(crate) media_bucket: String,
    pub(crate) ffmpeg_path: String,
    pub(crate) ffprobe_path: String,
}

impl EncoderState {
    pub async fn from_env(s3: S3Client) -> Result<Self, ConfigError> {
        let db = db::connect_pool_from_env()
            .await
            .map_err(|source| ConfigError::db_connect(source.to_string()))?;
        Ok(Self {
            db,
            s3,
            masters_bucket: required_env("MASTERS_BUCKET")?,
            media_bucket: required_env("MEDIA_BUCKET")?,
            ffmpeg_path: env::var("FFMPEG_PATH")
                .unwrap_or_else(|_| DEFAULT_FFMPEG_PATH.to_string()),
            ffprobe_path: env::var("FFPROBE_PATH")
                .unwrap_or_else(|_| DEFAULT_FFPROBE_PATH.to_string()),
        })
    }

    pub(crate) async fn write_job_status(&self, job: &EncodeJob) -> Result<(), EncoderError> {
        if job.output.bucket != self.media_bucket {
            return Err(EncoderError::InvalidEvent(format!(
                "job output bucket {} does not match configured media bucket {}",
                job.output.bucket, self.media_bucket
            )));
        }

        db::upsert_encode_job(&self.db, job)
            .await
            .map_err(|source| EncoderError::WriteStatusDatabase {
                job_id: job.job_id.clone(),
                source,
            })?;

        Ok(())
    }

    pub(crate) async fn download_source(
        &self,
        job: &EncodeJob,
        destination: &Path,
    ) -> Result<u64, EncoderError> {
        let parent = destination
            .parent()
            .ok_or_else(|| EncoderError::PathEncoding(destination.to_path_buf()))?;
        fs::create_dir_all(parent).map_err(|source| EncoderError::Io {
            action: "create source directory",
            path: parent.to_path_buf(),
            source,
        })?;

        let mut request = self
            .s3
            .get_object()
            .bucket(&job.input.bucket)
            .key(&job.input.key);
        if let Some(version_id) = &job.input.version_id {
            request = request.version_id(version_id);
        }

        let object = request
            .send()
            .await
            .map_err(|source| EncoderError::DownloadSource {
                bucket: job.input.bucket.clone(),
                key: job.input.key.clone(),
                source: Box::new(source),
            })?;

        let mut file = tokio::fs::File::create(destination)
            .await
            .map_err(|source| EncoderError::Io {
                action: "create source file",
                path: destination.to_path_buf(),
                source,
            })?;
        let mut body = object.body;
        let mut bytes_written = 0u64;

        while let Some(bytes) =
            body.try_next()
                .await
                .map_err(|source| EncoderError::ReadSourceStream {
                    bucket: job.input.bucket.clone(),
                    key: job.input.key.clone(),
                    source: Box::new(source),
                })?
        {
            file.write_all(&bytes)
                .await
                .map_err(|source| EncoderError::Io {
                    action: "write source file",
                    path: destination.to_path_buf(),
                    source,
                })?;
            bytes_written += bytes.len() as u64;
        }

        file.flush().await.map_err(|source| EncoderError::Io {
            action: "flush source file",
            path: destination.to_path_buf(),
            source,
        })?;

        if bytes_written == 0 {
            return Err(EncoderError::InvalidEvent(format!(
                "source object {} is empty",
                job.input.key
            )));
        }

        Ok(bytes_written)
    }

    pub(crate) async fn upload_output_tree(
        &self,
        output: &EncodeOutput,
        root: &Path,
    ) -> Result<HashMap<String, UploadedFile>, EncoderError> {
        if output.bucket != self.media_bucket {
            return Err(EncoderError::InvalidEvent(format!(
                "job output bucket {} does not match configured media bucket {}",
                output.bucket, self.media_bucket
            )));
        }

        let files = collect_files(root)?;
        if files.is_empty() {
            return Err(EncoderError::NoGeneratedFiles(root.to_path_buf()));
        }

        let mut uploaded = HashMap::with_capacity(files.len());
        for file_path in files {
            let relative_path = relative_s3_path(root, &file_path)?;
            let key = join_s3_key(&output.prefix, &relative_path);
            let integrity = file_integrity(&file_path)?;
            let body = ByteStream::from_path(&file_path).await.map_err(|source| {
                EncoderError::ReadUploadFile {
                    path: file_path.clone(),
                    source: Box::new(source),
                }
            })?;

            self.s3
                .put_object()
                .bucket(&output.bucket)
                .key(&key)
                .content_type(content_type_for_path(&file_path))
                .body(body)
                .send()
                .await
                .map_err(|source| EncoderError::UploadOutput {
                    bucket: output.bucket.clone(),
                    key: key.clone(),
                    source: Box::new(source),
                })?;

            uploaded.insert(key, integrity);
        }

        Ok(uploaded)
    }
}
