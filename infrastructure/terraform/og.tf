locals {
  frontend_og_default_image = "/android-chrome-512x512.png"

  frontend_og_routes = [
    {
      pattern     = "/music"
      query       = ""
      title       = "Tsonu Music"
      description = "Albums, previews, demos, and releases by Tsonu."
      image       = local.frontend_og_default_image
      og_type     = "website"
    },
    {
      pattern     = "/albums/:albumSlug"
      query       = "SELECT title, COALESCE(description, release_type || ' by ' || artist_name || '.') AS description, COALESCE(artwork->'sources'->0->>'url', 'https://${local.media_hostname}/' || (artwork->'sources'->0->>'path')) AS image_url FROM music_published_albums WHERE slug = $1 AND visibility IN ('public', 'unlisted')"
      title       = "{{title}}"
      description = "{{description}}"
      image       = "{{image_url}}"
      og_type     = "music.album"
    },
    {
      pattern     = "/tracks/:albumSlug/:trackSlug"
      query       = "SELECT (t.title || ' by ' || a.artist_name) AS title, COALESCE(t.description, t.title || ' from ' || a.title || ' by ' || a.artist_name || '.') AS description, COALESCE(a.artwork->'sources'->0->>'url', 'https://${local.media_hostname}/' || (a.artwork->'sources'->0->>'path')) AS image_url FROM music_published_tracks t JOIN music_published_albums a ON a.album_id = t.album_id WHERE a.slug = $1 AND t.slug = $2 AND a.visibility IN ('public', 'unlisted')"
      title       = "{{title}}"
      description = "{{description}}"
      image       = "{{image_url}}"
      og_type     = "music.song"
    },
  ]
}
