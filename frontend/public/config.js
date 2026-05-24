window.__APP_CONFIG__ = Object.assign(window.__APP_CONFIG__ || {}, {
  app: {
    adminApiBaseUrl: "https://api.music.tsonu.com",
    mediaBaseUrl: "https://media.tsonu.com",
    rum: {
      enabled: false,
      applicationVersion: "local",
      applicationRegion: "us-east-1",
      endpoint: "https://dataplane.rum.us-east-1.amazonaws.com",
      sessionSampleRate: 1,
      allowCookies: false,
      telemetries: ["errors", "performance", "http"],
      playbackEventVersion: 1
    }
  }
});
