// Optional deploy-time configuration. Everything here can also be set in the app (Settings).
window.FOLIO_CONFIG = {
  // Google OAuth "Web application" Client ID (public, safe to commit): enables Sign in with Google + Drive sync (see README → Google sign-in).
  googleClientId: '609673488555-673ep33prqni5qpd0t8ucgukfl6vf8js.apps.googleusercontent.com',
  // Where the browser version lives (the Android app points Google sign-in here, because Google blocks sign-in inside WebViews).
  webAppUrl: 'https://geek4945-creator.github.io/folio-reader/',
  // CORS proxy (Cloudflare Worker) used for Project Gutenberg downloads etc.
  proxyUrl: 'https://folio-proxy.geek4945.workers.dev/',
};
