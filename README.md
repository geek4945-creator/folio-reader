# Folio Reader

A mobile-first **EPUB reader Progressive Web App** inspired by the *workflow* of apps like KyBook 3 (bookshelf, shelves, series sets, catalogs, deep appearance controls). All code, name and artwork here are original.

* Static site, **no backend, no build step**: plain HTML/CSS/ES modules. [epub.js](https://github.com/futurepress/epub.js) 0.3.93 and [JSZip](https://stuk.github.io/jszip/) 3.10 are vendored in `vendor/`, so it works offline.
* Installs to the iPhone home screen (manifest, service worker, apple-touch icons / meta tags).
* Your books live in the browser's IndexedDB. Optional Google sign-in syncs *reading state* (not book files) through your own Drive's hidden app-data folder.
* **Legal sources only.** There is no support for Anna's Archive, Z-Library or similar sites, and "Add a source" refuses them.

## Features

| Area | What you get |
|---|---|
| **Library** | Cover grid or list; sort by title / author / recent / **custom order**; search (title, author, series); reading-progress badge (NEW / % / ✓); delete; import EPUBs from the **Files app / file picker** (multi-select; on iPhone: Library ⋯ → *Import EPUB files…* → Browse; also drag-and-drop on desktop) or from **Google Drive** (Library ⋯ → *Import from Google Drive…*). |
| **Metadata** | Title, author, language, description and **cover** extracted from the EPUB (JSZip + OPF parsing). Missing covers fall back to the catalog image, then [Open Library covers](https://covers.openlibrary.org), then a generated placeholder. |
| **Series / sets** | Books are auto-grouped using `calibre:series` / `calibre:series_index`, EPUB3 `belongs-to-collection` + `group-position`, and catalog metadata (OPDS 1 Calibre-style series, OPDS 2 `belongsTo.series`). Sets show as stacked-cover tiles, open to volume order. Create, rename, delete sets; assign a book and volume number manually (⋯ → *Edit details & set*). |
| **Shelves** | Built-in **Currently Reading**, **Want to Read**, **Finished** (+ custom shelves). Opening a book moves it to *Reading*; reaching the end moves it to *Finished*; move manually any time (⋯ → *Move to shelf*). *Library ⋯ → Show Finished as a separate section* toggles whether Finished appears as its own section in **All**. |
| **Custom order** | Sort → *Custom order*, then **press-and-hold (touch) or click-and-drag (mouse)** to reorder within the library/shelf view or inside a set. Persisted per shelf/set in IndexedDB; new books append to the end; **Reset to automatic** restores the previous automatic sort (or volume order in a set). Drag works within a section (e.g. inside *Want to Read*). |
| **Reader** | epub.js: paginated and scroll modes, tap zones (left/right thirds turn pages, centre toggles the toolbar; left/right can be inverted or disabled), swipe, arrow keys, table of contents, bookmarks (☆), position remembered per book, progress slider with locations. |
| **Appearance** | Text size in **points (8–60, 0.5 steps)** with numeric field + − / + buttons + slider, all synced; font family (publisher default, Georgia, Palatino, Iowan, San Francisco, Avenir/Helvetica, mono); line spacing; margins; **8 themes** (Light, Sepia, Paper, Solarized, Dark, Ocean, Forest, Night/black). Themes recolour the reader *and* the app UI. Global defaults persist in `localStorage`. |
| **Per-book overrides** | In the reader's **Aa** panel switch **All books ↔ This book only**. Per-book size / font / line spacing / margins win over the globals and are injected with `!important`, so they beat the EPUB's own CSS. Each has a *Use global …* button; *Reset this book to defaults* clears them all. A gold **Aa** badge (library tile and reader header) shows a book has custom settings. |
| **Catalogs** | Pre-seeded: Project Gutenberg (OPDS), Gutenberg via the Gutendex API, Standard Ebooks (OPDS), Internet Archive (open EPUBs only: Gutenberg mirror, pre-1927 Americana, Creative-Commons items; lending-library items excluded). **Add a source**: paste any **OPDS 1 (Atom) or OPDS 2 (JSON)** URL (Calibre-Web `/opds`, Calibre content server `/opds`, COPS, Kavita, Komga…) with browse, OpenSearch search, pagination ("Load more"), covers, and one-tap download straight into the library. Optional **generic HTML mode** scrapes a page you own for `.epub` links and cover images. |
| **Google sync** | Sign in with Google (Identity Services), remembered profile name/photo, silent token renewal, Sign out / Disconnect. Syncs settings, shelves, sets, custom order, per-book overrides, reading positions, bookmarks to Drive `appDataFolder`. Optional **Drive browse/import** (read-only access requested only when you tap *Allow browsing my Drive for EPUBs* in Settings): navigate folders, search, one-tap import of `.epub` files. |

## Run locally

```bash
cd reader-app
python3 -m http.server 8080        # or: npx serve .
# open http://localhost:8080
```

Service workers (and therefore install/offline) need **HTTPS or `localhost`**. Everything uses relative URLs, so the app also works from a sub-path such as `https://you.github.io/folio/`.

## Host it

* **GitHub Pages** – push the folder to a repo, *Settings → Pages → Deploy from branch → / (root)*. 
* **Netlify** – drag-and-drop the folder at app.netlify.com/drop (no build command, publish directory `.`).
* **Cloudflare Pages / any static host / your own nginx** – same: serve the files as-is. 

After a change, bump `VERSION` in `sw.js` (the worker is network-first, so updates normally arrive on the next online launch anyway).

## Install on iPhone

1. Open the hosted **https** URL in **Safari** (it must be Safari for Add to Home Screen on iOS).
2. Tap **Share → Add to Home Screen → Add**. It launches full-screen, offline-capable, with its own icon.
3. Import some EPUBs (Library → ＋) or download from the Catalogs tab.
4. Tip: iOS can evict website storage if an app is unused for a long time. The installed home-screen app asks for persistent storage, but to be safe turn on **Google sync** (state) and keep your EPUBs somewhere else too (book *files* are not uploaded).

## Android install

A signed Android APK is published on the [Releases page](https://github.com/geek4945-creator/folio-reader/releases/latest) (no Google Play needed).

1. On the Android phone, open this link and download the file: <https://github.com/geek4945-creator/folio-reader/releases/latest/download/folio-reader.apk>
2. Open the downloaded `folio-reader.apk`. When Android asks, allow your browser / Files app to **install unknown apps** (Settings → Apps → Special access → Install unknown apps), then tap **Install**.
3. Open **Folio Reader** from the app drawer. Books and settings are stored on the device.

Notes:
- The APK wraps the same web app using [Capacitor](https://capacitorjs.com) (app id `com.folio.reader`). It runs from the origin `https://localhost`; the Cloudflare proxy (`proxy/wrangler.toml`, `ALLOW_ORIGIN`) allows that origin alongside the GitHub Pages one.
- **Google sign-in / Drive sync will not work in the APK until you set your own OAuth client.** Google rejects sign-in from the `https://localhost` origin unless it is listed on your OAuth Web client (add `https://localhost` under *Authorized JavaScript origins*, then set the Client ID in `config.js` or in Settings). The GIS popup flow may still be limited inside an Android WebView, so use the Files-app import for Drive books meanwhile.
- The APK is not updated automatically; install a newer release over the old one (same signing key) to upgrade.

### Building the APK yourself

Needs JDK 17, the Android SDK (platform 34, build-tools 34.0.0) and Node.

```bash
cd android-app
npm install
npm run sync            # copies the web files into www/ and syncs them into android/
cd android
echo "sdk.dir=/path/to/android-sdk" > local.properties
./gradlew assembleRelease   # signed if a keystore.properties exists (see app/build.gradle), else unsigned
```

Signing reads `storeFile`, `storePassword`, `keyAlias`, `keyPassword` from `/workspace/folio-keystore/keystore.properties` (override the path with `FOLIO_KEYSTORE_PROPS`). **Keep your keystore backed up and out of git**: if it is lost you cannot publish upgrades that install over existing installs. Build outputs and keystores are git-ignored.

## Catalogs and CORS

Browsers only let a web page read another site's responses if that site sends CORS headers. What I measured (Oct 2026):

| Source | Catalog / search | Cover images | EPUB download from a static site |
|---|---|---|---|
| Standard Ebooks (`/feeds/opds/all?query=…`) | ✅ CORS `*` | ✅ | ✅ CORS `*` |
| Internet Archive (`advancedsearch`, `metadata`, `download`) | ✅ | ✅ | ✅ |
| Project Gutenberg OPDS (`/ebooks/search.opds/`) | ✅ | ✅ (`<img>`, no CORS needed) | ❌ **no CORS headers → needs the proxy** |
| Gutendex JSON API | ✅ (live-tested) | cover URLs point at gutenberg.org (fine for `<img>`) | ❌ same as above |
| Open Library covers API | ✅ | ✅ | – |
| Your Calibre-Web / COPS etc. | depends on server; usually ❌ unless you add `Access-Control-Allow-Origin` | | |

So for Gutenberg downloads (and most self-hosted servers) use the **optional proxy**. The app tries the direct request first and falls back to the proxy automatically (Settings → Network lets you force "always" or "never"). Without a proxy you see a clear message and can still download in Safari and import the file.

### Proxy

`GET {proxy}?url=<encoded target>` → streams the target back with CORS headers.

* **Node** (no dependencies): `node proxy/server.js` → `http://localhost:8787/`. Env: `PORT`, `ALLOW_HOSTS`, `ALLOW_ORIGIN`, `ALLOW_PRIVATE=1` (only if the proxy runs on your own LAN next to your library server).
* **Cloudflare Worker**: `cd proxy && npx wrangler deploy` (uses `worker.js` + `wrangler.toml`), then set `ALLOW_HOSTS` / `ALLOW_ORIGIN` in the dashboard.

Safety: GET/HEAD only, http(s) only, **host allow-list** (default: Gutenberg, Standard Ebooks, Internet Archive, Open Library, Gutendex; add your own library host to `ALLOW_HOSTS`), private/loopback addresses blocked (Node), redirects re-validated, size cap, piracy-site deny-list, and `ALLOW_ORIGIN` should be set to your app's origin once deployed. Paste the proxy URL in **Settings → Network**.

## Add a source (OPDS / HTML)

Catalogs tab → **+ Add a source** → paste a URL → **Check** (auto-detects OPDS Atom, OPDS JSON, or an HTML page; HTML pages that advertise an OPDS feed via `<link rel="alternate">` are followed) → **Add**.

* OPDS: navigation feeds, acquisition feeds, `rel=next` pagination, OpenSearch description or `{searchTerms}` / `{?query}` templates, `application/epub+zip` acquisition links (lending/DRM "borrow" links are skipped), cover/thumbnail links. Project Gutenberg's two-step result entries are resolved lazily on download.
* HTML mode: finds `<a href="….epub">` (also Calibre-Web `/download/<id>/epub`), grabs the nearest `<img>` and heading as cover/title, follows `rel=next`. If a page has no EPUB links, cards with cover images that link to detail pages are offered as navigation.
* Not supported: sources behind HTTP Basic auth in the URL (browsers strip credentials from `fetch`), and sites that block cross-origin access without a proxy.

## Google sign-in & Drive sync (OAuth setup)

The app uses **Google Identity Services** (token model, no server) with scopes `openid email profile` and `https://www.googleapis.com/auth/drive.appdata` (a private, hidden per-app folder; the app can't see your other Drive files). **Optional** Drive browse/import additionally requests `https://www.googleapis.com/auth/drive.readonly` (incremental, only after you opt in; it is a *restricted* scope, fine for personal use with Test users in *Testing* mode, but public release would need Google verification). If you don't want it, add only `drive.appdata` and ignore the button.

1. Go to <https://console.cloud.google.com/>, create/select a project.
2. **APIs & Services → Library → Google Drive API → Enable.**
3. **OAuth consent screen**: user type *External*, fill in app name and your email, **add the scope** `…/auth/drive.appdata` (a non-sensitive scope; also add `…/auth/drive.readonly` if you want Drive browse/import), add yourself (and your wife) as **Test users** while the app is in *Testing*. (Publish to "In production" to avoid the 7-day refresh of test-mode grants.)
4. **Credentials → Create credentials → OAuth client ID → Web application.**
   * **Authorized JavaScript origins**: every origin you serve from, e.g. `https://you.github.io` and `http://localhost:8080`. (No redirect URI is needed for the token flow.)
5. Copy the **Client ID** (`…apps.googleusercontent.com`) and either paste it in **Settings → Account & sync → Google OAuth Client ID**, or set it in `config.js` (`googleClientId`) before deploying.
6. Tap **Sign in with Google**. The profile name/photo is remembered; **Sync now** or let it auto-sync (5 s after a change, when the app is hidden, on launch, and when coming back online).

**How the session persists.** GIS access tokens last ~1 hour and there is no refresh token without a backend. The app stores the token + expiry and your email locally, renews it ahead of expiry, and when it has expired re-requests one silently (`prompt:''` + `login_hint`), which succeeds without UI while your Google session in Safari is alive. If Google needs interaction (e.g. iOS blocked the hidden popup), Settings shows **Reconnect**; one tap fixes it. **Sign out** forgets the account on this device; **Disconnect** also revokes the app's grant.

**What syncs** (single JSON file `folio-sync.json` in `appDataFolder`): global appearance settings, shelves, sets, custom order, per-book state (shelf/status, set + volume, per-book overrides, reading position/progress, edited title/author) and bookmarks. Book *files* and covers are **not** uploaded. Books are matched across devices by EPUB identifier (or title+author), so after you re-import the same EPUBs on a new phone, their shelves/positions/bookmarks reappear (state for books not yet on the device is held and applied when you import/download them). Merge is last-writer-wins per item with tombstones for deleted shelves, sets and bookmarks; same-named sets/shelves created on two devices are merged.

## Project layout

```
index.html  manifest.webmanifest  sw.js  config.js
css/app.css
js/app.js        tabs, settings screen, account UI, boot
js/library.js    shelves, sets, grid/list, sort, search, menus, import
js/dragsort.js   long-press / mouse drag-to-reorder (touch + pointer events)
js/reader.js     epub.js reader, tap zones, TOC, bookmarks, appearance panel
js/catalogs.js   source list, browse/search/download UI, Add a source
js/opds.js       OPDS Atom/JSON + OpenSearch + HTML-listing parsers
js/net.js        fetch with CORS-proxy fallback, downloads, Open Library covers, site deny-list
js/store.js      data layer (books, sets, shelves, orders, overrides, bookmarks, sources)
js/epubmeta.js   EPUB metadata / cover / series extraction
js/google.js     Google sign-in, Drive appDataFolder sync (snapshot / merge / apply), Drive file listing/download
js/drive.js      "Import from Google Drive" browser sheet
js/db.js settings.js util.js
vendor/          epub.min.js (0.3.93), jszip.min.js (3.10.2) + licences
proxy/           optional CORS proxy: server.js (Node), worker.js + wrangler.toml (Cloudflare)
tests/           headless-Chrome end-to-end tests + mock catalog server + EPUB fixtures
```

## Tests

Headless Chrome via `puppeteer-core` (needs a local Chrome/Chromium):

```bash
npm i puppeteer-core            # once
python3 -m http.server 8765 &   # the app
node tests/mock-server.js &     # mock OPDS/HTML catalogs on :8766
node proxy/server.js &          # proxy on :8787 (for the Gutenberg download test)
node tests/smoke.js             # quick import + no-page-errors check
node tests/e2e.js               # library, reader, appearance, shelves, sets, custom order, drag-drop import (29 steps)
node tests/e2e-catalogs-sync.js # catalogs (mock + live), Google sign-in/sync/Drive browse with Google mocked (24 steps)
```

Edit `executablePath` in the tests if Chrome isn't at `/usr/bin/google-chrome`. The live catalog steps need internet.

## Known gaps

* Google sync was verified against a **mocked** Google (GIS + Drive REST) because no OAuth client is available here; the request shapes follow Google's docs but a real-account run is still to be done.
* No DRM support (Adobe/LCP) and no PDF/MOBI/CBZ/audio: EPUB only. Lending ("borrow") catalog entries are skipped.
* Book files are not synced between devices (only state). A Drive-file sync would need the broader `drive.file` scope.
* Drag-to-reorder works within one section/container at a time; there is no cross-shelf drag.
* iOS PWA details were not testable on a physical iPhone here (tested with Chrome device emulation incl. touch events): check the long-press drag feel, install flow and the silent Google token renewal on a real device.
* Highlights/notes, in-book search, text-to-speech and page-turn animations are not implemented. Locations (for the % slider) are generated in the background and may take a few seconds on large books.
* epub.js quirks: a restored position can land a page off in a few layouts (handled in most cases); very large EPUBs (>100 MB) are slow to import.
* Gutendex is a third-party free service and is occasionally slow/unavailable; the Gutenberg OPDS source covers the same catalog.
* Internet Archive search is limited to open collections on purpose, so some freely readable IA books outside those collections won't appear.
* Standard Ebooks' catch-all OPDS root requires a Patrons Circle login, so that source starts from a search (`fiction`) instead; their individual EPUB downloads are public.

## Legal

Use Folio with content you own, public-domain works, and openly licensed material. The built-in catalogs are legal sources, and the app deliberately contains no support for piracy sites.
