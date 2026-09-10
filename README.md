# Suno Workspace Downloader

A Tampermonkey userscript that detects the signed-in creator's currently loaded Suno tracks and downloads them sequentially as MP3 or WAV.

The script only uses metadata and media URLs supplied by Suno to your existing browser session. It does not export cookies, tokens, prompts, lyrics, or account data, and it does not invent CDN URLs when a format is unavailable.

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

- Downloads run one at a time with a short pause. Temporary failures are retried twice.
- **WAV is unavailable** means Suno did not expose a WAV asset for that track under the current account/session. The script never silently substitutes MP3.
- If the panel reports **signed-in profile not found**, confirm that Suno shows your profile in the sidebar and reload the page.
- If a visible owned track is missing, click **Rescan** after its card has loaded.
- If every media URL is unresolved, reload Suno after enabling the userscript. The script starts at document load so it can observe the same metadata Suno uses to render track cards.
- If downloads do not start, set Tampermonkey's download mode to **Browser API** or **Default**, then allow multiple downloads when Chrome prompts.

## Privacy and scope

The userscript runs only on `suno.com`. Download access is limited to HTTPS hosts under `suno.com` and `suno.ai`, and only minimal song metadata is retained in memory. Persistent storage contains the selected format, completed song/format IDs, and whether the destination notice has been shown.

This tool is intended for downloading your own tracks through your authorized Suno session. Suno's current availability and account permissions still apply.
