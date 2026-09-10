# Suno Workspace Downloader

A Tampermonkey userscript that detects the signed-in creator's currently loaded Suno tracks and downloads them sequentially as MP3 or WAV.

The script only uses metadata and media URLs supplied by Suno to your existing browser session. It does not export cookies, tokens, prompts, lyrics, or account data, and it does not invent CDN URLs when a format is unavailable.

When Suno refuses a download, the script classifies the refusal, records it per track, and stops rather than retrying or altering the request. See [DOWNLOAD-DIAGNOSTICS.md](./DOWNLOAD-DIAGNOSTICS.md) for the categories, the redaction rules, and the comparison report.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome.
2. Open the Tampermonkey dashboard and choose **Create a new script**.
3. Replace the editor contents with [`suno-downloader.user.js`](./suno-downloader.user.js), then save.
4. Reload an open `https://suno.com/` page.
5. Approve Tampermonkey's requested access to Suno media hosts. Chrome may also ask once whether Suno/Tampermonkey can download multiple files.

## Use

1. Open Library, Create, Studio, your profile, or another Suno page containing track cards.
2. Load or scroll to the tracks you want included. The script scans cards currently present in the page; it does not crawl your entire Library.
3. In the lower-right **Suno Downloader** panel, click **Rescan** if needed.
4. Choose MP3 or WAV and click **Download**.

Only cards attributed to the profile currently signed in to Suno are eligible. On Library, Create, and Studio routes, cards that omit an author label are treated as belonging to the signed-in profile.

Completed downloads are remembered separately for each song and format. Use **Reset history** to make previously completed files eligible again.

## Destination and filenames

The script requests filenames in this form:

```text
Suno/Track title--1234abcd.mp3
```

Chrome and Tampermonkey decide the final destination. Depending on Tampermonkey's download mode and Chrome settings, the `Suno` subfolder may be honored or the file may be placed directly in the normal Downloads folder. Absolute local paths cannot be selected by a userscript.

Windows-invalid filename characters are replaced, whitespace is normalized, and a short song-ID suffix prevents collisions between tracks with identical titles.

## Behavior and troubleshooting

- Downloads run one at a time with a short pause. Temporary and server-side failures are retried twice. Responses are fetched as binary data and checked for HTTP success, minimum size, and MP3/WAV signatures before the same bytes are saved. HTML, playlists, and tiny responses are rejected and are not recorded as completed.
- **HTTP 401 and 403 are never retried.** A refusal is an authorization decision, so the script records it and moves on instead of repeating the request, changing headers or parameters, or falling back to another format. Three consecutive refusals stop the queue; a 401 stops it immediately.
- **WAV asset not exposed** means the script has not observed a WAV URL for that song. Open the song’s own Suno **Download → WAV** option to prepare it, then retry. The script observes WAV URLs returned by Suno; it does not initiate WAV conversion itself or silently substitute MP3.
- **HTTP 429** is treated as a throttle, not a denial: the queue waits for `Retry-After` (capped at 30 seconds) and then takes the bounded retry.
- If the panel reports **signed-in profile not found**, confirm that Suno shows your profile in the sidebar and reload the page.
- The panel automatically rescans as cards change, with a two-second fallback for navigation and virtualized lists. **Rescan** scans immediately; it does not reload the website or load additional library pages.
- If every media URL is unresolved, reload Suno after enabling the userscript. The script starts at document load so it can observe the same metadata Suno uses to render track cards.
- If downloads do not start, set Tampermonkey's download mode to **Browser API** or **Default**, then allow multiple downloads when Chrome prompts.

## Refusals and the comparison report

The panel has three diagnostic sections:

- **Findings** lists each refused track with its category, HTTP status, and a plain-language
  reason.
- **Comparison report** builds a redacted JSON report you can copy with one click. It pairs the
  track list and findings with the observed request log, so Suno's own download flow and the
  scraper's flow can be compared directly.
- **Raw request log** is the underlying recorder output: origin + path, status, content type,
  and redacted JSON field shapes.

Everything the panel exports has cookies, authorization headers, tokens, signatures, URL query
strings, lyrics, and prompts removed before display. `tests.cjs` asserts that.

A refusal is reported, not worked around. The script does not rewrite headers or parameters,
replay a signed URL, poll until an asset appears, or substitute one format for another.
`expired_url` is the one category that leads to another attempt, and only on a run you start
yourself from the **Rescan** button.

## Privacy and scope

The userscript runs only on `suno.com`. Download access is limited to HTTPS hosts under `suno.com` and `suno.ai`, and only minimal song metadata is retained in memory. Persistent storage contains the selected format, completed song/format IDs, and whether the destination notice has been shown.

This tool is intended for downloading your own tracks through your authorized Suno session. Suno's current availability and account permissions still apply.

## Updating to 0.3.2

Replace the installed userscript with the updated file, save, and reload Suno. No new
Tampermonkey permissions are requested. This version adds refusal classification, the
per-track findings list, and the redacted comparison report, and changes 401/403 handling to
stop instead of retrying. Completion history from 0.3.0/0.3.1 is kept.

## Updating to 0.3.0

Replace the installed userscript with the updated file, save, approve the added Tampermonkey permissions, and reload Suno. This version adds `unsafeWindow` for page request observation and `GM_xmlhttpRequest` for binary validation. Completion history starts fresh because 0.1.0 could record invalid files as successful. Existing downloaded files are left in place.

## Verification

Run `node tests.cjs` with Node.js 18 or newer. The focused tests cover binary signatures, small/error responses, song-specific HTML URL extraction, scan scheduling, binary request handling, refusal classification (401/403/404/429/5xx/not-audio), `Retry-After` parsing, the no-retry guarantee on 401 and 403, and report redaction. These use synthetic fixtures; live Suno/Tampermonkey downloads, native-flow observation, and account-dependent WAV preparation still require a browser check.

### Workspace discovery in 0.3.0

The scanner reads song objects from the React props of rendered workspace rows and their nearby components, as well as explicit song links and song-ID attributes. It excludes labeled playbar links. This supports rows without `/song/` anchors, including the workspace views under `/me/workspaces`, `/me`, and `/create?wid=...`. It does not traverse the global React tree or automatically load more pages. React internals may change; this route is covered with simulated rows but has not been verified against the current signed-in Suno layout.

The panel displays the version, pending track count, and captured URL count for the selected format. Changing formats clears results from the previous queue. Zero captured URLs means discovery has not obtained audio metadata; it does not mean those files have been downloaded or that Suno has denied them. WAV preparation remains dependent on Suno’s native download flow.
