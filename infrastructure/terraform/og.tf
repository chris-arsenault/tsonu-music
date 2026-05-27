locals {
  frontend_og_default_image = "/android-chrome-512x512.png"

  frontend_og_routes = [
    {
      pattern     = "/releases/:releaseSlug"
      query       = <<-SQL
        SELECT
          r.title AS title,
          COALESCE(r.description, r.release_kind || ' by ' || r.artist_name || '.') AS description,
          art.image_url AS image_url
        FROM music_published_releases r
        LEFT JOIN LATERAL (
          SELECT COALESCE(NULLIF(source->>'url', ''), 'https://${local.media_hostname}/' || NULLIF(source->>'path', '')) AS image_url
          FROM jsonb_array_elements(r.artwork->'sources') AS source
          WHERE NULLIF(source->>'url', '') IS NOT NULL OR NULLIF(source->>'path', '') IS NOT NULL
          ORDER BY (source->>'width')::integer DESC
          LIMIT 1
        ) art ON true
        WHERE r.slug = $1 AND r.visibility IN ('public', 'unlisted')
      SQL
      title       = "{{title}}"
      description = "{{description}}"
      image       = "{{image_url}}"
      og_type     = "music.album"
    },
    {
      pattern     = "/tracks/:releaseSlug/:trackSlug"
      query       = <<-SQL
        SELECT
          t.title AS title,
          COALESCE(t.description, t.title || ' from ' || r.title || ' by ' || r.artist_name || '.') AS description,
          COALESCE(track_art.image_url, release_art.image_url) AS image_url
        FROM music_published_release_tracks t
        JOIN music_published_releases r ON r.release_id = t.release_id
        LEFT JOIN LATERAL (
          SELECT COALESCE(NULLIF(source->>'url', ''), 'https://${local.media_hostname}/' || NULLIF(source->>'path', '')) AS image_url
          FROM jsonb_array_elements(t.document->'artwork'->'sources') AS source
          WHERE NULLIF(source->>'url', '') IS NOT NULL OR NULLIF(source->>'path', '') IS NOT NULL
          ORDER BY (source->>'width')::integer DESC
          LIMIT 1
        ) track_art ON true
        LEFT JOIN LATERAL (
          SELECT COALESCE(NULLIF(source->>'url', ''), 'https://${local.media_hostname}/' || NULLIF(source->>'path', '')) AS image_url
          FROM jsonb_array_elements(r.artwork->'sources') AS source
          WHERE NULLIF(source->>'url', '') IS NOT NULL OR NULLIF(source->>'path', '') IS NOT NULL
          ORDER BY (source->>'width')::integer DESC
          LIMIT 1
        ) release_art ON true
        WHERE r.slug = $1 AND t.slug = $2 AND r.visibility IN ('public', 'unlisted')
      SQL
      title       = "{{title}}"
      description = "{{description}}"
      image       = "{{image_url}}"
      og_type     = "music.song"
    },
  ]
}
