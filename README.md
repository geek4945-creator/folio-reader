# Folio Reader

A mobile-first **ebook reader and audiobook player Progressive Web App** inspired by the *workflow* of apps like KyBook 3 (bookshelf, shelves, series sets, catalogs, deep appearance controls). All code, name and artwork here are original.

* Static site, **no backend, no build step**: plain HTML/CSS/ES modules. [epub.js](https://github.com/futurepress/epub.js) 0.3.93 and [JSZip](https://stuk.github.io/jszip/) 3.10 are vendored in `vendor/`, so it works offline.
* Installs to the iPhone home screen (manifest, service worker, apple-touch icons / meta tags).
* Your books live in the browser's IndexedDB. Optional Google sign-in syncs *reading state* (not book files) through your own Drive's hidden app-data folder.
* **Legal sources only.** There is no support for Anna's Archive, Z-Library or similar sites, and "Add a source" refuses them.

## Features

| Area | What you get |
|---|---|
| **Library** | Cover grid or list; sort, group, select and delete (see below);  search (title, author, series); reading-progress badge (NEW / % / ✓); delete; import EPUBs from the **Files app / file picker** (multi-select; on iPhone: Library ⋯ → *Import EPUB files…* → Browse; also drag-and-drop on desktop) or from **Google Drive** (Library ⋯ → *Import from Google Drive…*). |
| **Metadata** | Title, author, language, description and **cover** extracted from the EPUB (JSZip + OPF parsing). Missing covers fall back to the catalog image; the optional **Fix missing info** (below) can fetch [Open Library covers](https://covers.openlibrary.org), then a generated placeholder. |
| **Fix missing info** | Settings → *Missing info* (or Library / Audiobooks ⋯ → *Fix missing info…*). Scans books **and audiobooks** for a missing **cover, author, description, series, year, language**, looks them up in **Open Library** (`search.json`, work / edition records for description + series, `covers.openlibrary.org`) and **Google Books** (`volumes?q=intitle:…+inauthor:…`, no API key), fuzzy-matches on title + author (and ISBN when known) and shows a **review screen**: confidence per match (High ≥ 85 %, Medium ≥ 60 %), per-field tick boxes, **Accept / Skip / Edit**. High-confidence matches are pre-accepted, the rest need your OK. Only *missing* fields are filled; anything you edited by hand is flagged *user-set* and is never changed (even if you cleared it). Progress bar with Cancel, rate limiting (a minimum gap per host and back-off on HTTP 429), and items already checked in the last 30 days aren’t re-proposed. Optional **automatic enrichment on import** (Settings, **off by default**, high-confidence only). |
| **Change cover** | Book / audiobook ⋯ → *Change cover…*: **choose from the device** (photos / files), **choose from Google Drive** (images only; reuses the Drive browser), **paste an image address** (fetched through the proxy when the site blocks CORS), **Search covers** (candidates from Open Library + Google Books, tap to choose) plus a button that opens **Google Images** for “<title> <author> book cover” in a new tab so you can copy the image address and paste it. Every route ends in a **crop / centre preview** (drag or sliders, zoom, “keep whole image”), is saved as a **~400 px JPEG**, marked user-set (automatic lookups never overwrite it) and synced. **Revert to automatic cover** restores the cover inside the file. |
| **Series / sets** | Books are auto-grouped using `calibre:series` / `calibre:series_index`, EPUB3 `belongs-to-collection` + `group-position`, and catalog metadata (OPDS 1 Calibre-style series, OPDS 2 `belongsTo.series`). Sets show as stacked-cover tiles, open to volume order. Create, rename, delete sets; assign a book and volume number manually (⋯ → *Edit details & set*). |
| **Shelves** | Built-in **Currently Reading**, **Want to Read**, **Finished** (+ custom shelves). Opening a book moves it to *Reading*; reaching the end moves it to *Finished*; move manually any time (⋯ → *Move to shelf*). *Library ⋯ → Show Finished as a separate section* toggles whether Finished appears as its own section in **All**. |
| **Custom order** | Sort → *Custom order*, then **press-and-hold (touch) or click-and-drag (mouse)** to reorder within the library/shelf view or inside a set. Persisted per shelf/set in IndexedDB; new books append to the end; **Reset to automatic** restores the previous automatic sort (or volume order in a set). Drag works within a section (e.g. inside *Want to Read*). |
| **Reader** | epub.js: paginated and scroll modes, tap zones (left/right thirds turn pages, centre toggles the toolbar; left/right can be inverted or disabled), swipe, arrow keys, table of contents, bookmarks (☆), position remembered per book, progress slider with locations. |
| **Appearance** | Text size in **points (8–60, 0.5 steps)** with numeric field + − / + buttons + slider, all synced; font family (publisher default, Georgia, Palatino, Iowan, San Francisco, Avenir/Helvetica, mono); line spacing; margins; **8 themes** (Light, Sepia, Paper, Solarized, Dark, Ocean, Forest, Night/black). Themes recolour the reader *and* the app UI. Global defaults persist in `localStorage`. |
| **Per-book overrides** | In the reader's **Aa** panel switch **All books ↔ This book only**. Per-book size / font / line spacing / margins win over the globals and are injected with `!important`, so they beat the EPUB's own CSS. Each has a *Use global …* button; *Reset this book to defaults* clears them all. A gold **Aa** badge (library tile and reader header) shows a book has custom settings. |
| **Formats** | **EPUB, MOBI / AZW / AZW3 / KF8 and PDF** from every import path (Files app / iCloud Drive, drag-and-drop, Google Drive, catalogs). DRM-free Kindle files are converted to EPUB in the browser at import time (vendored [foliate-js](https://github.com/johnfactotum/foliate-js) `mobi.js`), so all reader features work on them. PDFs open in a dedicated pdf.js reader (paged or scrolling, zoom / fit width, page jump, outline, dark-mode inversion, remembered page + zoom). **DRM-protected files (Kindle DRM, KFX, password PDFs) are detected and refused with an explanation — Folio never removes DRM.** |
| **Where to get DRM-free books** | Library menu / Settings → a help screen listing legitimate DRM-free sources (Project Gutenberg, Standard Ebooks, Internet Archive, Smashwords, Kobo’s DRM-free titles, Humble Bundle, publishers such as Tor and Baen). |
| **Public library (Libby / OverDrive)** | Library menu → *Public library*: *Find my library* (search by name or city), search that library’s OverDrive catalog by title, see availability (available / holds), covers, and **Open in Libby** deep links. Loans happen in Libby; Folio does no DRM handling. Libraries with OPDS / Calibre-Web / Koha / Evergreen catalogs can be added as sources (a short list of known public catalogs is built in). |
| **Sorting & grouping** | Per shelf (All, Reading, Want, Finished, each custom shelf) and per set: Recently read / added, Title, Author, Series, Reading progress, File type, **Custom order**, each with an ascending / descending toggle. Choices are remembered per shelf/set and synced; **Settings → Library sorting** sets the default and has *Reset all shelves to default sort*. In **All**, *Group by* Status (default), None (one flat list), Series, Author or File type, with collapsible headers; sort and drag order apply inside each group (the flat list keeps its own order). |
| **Selecting & deleting** | Delete from a book’s ⋯ menu, or **Select** (button in the Library header / menu) → tap books (tapping a set selects its books), *Select all* / *Clear*, then **Delete**, **Move to shelf** or **Mark finished**. **Delete all books…** (Library menu and Settings) needs you to type `DELETE`. Every delete shows a confirm with the count, removes the file, cover, reading position, bookmarks, per-book settings, custom-order entries and any set left empty, and syncs the deletion (tombstones in the Drive app-data state, so other devices drop the book too; re-importing later brings it back). **Originals on the device / in Drive are never touched.** Single and multi deletes offer an **Undo** for ~7 s. |
| **Audiobooks** | A 4th bottom tab. Import **MP3, M4A, M4B, AAC, OGG (also Opus, FLAC, WAV)** from the file picker, drag-and-drop, a folder, a zip or Google Drive; several files (or a folder / zip) become **one audiobook ordered by file name** (natural order: `ch2` before `ch10`). Title, author, cover and **chapters** come from ID3v2 / ID3v1 tags (incl. `CHAP` frames), MP4 atoms (`©nam`, `©ART`, `covr`, Nero `chpl` chapters and QuickTime chapter tracks) and Ogg comments. Library-style grid / list with covers, progress badges, **shelves (shared with ebooks)**, sort (recently played / added, title, author, progress, length, custom drag order), multi-select, delete + Undo. A full player (play / pause, ±15 s, chapter scrubber, previous / next chapter, **speed 0.5–3×** with pitch kept, **sleep timer** 15 / 30 / 45 / 60 min or end of chapter, chapter list), a mini player that keeps playing while you browse, **Media Session** (lock-screen / headset controls and artwork), remembered position and speed per book, and *Finished* at the end. **Free sources:** *LibriVox* (public-domain volunteer recordings) and the *Internet Archive* audio collections (LibriVox + openly licensed audio, lending-only items excluded): stream, or **download for offline**. Audible `.aax` / `.aa` and iTunes `.m4p` files are copy-protected: Folio explains that it can’t import them and never tries to. See *Audiobooks* below. |
| **Reader footer** | *Page X of Y* and *N pages left in chapter* under the reader, readable in every theme, safe-area aware on iPhone, and still visible when the toolbars are hidden. EPUB pages are **rendered pages**: each chapter’s text length is counted once, and characters-per-page is calibrated from what the reader actually lays out (epub.js pagination, or scroll height ÷ viewport height in scroll mode) starting from a font / line-spacing / margin model, so totals follow every change of text size, margins, line spacing, font, layout or window size straight away (themes don’t change layout). Counts and calibrations are cached per book + layout in IndexedDB (*Calculating pages…* only on a book’s first open). PDFs show real page numbers and pages left in the current outline section (the section part is hidden when a PDF has no outline). Switch either part off in the reader’s **Aa** panel or **Settings → Reader footer** (synced). |
| **Install & full screen** | *Add to iPhone Home Screen* button (Library menu / Settings) with an illustrated guide and a dismissible first-visit banner in iOS Safari (warns in Gmail / Messenger-style in-app browsers); Android Chrome gets an *Install app* button via `beforeinstallprompt`. A **Full screen** toggle (reader toolbar + Settings) uses the Fullscreen API; iPhone Safari has none, so it opens the Home Screen guide instead. All of this is hidden when already installed / inside the Android app. |
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
2. Tap **Share → Add to Home Screen → Add** (the app has an illustrated guide: Library menu → *Add to iPhone Home Screen*). It launches full-screen, offline-capable, with its own icon.
3. Import some EPUBs (Library → ＋) or download from the Catalogs tab.
4. Tip: iOS can evict website storage if an app is unused for a long time. The installed home-screen app asks for persistent storage, but to be safe turn on **Google sync** (state) and keep your EPUBs somewhere else too (book *files* are not uploaded).

## Android install

A signed Android APK is published on the [Releases page](https://github.com/geek4945-creator/folio-reader/releases/latest) (no Google Play needed).

1. On the Android phone, open this link and download the file: <https://github.com/geek4945-creator/folio-reader/releases/latest/download/folio-reader.apk>
2. Open the downloaded `folio-reader.apk`. When Android asks, allow your browser / Files app to **install unknown apps** (Settings → Apps → Special access → Install unknown apps), then tap **Install**.
3. Open **Folio Reader** from the app drawer. Books and settings are stored on the device.

Notes:
- The APK wraps the same web app using [Capacitor](https://capacitorjs.com) (app id `com.folio.reader`). It runs from the origin `https://localhost`; the Cloudflare proxy (`proxy/wrangler.toml`, `ALLOW_ORIGIN`) allows that origin alongside the GitHub Pages one.
- **Google sign-in / Drive sync does not work inside the APK**: Google blocks OAuth in embedded WebViews (and the Identity Services popup can’t open there). The app shows a clear message with a link to the browser version (`webAppUrl` in `config.js`); sign in and sync there, and use the Files-app import for Drive books in the APK.
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
* **Cloudflare Worker**: `cd proxy && npx wrangler deploy` (uses `worker.js` + `wrangler.toml`), then set `ALLOW_ORIGIN` in the dashboard. **The current `worker.js` lets any public host through** (the piracy deny-list stays, and localhost / private / link-local addresses are refused); `ALLOW_HOSTS` is now optional and only matters with **`STRICT=1`**, which restores the old allow-list behaviour. Don’t redeploy an older copy over it.

Safety: GET/HEAD only, http(s) only, private/loopback addresses blocked, and — for the **Node proxy** and the Worker with `STRICT=1` — a **host allow-list** (default: Gutenberg, Standard Ebooks, Internet Archive, Open Library, Gutendex, LibriVox; add your own library host to `ALLOW_HOSTS`), redirects re-validated, size cap, piracy-site deny-list, and `ALLOW_ORIGIN` should be set to your app's origin once deployed. Paste the proxy URL in **Settings → Network** (a bare host like `my-proxy.workers.dev` is fine; Folio adds `https://`).

Proxy / network errors are shown in plain language: *“This site isn’t supported”* (proxy deny-list), *“That site blocked the request; try downloading in the browser and importing the file”* (HTTP 403 or a Cloudflare challenge page), and a plain proxy 400 shows the proxy’s own message (for example a private address).

## Add a source (OPDS / HTML)

Catalogs tab → **+ Add a source** → paste a URL (https:// is optional, so `archive.org` or `my-calibre.example.com/opds` work; spaces are stripped and bad input gets a friendly inline message; Internet Archive, Project Gutenberg and Standard Ebooks addresses offer the built-in source, which works much better than the generic page mode, unless you explicitly pick *OPDS feed*) → **Check** (auto-detects OPDS Atom, OPDS JSON, or an HTML page; HTML pages that advertise an OPDS feed via `<link rel="alternate">` are followed) → **Add**.

* OPDS: navigation feeds, acquisition feeds, `rel=next` pagination, OpenSearch description or `{searchTerms}` / `{?query}` templates, `application/epub+zip` acquisition links (lending/DRM "borrow" links are skipped), cover/thumbnail links. Project Gutenberg's two-step result entries are resolved lazily on download.
* HTML mode: finds `<a href="….epub">` (also Calibre-Web `/download/<id>/epub`), grabs the nearest `<img>` and heading as cover/title, follows `rel=next`. If a page has no EPUB links, cards with cover images that link to detail pages are offered as navigation.
* Not supported: sources behind HTTP Basic auth in the URL (browsers strip credentials from `fetch`), and sites that block cross-origin access without a proxy.

## Google sign-in & Drive sync (OAuth setup)

**The OAuth client is already configured**: `config.js` carries the project’s public Web client ID (`609673488555-…apps.googleusercontent.com`; client IDs are not secrets) with authorized origins `https://geek4945-creator.github.io`, `https://localhost` and `http://localhost`, and scopes `drive.readonly`, `drive.appdata`, `openid`, `email`, `profile`. The consent screen is in **Testing** mode, so **every Google account that wants to sign in must be added as a *Test user*** (Google Cloud console → *APIs & Services → OAuth consent screen → Test users*); other accounts see an “access blocked” page. Test-mode grants also expire after 7 days (tap *Reconnect*), unless the app is published. **The Android app can’t sign in**: Google blocks OAuth inside app WebViews, so the app explains this and links to the browser version, where signing in and syncing work normally. The steps below are only needed if you fork the project or deploy somewhere else.

The app uses **Google Identity Services** (token model, no server) with scopes `openid email profile` and `https://www.googleapis.com/auth/drive.appdata` (a private, hidden per-app folder; the app can't see your other Drive files). **Optional** Drive browse/import additionally requests `https://www.googleapis.com/auth/drive.readonly` (incremental, only after you opt in; it is a *restricted* scope, fine for personal use with Test users in *Testing* mode, but public release would need Google verification). If you don't want it, add only `drive.appdata` and ignore the button.

1. Go to <https://console.cloud.google.com/>, create/select a project.
2. **APIs & Services → Library → Google Drive API → Enable.**
3. **OAuth consent screen**: user type *External*, fill in app name and your email, **add the scope** `…/auth/drive.appdata` (a non-sensitive scope; also add `…/auth/drive.readonly` if you want Drive browse/import), add yourself (and your wife) as **Test users** while the app is in *Testing*. (Publish to "In production" to avoid the 7-day refresh of test-mode grants.)
4. **Credentials → Create credentials → OAuth client ID → Web application.**
   * **Authorized JavaScript origins**: every origin you serve from, e.g. `https://you.github.io` and `http://localhost:8080`. (No redirect URI is needed for the token flow.)
5. Copy the **Client ID** (`…apps.googleusercontent.com`) and either paste it in **Settings → Account & sync → Google OAuth Client ID**, or set it in `config.js` (`googleClientId`) before deploying.
6. Tap **Sign in with Google**. The profile name/photo is remembered; **Sync now** or let it auto-sync (5 s after a change, when the app is hidden, on launch, and when coming back online).

**How the session persists.** GIS access tokens last ~1 hour and there is no refresh token without a backend. The app stores the token + expiry and your email locally, renews it ahead of expiry, and when it has expired re-requests one silently (`prompt:''` + `login_hint`), which succeeds without UI while your Google session in Safari is alive. If Google needs interaction (e.g. iOS blocked the hidden popup), Settings shows **Reconnect**; one tap fixes it. **Sign out** forgets the account on this device; **Disconnect** also revokes the app's grant.

**What syncs** (single JSON file `folio-sync.json` in `appDataFolder`): global appearance settings, shelves, sets, custom order, per-book state (shelf/status, set + volume, per-book overrides, reading position/progress, edited title/author) and bookmarks. Book *files* are **never** uploaded; the only images that sync are the small (~400 px) covers you changed or that *Fix missing info* fetched (see **Fix missing info & covers**). Books are matched across devices by EPUB identifier (or title+author), so after you re-import the same EPUBs on a new phone, their shelves/positions/bookmarks reappear (state for books not yet on the device is held and applied when you import/download them). Merge is last-writer-wins per item with tombstones for deleted shelves, sets and bookmarks; same-named sets/shelves created on two devices are merged. **Enriched / hand-edited metadata** (author, description, year, language, series flag, covers) syncs for books *and* audiobooks (audiobook *files* stay on the device).

## Audiobooks

**Adding audio.** Audiobooks tab → ＋ (files), ⋯ → *Import a folder* / *Import from Google Drive*, or drop files / a folder / a zip anywhere on the window. Picking several loose files asks whether they are *one audiobook (ordered by file name)* or *separate audiobooks*; folders and zips are always one book each (a zip with a `cover.jpg` / `folder.jpg` uses it when the audio has no embedded cover). Duplicates are refused. Everything is stored in IndexedDB on the device (`audiobooks` metadata + `audiofiles`, one blob per track) and is **not synced** (files are large); shelves are the same ones as your ebooks. Tags are parsed in the browser by `js/audiotags.js` (no dependencies; reads through `Blob.slice`, so a 500 MB M4B is never loaded whole). Duration comes from the MP3 Xing / VBRI header (or bitrate), the MP4 `mvhd` atom, the last Ogg page or an ADTS frame walk, and only then from the browser itself.

**Player.** One `<audio>` element drives a book-wide timeline across all tracks. The scrubber is *per chapter* (like Apple Books); a bar and *N min left* show the whole book (at your speed). Speed is 0.5–3× in 0.05 steps (presets + slider), pitch-corrected, remembered per book and as the next default. Sleep timer: 15 / 30 / 45 / 60 minutes or *End of chapter* (pauses at the boundary). Position is saved every few seconds, on pause and when the page is hidden, and restored when you reopen the book; reaching the end marks it *Finished* (reopening a finished book starts again). **Media Session** supplies lock-screen title (current chapter), author, cover, play / pause, ±15 s, previous / next chapter and the position scrubber. **Background playback:** Android Chrome and the installed iPhone app keep an `<audio>` element playing with the screen off or the app in the background; iOS Safari tabs and some browsers may still suspend audio, and the OS decides when. Test on your own phone.

**Online sources (legal only).** *LibriVox* (<https://librivox.org/api/feed/audiobooks>, `format=json&extended=1`; title search uses LibriVox’s `^prefix` match, or search by author’s last name) sends **no CORS headers**, so the app retries through your Cloudflare proxy automatically (the Worker allows any public host; the Node proxy now has `librivox.org` in its default allow-list). Its MP3s are served from `archive.org`, which *does* allow browser downloads, so streaming and offline download work without the proxy (`www.archive.org` links are rewritten to `archive.org` because the first redirect hop has no CORS headers). *Internet Archive audio* uses `advancedsearch.php` with `(collection:librivoxaudio OR (collection:audio_bookspoetry AND licenseurl:*creativecommons*)) AND mediatype:audio AND -access-restricted-item:true AND -collection:inlibrary AND -collection:printdisabled`, then `metadata/<id>` for the file list (one consistent MP3 bitrate set, natural order). **Add** keeps the book streaming (a ☁ badge); **⬇ Offline** (or ⋯ → *Download for offline*) copies the tracks into IndexedDB, after which it plays with no network (⋯ → *Remove offline copy* frees the space). Audiobook-piracy sites (e.g. AudiobookBay, Tokybook) are on the app’s block-list and the Worker’s deny-list.

**DRM.** Audible `.aax` / `.aaxc` / `.aa` and iTunes `.m4p` files (and MP4 files whose sample entries are `drms` / `aavd` / `enca`) are detected only to say *“copy-protected, can’t import”*; Folio never decrypts anything. Use DRM-free MP3 / M4B, LibriVox, or your library’s Libby app.

## Fix missing info & covers

**Fix missing info.** Library ⋯ / Audiobooks ⋯ / Settings → *Missing info*. The scan counts what is missing per field; *Start lookup* queries Open Library and Google Books for each item (title, author and ISBN are the only data sent, and only when you start a lookup or turn on automatic enrichment). Matching: titles are normalised (case, accents, leading “The”, subtitles and brackets, `&` → and) and compared with edit distance + token overlap; authors by shared name tokens (so “Herbert, Frank” = “Frank Herbert”); an ISBN match is 99 %. Confidence = 65 % title + 35 % author (70 % cap when the item has no author). Series comes from Open Library edition records (`"Name ; 3"`, `"Name, #3"`, `"Name (Book 3)"`) and creates / joins an auto set; it is only offered when found. Covers are downscaled to a ~400 px JPEG and stored in IndexedDB; thumbnails that block CORS (Google Books) are fetched through your proxy.
**User-set fields.** The *Edit* sheets (now with description, year and language) and anything you type on the review screen mark that field user-set. Lookups never propose, and `applyProposal` never writes, a user-set field. A user-set cover (Change cover) is protected the same way; *Revert to automatic cover* clears the flag.
**Automatic enrichment on import** (Settings → *Missing info*, off by default): after each import Folio looks the item up in the background and applies only **high-confidence** (≥ 85 %) fields. It never blocks the import and failures are silent. (Folio no longer asks Open Library for a cover at import time unless you enable this.)
**Sync.** Each enriched / edited field travels as `{value, at, userSet}` in `folio-sync.json`; a user-set value beats an automatic one, otherwise the newest wins. Covers that were fetched or chosen are stored in `appDataFolder` as content-addressed `cover-<sha1>.jpg` (one small file per distinct image, ~30 KB); the snapshot references them by id, so a new device downloads only what it needs. *Revert to automatic* syncs as a revert marker that outranks an older user cover. Deleting an item records a tombstone (`book` / `audio`) that drops its synced metadata, and cover files nothing references any more are deleted, but only once they are more than an hour old (another device may be mid-sync). Metadata for items you haven’t imported on this device is held and applied when you import them. Scope is unchanged (`drive.appdata` only).
**Optional Google image search.** Set `googleCseKey` and `googleCseCx` in `config.js` (a Programmable Search Engine with *Image search* on + the Custom Search JSON API key) and *Search covers* also lists Google Images results. Without them the *Open Google Images in a new tab* button still works. A key in a public web app is visible to users: restrict it by HTTP referrer.

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
js/kindle.js     Kindle format detection, DRM refusal, MOBI/AZW3 → EPUB conversion
js/pdf.js, js/pdfreader.js   PDF import (metadata, cover) and the pdf.js reader
js/pages.js      reader footer: page counting, calibration + IndexedDB cache
js/audiotags.js, js/audiostore.js, js/audioplayer.js, js/audiobooks.js, js/audiosources.js   audiobooks: tag / chapter parser, data layer + import, player + Media Session, Audiobooks tab, LibriVox / Internet Archive sources
js/enrich.js     Fix missing info: lookup (Open Library / Google Books), fuzzy matching, rate limiting, review screen, auto-enrich
js/covers.js     Change cover: device / Drive / URL / search sources, crop preview, ~400 px JPEG, revert
js/metasync.js   per-field {value, at, userSet} merge for enriched metadata + cover ids (used by google.js)
js/publib.js     public library (Libby / OverDrive) guide, library finder, catalog search, DRM-free help
js/install.js, js/fullscreen.js, js/env.js   Add-to-Home-Screen guide + banner, Full screen toggle, environment detection
js/db.js settings.js util.js
vendor/          epub.min.js (0.3.93), jszip.min.js (3.10.2), foliate-mobi.js, pdfjs/ + licences
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
node tests/e2e-kindle.js        # MOBI / AZW3 / KF8 import (all paths), DRM refusal, series
node tests/e2e-pdf.js           # PDF import + reader
node tests/e2e-sort.js          # per-shelf / per-set sorting, default sort, reset-all
node tests/e2e-group.js         # All view: Group by Status / None / Series / Author / File type
node tests/e2e-delete.js        # single / multi-select / delete-all, Undo, cleanup, cross-device deletion sync
node tests/e2e-pages.js         # reader footer: page counts, recalculation, cache, scroll mode, PDF, themes, safe areas
node tests/e2e-install.js       # Add to Home Screen, Install app, Full screen, Android-app Google message
node tests/e2e-source-url.js    # Add a source: bare domains, friendly errors, built-in redirects
node tests/e2e-proxy-errors.js  # friendly proxy / site-blocked messages
node tests/e2e-publib.js        # Libby / OverDrive finder (mocked, plus one live OverDrive call)
node tests/e2e-audio.js         # audiobooks: import, tags, chapters, player, speed, sleep, Media Session, resume, shelves / sort / delete, LibriVox + IA (mocked + live)
node tests/e2e-enrich.js        # Fix missing info: fuzzy matching, scan, rate limits / 429, review, user-set protection, auto-enrich, two-device Drive sync of metadata + covers (mocked)
node tests/e2e-cover.js         # Change cover: device / Drive / URL (proxy) / search / Google Images / optional CSE, crop, revert, user-set, sync (mocked)
sh tests/fixtures/make-audio.sh # regenerates tests/fixtures/audio/* with ffmpeg (tiny synthetic tones)
```

Edit `executablePath` in the tests if Chrome isn't at `/usr/bin/google-chrome`. The live catalog steps need internet.

## Known gaps

* Google sync was verified against a **mocked** Google (GIS + Drive REST) because the tests can’t sign in to a real Google account; the OAuth client is configured (see above) but a real-account run on a device is still to be done.
* No DRM support (Adobe/LCP, Kindle, KFX, Audible): EPUB, DRM-free MOBI/AZW3 and PDF for books, DRM-free MP3 / M4A / M4B / AAC / OGG for audio. No CBZ. Lending ("borrow") catalog entries are skipped; use Libby for loans.
* Footer page numbers for EPUB are close estimates for chapters you haven’t opened yet (they firm up as you read), and *pages left* counts to the end of the current spine item (chapter file), not to the next TOC anchor inside one file. Selecting books works in the main Library view (not inside a set page).
* Book files are not synced between devices (only state). A Drive-file sync would need the broader `drive.file` scope.
* Drag-to-reorder works within one section/container at a time; there is no cross-shelf drag.
* iOS PWA details were not testable on a physical iPhone here (tested with Chrome device emulation incl. touch events): check the long-press drag feel, install flow and the silent Google token renewal on a real device.
* Audiobooks: files and positions are device-only (not synced; a Drive sync of audio would need the broader `drive.file` scope). No bookmarks inside audiobooks, no gapless playback between files, and the lock-screen / background behaviour was not testable on a physical phone here (headless Chrome only: Media Session metadata and action handlers are verified, the OS-level UI is not). In the **Android APK** the WebView may pause audio when the screen locks or the app is backgrounded (a native foreground service would be needed); use the installed browser app for long background listening. The sleep timer pauses (no fade-out). M4B chapters in unusual layouts (more than one chapter track, chapters in non-UTF text encodings) may not be read; the player then shows one chapter.
* Fix missing info / Change cover were tested against **mocked** Open Library, Google Books and Google Drive (live Google Books returned HTTP 429 from the build sandbox, so the code backs off and degrades to Open Library). Metadata sync is untested with a real Google account on two real devices. Audiobook metadata and covers sync, but audiobook files and positions do not, and deleting an audiobook on one device never deletes it on another. Google Books thumbnails need the proxy (they send no CORS header). A matched description / series is only as good as the source data; always review Medium matches.
* Highlights/notes, in-book search, text-to-speech and page-turn animations are not implemented. Locations (for the % slider) are generated in the background and may take a few seconds on large books.
* epub.js quirks: a restored position can land a page off in a few layouts (handled in most cases); very large EPUBs (>100 MB) are slow to import.
* Gutendex is a third-party free service and is occasionally slow/unavailable; the Gutenberg OPDS source covers the same catalog.
* Internet Archive search is limited to open collections on purpose, so some freely readable IA books outside those collections won't appear.
* Standard Ebooks' catch-all OPDS root requires a Patrons Circle login, so that source starts from a search (`fiction`) instead; their individual EPUB downloads are public.

## Legal

Use Folio with content you own, public-domain works, and openly licensed material. The built-in catalogs are legal sources, and the app deliberately contains no support for piracy sites.
