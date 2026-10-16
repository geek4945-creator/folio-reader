// Optional deploy-time configuration. Everything here can also be set in the app (Settings).
window.FOLIO_CONFIG = {
  // Google OAuth "Web application" Client ID (public, safe to commit): enables Sign in with Google + Drive sync (see README → Google sign-in).
  googleClientId: '609673488555-673ep33prqni5qpd0t8ucgukfl6vf8js.apps.googleusercontent.com',
  // Where the browser version lives (the Android app points Google sign-in here, because Google blocks sign-in inside WebViews).
  webAppUrl: 'https://geek4945-creator.github.io/folio-reader/',
  // CORS proxy (Cloudflare Worker) used for Project Gutenberg downloads etc.
  // Optional: Google Programmable Search (Custom Search JSON API) key + engine id (image search enabled). When both are set, “Change cover → Search covers” also lists Google Images results.
  // Leave empty to skip; the “Open Google Images in a new tab” button works without any key. (Keys in a public app are visible to users: restrict them by HTTP referrer.)
  googleCseKey: '',
  googleCseCx: '',
  proxyUrl: 'https://folio-proxy.geek4945.workers.dev/',
};
