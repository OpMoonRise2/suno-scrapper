// ==UserScript==
// @name         Suno Workspace Downloader
// @namespace    https://github.com/OpMoonRise2/suno-scrapper
// @version      0.3.2
// @description  Download the signed-in creator's currently loaded Suno tracks as MP3 or WAV, and classify authorization failures without circumventing them.
// @author       OpMoonRise2
// @match        https://suno.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      suno.com
// @connect      *.suno.com
// @connect      *.suno.ai
// ==/UserScript==

(function () {
  'use strict';

  const APP_ID = 'suno-workspace-downloader';
  const BRIDGE_ID = `${APP_ID}:metadata`;
  const SETTINGS_KEY = `${APP_ID}:settings-v2`;
  const SONG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const SONG_PATH_RE = /\/song\/([0-9a-f-]{36})(?:[/?#]|$)/i;
  const RETRY_DELAYS_MS = [0, 1000, 2500];
  const BETWEEN_DOWNLOADS_MS = 1200;
  const OWNED_WORKSPACE_ROUTES = ['/me', '/create', '/studio', '/workspace', '/library'];
  const MAX_CONSECUTIVE_DENIALS = 3;
  const DEFAULT_SETTINGS = {
    format: 'mp3',
    completed: {},
    destinationNoticeShown: false,
  };

  /**
   * Failure categories describe *why* Suno refused an asset. Every category is
   * diagnostic: none of them causes the script to rewrite a request, replay a
   * signed URL, alter a header, change a format parameter, or substitute one
   * format for another. A refused asset is reported, never renegotiated.
   */
  const FAILURE_CATEGORIES = {
    session_invalid: {
      label: 'session rejected',
      advice: 'Suno returned HTTP 401. Sign in again in this tab, reload, then rescan. The queue stops here.',
    },
    expired_url: {
      label: 'expired media URL',
      advice: 'Suno served this asset to this tab earlier, so the captured URL has most likely expired. Click Rescan to capture a fresh URL, then download again.',
    },
    not_entitled: {
      label: 'not served to this account',
      advice: 'Suno returned HTTP 403 and no earlier success for this asset was observed in this tab. Use Suno’s own Download dialog to confirm whether this track/format is available to you at all.',
    },
    rate_limited: {
      label: 'rate limited',
      advice: 'Suno returned HTTP 429. The queue backs off before the next track. The same refused request is not repeated.',
    },
    missing_asset: {
      label: 'no asset exposed',
      advice: 'Suno exposes no media URL for this format on this song. Open the song’s own Suno Download dialog for this format and retry.',
    },
    server_error: {
      label: 'Suno server error',
      advice: 'Temporary server-side failure. A bounded retry is allowed.',
    },
    not_audio: {
      label: 'response was not audio',
      advice: 'Suno returned a page, playlist, or error document instead of audio. Nothing was saved.',
    },
    network: {
      label: 'network failure',
      advice: 'The request never completed. A bounded retry is allowed.',
    },
    unknown: {
      label: 'unclassified failure',
      advice: 'Inspect the diagnostics record and report entry for this track.',
    },
  };

  const trackMetadata = new Map();
  const runtime = {
    tracks: [],
    running: false,
    cancelled: false,
    activeDownload: null,
    scanTimer: null,
    ui: null,
    signedInHandle: null,
    // Song IDs Suno itself served to this tab during this page session. Used to
    // separate "the URL I captured went stale" from "this account is not
    // entitled", without ever re-requesting a denied asset to find out.
    nativeMediaSuccess: new Set(),
    // Songs whose captured URL was refused after a native success. They
    // re-resolve through the page on the next user-initiated run.
    staleMedia: new Set(),
    findings: [],
  };


  const diagnosticRecords = [];
  function diagnosticUrl(value) {
    try { const url = new URL(value, location.origin); return url.origin + url.pathname; }
    catch (_) { return '(unknown URL)'; }
  }
  function diagnosticShape(value, depth = 0) {
    if (depth > 3) return typeof value;
    if (Array.isArray(value)) return { count: value.length, sample: diagnosticShape(value[0], depth + 1) };
    if (!value || typeof value !== 'object') return typeof value;
    const result = {};
    for (const key of Object.keys(value).slice(0, 40)) {
      if (/token|cookie|authorization|secret|password|email|prompt|lyrics/i.test(key)) continue;
      const item = value[key];
      if (/^(id|clip_id|song_id|clip_ids|song_ids|format|file_type|type|status|is_unlocked|downloadable|can_download|is_downloaded)$/.test(key)) {
        if (Array.isArray(item)) result[key] = item.filter(x => typeof x === 'string' && SONG_ID_RE.test(x)).slice(0, 20);
        else if (typeof item === 'boolean' || typeof item === 'number' || (typeof item === 'string' && (SONG_ID_RE.test(item) || /^(mp3|wav|m4a|mp4|complete|pending|error|success)$/i.test(item)))) result[key] = item;
        else result[key] = typeof item;
      } else if (/url/i.test(key) && typeof item === 'string') result[key] = diagnosticUrl(item);
      else result[key] = diagnosticShape(item, depth + 1);
    }
    return result;
  }
  function recordDiagnostic(record) {
    diagnosticRecords.push({ time: new Date().toISOString(), ...record });
    if (diagnosticRecords.length > 80) diagnosticRecords.shift();
    noteNativeMediaSuccess(record);
    if (runtime.ui?.diagnostics) runtime.ui.diagnostics.value = JSON.stringify(diagnosticRecords, null, 2);
  }

  /**
   * Remembers assets Suno itself already served to this tab. This is evidence
   * gathered by observing Suno's own requests. It is never used to replay or
   * re-sign a URL, only to label a later refusal accurately.
   */
  function noteNativeMediaSuccess(record) {
    if (record.status !== 200) return;
    if (!/^Suno page (fetch|XHR)$/.test(record.source || '')) return;
    if (!/audio|mpeg|wav|octet-stream/i.test(record.contentType || '')) return;
    const id = String(record.url || '').match(SONG_ID_RE)?.[0];
    if (id) runtime.nativeMediaSuccess.add(id.toLowerCase());
  }

  /**
   * Maps a failure to a category. Diagnostic only: no category makes the script
   * rewrite, replay, or renegotiate a request Suno already refused.
   */
  function classifyFailure(error) {
    const status = Number(error?.status) || 0;
    if (status === 401) return 'session_invalid';
    if (status === 429) return 'rate_limited';
    if (status === 403) {
      return runtime.nativeMediaSuccess.has(String(error?.songId || '').toLowerCase())
        ? 'expired_url' : 'not_entitled';
    }
    if (status === 404 || status === 410) return 'missing_asset';
    if (status >= 500) return 'server_error';
    if (/not (?:WAV|MP3) audio|no MP3 audio frame|too small|playlist/i.test(error?.message || '')) return 'not_audio';
    if (status) return 'unknown';
    if (/timed out|network|failed/i.test(error?.message || '')) return 'network';
    return 'unknown';
  }

  function recordFinding(track, format, category, error) {
    const info = FAILURE_CATEGORIES[category] || FAILURE_CATEGORIES.unknown;
    const songId = String(track?.songId || error?.songId || '');
    runtime.findings.push({
      time: new Date().toISOString(),
      songId: songId.slice(0, 8),
      title: String(track?.title || '').slice(0, 80),
      format,
      category,
      status: Number(error?.status) || 0,
      servedEarlierInThisTab: runtime.nativeMediaSuccess.has(songId.toLowerCase()),
      reason: info.advice,
    });
    if (runtime.findings.length > 200) runtime.findings.shift();
    if (category === 'expired_url') runtime.staleMedia.add(songId);
    renderFindings();
    renderReport();
    return info;
  }

  /**
   * Last guard on anything copied out of the panel: strips token-like material
   * even if a future response field slips past diagnosticShape.
   */
  function scrubReport(text) {
    return String(text)
      .replace(/("?(?:authorization|cookie|set-cookie|x-api-key)"?\s*:\s*)"[^"]*"/gi, '$1"[redacted]"')
      .replace(/(authorization|cookie|set-cookie|x-api-key|bearer)\s*[:=]\s*[^\s",}]+/gi, '$1: [redacted]')
      .replace(/\b(token|signature|sig|expires|key|secret|password|session)=[^&\s"']+/gi, '$1=[redacted]');
  }

  function buildReport() {
    const report = {
      generated: new Date().toISOString(),
      script: '0.3.2',
      mode: 'diagnostic only — a refused asset is never retried, rewritten, re-signed, or substituted',
      page: diagnosticUrl(location.href),
      signedInProfile: runtime.signedInHandle,
      format: runtime.ui?.format?.value || settings.format,
      tracks: runtime.tracks.map((track) => ({
        id: track.songId.slice(0, 8),
        title: String(track.title || '').slice(0, 80),
        mp3Observed: Boolean(track.mp3),
        wavObserved: Boolean(track.wav),
        servedEarlierInThisTab: runtime.nativeMediaSuccess.has(track.songId.toLowerCase()),
      })),
      findings: runtime.findings,
      requests: diagnosticRecords,
    };
    return scrubReport(JSON.stringify(report, null, 2));
  }

  function renderReport() {
    if (runtime.ui?.report) runtime.ui.report.value = buildReport();
  }
  function installDownloadDiagnostics() {
    const page = typeof unsafeWindow === 'object' ? unsafeWindow : window;
    const nativeFetch = page.fetch?.bind(page);
    if (nativeFetch) page.fetch = async (...args) => {
      const request = args[0];
      const url = typeof request === 'string' ? request : request?.url;
      const relevant = /download|unlock|audio|wav|mp3|cdn/i.test(diagnosticUrl(url));
      const entry = { source: 'Suno page fetch', method: args[1]?.method || request?.method || 'GET', url: diagnosticUrl(url) };
      if (relevant && typeof args[1]?.body === 'string') {
        try { entry.request = diagnosticShape(JSON.parse(args[1].body)); } catch (_) { entry.request = '(non-JSON body omitted)'; }
      }
      try {
        const response = await nativeFetch(...args);
        if (relevant) {
          entry.status = response.status;
          entry.contentType = response.headers.get('content-type');
          if (/json/i.test(entry.contentType || '')) {
            response.clone().json().then(body => recordDiagnostic({ ...entry, response: diagnosticShape(body) })).catch(() => recordDiagnostic(entry));
          } else recordDiagnostic(entry);
        }
        return response;
      } catch (error) { if (relevant) recordDiagnostic({ ...entry, error: 'Network request rejected' }); throw error; }
    };
    const xhr = page.XMLHttpRequest?.prototype;
    if (xhr) {
      const open = xhr.open;
      xhr.open = function(method, url, ...rest) {
        if (/download|unlock|audio|wav|mp3|cdn/i.test(diagnosticUrl(url))) {
          this.addEventListener('load', () => {
            const entry = { source: 'Suno page XHR', method, url: diagnosticUrl(url), status: this.status };
            try {
              entry.contentType = this.getResponseHeader('content-type');
              if (/json/i.test(entry.contentType || '')) entry.response = diagnosticShape(this.responseType === 'json' ? this.response : JSON.parse(this.responseText));
            } catch (_) { /* Binary bodies and inaccessible responses are omitted. */ }
            recordDiagnostic(entry);
          }, { once: true });
        }
        return open.call(this, method, url, ...rest);
      };
    }
  }

  const settings = loadSettings();

  window.addEventListener('message', receiveMetadata, false);
  installMetadataBridge();
  installDownloadDiagnostics();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }

  function loadSettings() {
    const saved = GM_getValue(SETTINGS_KEY, {});
    return {
      ...DEFAULT_SETTINGS,
      ...(saved && typeof saved === 'object' ? saved : {}),
      completed: saved?.completed && typeof saved.completed === 'object' ? saved.completed : {},
    };
  }

  function saveSettings() {
    GM_setValue(SETTINGS_KEY, settings);
  }

  function initialize() {
    createPanel();
    scanTracks();

    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['href', 'src', 'class', 'style', 'hidden'],
    });
    setInterval(scheduleScan, 2000);
    window.addEventListener('focus', scheduleScan);

    window.addEventListener('popstate', scheduleScan);
    window.addEventListener('hashchange', scheduleScan);
  }

  function scheduleScan() {
    if (runtime.scanTimer !== null) return;
    runtime.scanTimer = setTimeout(() => {
      runtime.scanTimer = null;
      scanTracks();
    }, 250);
  }

  /**
   * Runs in Suno's page context. It observes only JSON returned by Suno and
   * emits the minimum song metadata needed by the userscript. It never emits
   * headers, cookies, tokens, prompts, lyrics, or request bodies.
   */
  function installMetadataBridge() {
    const pageWindow = typeof unsafeWindow === 'object' ? unsafeWindow : window;
    if (pageWindow.__sunoWorkspaceDownloaderBridgeInstalled) return;
    pageWindow.__sunoWorkspaceDownloaderBridgeInstalled = true;

    const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const audioKeys = ['audio_url', 'audioUrl', 'mp3_url', 'mp3Url', 'source_audio_url'];
    const wavKeys = ['wav_url', 'wavUrl', 'audio_url_wav', 'audioUrlWav', 'source_wav_url'];
    const idKeys = ['id', 'clip_id', 'clipId', 'song_id', 'songId', 'audio_id', 'audioId'];

    const cleanUrl = (value) => {
      if (typeof value !== 'string') return null;
      try {
        const url = new URL(value, location.origin);
        return url.protocol === 'https:' ? url.href : null;
      } catch (_) {
        return null;
      }
    };

    const firstString = (object, keys) => {
      for (const key of keys) {
        if (typeof object?.[key] === 'string' && object[key].trim()) return object[key].trim();
      }
      return null;
    };

    const findOwner = (object) => {
      const direct = firstString(object, ['handle', 'user_handle', 'userHandle', 'username']);
      if (direct) return direct.replace(/^@/, '');
      for (const key of ['user', 'creator', 'author']) {
        const nested = object?.[key];
        const value = firstString(nested, ['handle', 'username', 'name']);
        if (value) return value.replace(/^@/, '');
      }
      return null;
    };

    const collect = (root, requestUrl = '') => {
      const found = [];
      const seen = new WeakSet();
      let visited = 0;

      const visit = (value, depth) => {
        if (!value || typeof value !== 'object' || depth > 12 || visited > 30000) return;
        if (seen.has(value)) return;
        seen.add(value);
        visited += 1;

        if (!Array.isArray(value)) {
          const id = firstString(value, idKeys);
          if (idPattern.test(id || '')) {
            const mp3 = cleanUrl(firstString(value, audioKeys));
            const wav = cleanUrl(firstString(value, wavKeys));
            if (mp3 || wav) {
              found.push({
                songId: id,
                title: firstString(value, ['title', 'display_name', 'displayName', 'name']),
                owner: findOwner(value),
                mp3,
                wav,
              });
            }
          }
        }

        for (const child of Object.values(value)) visit(child, depth + 1);
      };

      visit(root, 0);
      const requestId = String(requestUrl).match(/[0-9a-f-]{36}/i)?.[0];
      if (idPattern.test(requestId || '')) {
        const url = cleanUrl(firstString(root, ['wav_url', 'audio_url', 'download_url', 'url']));
        if (url && /\.wav(?:[?#]|$)/i.test(url)) found.push({ songId: requestId, wav: url });
      }
      return found;
    };

    const emit = (payload) => {
      if (!payload.length) return;
      pageWindow.postMessage({ source: BRIDGE_ID, payload }, location.origin);
    };

    const originalFetch = pageWindow.fetch?.bind(pageWindow);
    if (originalFetch) {
      pageWindow.fetch = async (...args) => {
        const response = await originalFetch(...args);
        try {
          const contentType = response.headers.get('content-type') || '';
          if (/json/i.test(contentType)) {
            response.clone().json().then((body) => emit(collect(body, response.url))).catch(() => {});
          }
        } catch (_) {
          // Observation failures must never affect Suno's request.
        }
        return response;
      };
    }

    const XHR = pageWindow.XMLHttpRequest;
    if (XHR?.prototype) {
      const originalOpen = XHR.prototype.open;
      XHR.prototype.open = function (...args) {
        this.addEventListener('load', () => {
          try {
            const contentType = this.getResponseHeader('content-type') || '';
            if (/json/i.test(contentType) && typeof this.responseText === 'string') {
              emit(collect(JSON.parse(this.responseText), this.responseURL));
            }
          } catch (_) {
            // Observation failures must never affect Suno's request.
          }
        }, { once: true });
        return originalOpen.apply(this, args);
      };
    }
  }

  function receiveMetadata(event) {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.source !== BRIDGE_ID || !Array.isArray(event.data.payload)) return;

    for (const item of event.data.payload) mergeMetadata(item);
    scheduleScan();
  }

  function mergeMetadata(item) {
    if (!SONG_ID_RE.test(item?.songId || '')) return;
    const previous = trackMetadata.get(item.songId) || {};
    trackMetadata.set(item.songId, {
      ...previous,
      songId: item.songId,
      title: item.title || previous.title || null,
      owner: normalizeHandle(item.owner) || previous.owner || null,
      mp3: safeMediaUrl(item.mp3) || previous.mp3 || null,
      wav: safeMediaUrl(item.wav) || previous.wav || null,
    });
  }

  function safeMediaUrl(value) {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value, location.origin);
      if (url.protocol !== 'https:') return null;
      if (!/(^|\.)suno\.com$|(^|\.)suno\.ai$/i.test(url.hostname)) return null;
      return url.href;
    } catch (_) {
      return null;
    }
  }

  // Read song objects attached to rendered React rows. Workspace rows do not
  // necessarily contain /song/ anchors; the playbar often does.
  function collectSongObjects(root) {
    const found = new Map();
    const seen = new WeakSet();
    let visited = 0;
    function visit(value, depth) {
      if (!value || typeof value !== 'object' || depth > 7 || visited++ > 2500 || seen.has(value)) return;
      seen.add(value);
      const songId = value.clip_id || value.song_id || value.id;
      const mp3 = safeMediaUrl(value.audio_url || value.audioUrl || value.mp3_url);
      const wav = safeMediaUrl(value.wav_url || value.wavUrl || value.audio_url_wav);
      const title = value.title || value.metadata?.title;
      if (SONG_ID_RE.test(songId || '') && (mp3 || wav || (typeof title === 'string' && ('status' in value || 'metadata' in value)))) {
        found.set(songId, { songId, title, mp3, wav,
          owner: value.handle || value.user_handle || value.user?.handle || value.creator?.handle });
      }
      for (const key of Object.keys(value)) {
        if (['children', '_owner', 'return', 'stateNode', 'ref'].includes(key)) continue;
        try { visit(value[key], depth + 1); } catch (_) { /* Ignore inaccessible props. */ }
      }
    }
    visit(root, 0);
    return [...found.values()];
  }

  function discoverRenderedSongs() {
    const candidates = new Map();
    const pageDocument = (typeof unsafeWindow === 'object' ? unsafeWindow.document : document);
    const surface = pageDocument.querySelector('main, [role="main"]') || pageDocument.body;
    if (!surface) return candidates;
    for (const element of surface.querySelectorAll('*')) {
      if (!isRendered(element) || element.closest('#' + APP_ID)) continue;
      const label = element.getAttribute('aria-label') || '';
      if (/^Playbar:/i.test(label) || element.closest('[data-testid*="playbar"], [aria-label="Playbar"]')) continue;
      const props = [];
      for (const key of Object.keys(element)) {
        if (key.startsWith('__reactProps$')) props.push(element[key]);
        if (key.startsWith('__reactFiber$')) {
          let fiber = element[key];
          for (let depth = 0; fiber && depth < 6; depth++, fiber = fiber.return) {
            if (depth > 0 && typeof fiber.type === 'string') break;
            if (typeof fiber.type !== 'string') props.push(fiber.memoizedProps);
          }
        }
      }
      for (const value of props) for (const song of collectSongObjects(value)) {
        mergeMetadata(song);
        candidates.set(song.songId, { element, song });
      }
      const rawId = element.getAttribute('data-song-id') || element.getAttribute('data-clip-id')
        || element.getAttribute('href')?.match(SONG_PATH_RE)?.[1];
      if (SONG_ID_RE.test(rawId || '') && !candidates.has(rawId)) {
        candidates.set(rawId, { element, song: trackMetadata.get(rawId) || { songId: rawId } });
      }
    }
    return candidates;
  }

  function scanTracks() {
    if (!runtime.ui) return;
    const signedInHandle = findSignedInHandle();
    runtime.signedInHandle = signedInHandle;
    const ownWorkspace = OWNED_WORKSPACE_ROUTES.some((route) => location.pathname === route || location.pathname.startsWith(route + '/'));
    const byId = discoverRenderedSongs();
    runtime.tracks = [];
    for (const [songId, { element, song }] of byId) {
      const card = findTrackCard(element);
      const metadata = trackMetadata.get(songId) || song;
      const owner = metadata.owner || normalizeHandle(findCardOwner(card)) || (ownWorkspace ? signedInHandle : null);
      if (!signedInHandle || !owner || !sameHandle(signedInHandle, owner)) continue;
      runtime.tracks.push({ songId, owner, owned: true,
        title: metadata.title || getTrackTitle(element, card) || 'untitled-' + songId.slice(0, 8),
        pageUrl: new URL('/song/' + songId, location.origin).href,
        mp3: metadata.mp3 || null, wav: metadata.wav || null });
    }
    runtime.ui.host.title = 'Last scanned: ' + new Date().toLocaleTimeString();
    renderSummary(signedInHandle, byId.size);
    renderFindings();
    renderReport();
  }

  function findSignedInHandle() {
    const candidates = [...document.querySelectorAll('a[href^="/@"], a[href*="suno.com/@"]')];
    for (const link of candidates) {
      try {
        const path = new URL(link.href, location.origin).pathname;
        const match = path.match(/^\/@([^/]+)\/?$/);
        if (match) return normalizeHandle(match[1]);
      } catch (_) {
        // Ignore malformed hrefs.
      }
    }
    return null;
  }

  function findTrackCard(link) {
    let node = link;
    let best = link.parentElement;
    for (let depth = 0; node?.parentElement && depth < 8; depth += 1) {
      node = node.parentElement;
      const songCount = node.querySelectorAll?.('a[href*="/song/"]').length || 0;
      const hasCreator = Boolean(node.querySelector?.('a[href^="/@"], a[href*="suno.com/@"]'));
      if (songCount === 1) best = node;
      if (songCount === 1 && hasCreator) return node;
      if (songCount > 4) break;
    }
    return best;
  }

  function findCardOwner(card) {
    const link = card?.querySelector?.('a[href^="/@"], a[href*="suno.com/@"]');
    if (!link) return null;
    try {
      return new URL(link.href, location.origin).pathname.match(/^\/@([^/]+)/)?.[1] || null;
    } catch (_) {
      return null;
    }
  }

  function getTrackTitle(link, card) {
    const text = link.textContent?.trim();
    if (text) return text;
    const label = link.getAttribute('aria-label')?.trim();
    if (label) return label.replace(/^Playbar:\s*Title for\s*/i, '').replace(/^play\s+/i, '');
    const playButton = card?.querySelector?.('button[aria-label^="Play "]');
    return playButton?.getAttribute('aria-label')?.replace(/^Play\s+/i, '').trim() || null;
  }

  function isRendered(element) {
    if (!element.isConnected) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function normalizeHandle(value) {
    return typeof value === 'string' ? value.trim().replace(/^@/, '') : null;
  }

  function sameHandle(left, right) {
    return normalizeHandle(left)?.toLocaleLowerCase() === normalizeHandle(right)?.toLocaleLowerCase();
  }

  function createPanel() {
    if (document.getElementById(APP_ID)) return;

    const host = document.createElement('div');
    host.id = APP_ID;
    host.style.cssText = 'all:initial;position:fixed;right:18px;bottom:82px;z-index:2147483647';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { color-scheme: dark; }
        .panel { width: 310px; box-sizing: border-box; padding: 14px; border: 1px solid #ffffff24;
          border-radius: 14px; background: #121212f2; color: #f4f4f5; box-shadow: 0 12px 36px #0008;
          font: 13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; backdrop-filter: blur(14px); }
        .title { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; font-weight:700; }
        .badge { padding:2px 7px; border-radius:999px; background:#7c3aed; font-size:11px; }
        .summary, .status { color:#c4c4cc; margin:7px 0; }
        .controls { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:10px; }
        button, select { box-sizing:border-box; min-height:34px; border:1px solid #ffffff24; border-radius:8px;
          background:#242428; color:#fff; font:inherit; padding:6px 9px; cursor:pointer; }
        button.primary { background:#7c3aed; border-color:#8b5cf6; font-weight:700; }
        button:disabled, select:disabled { opacity:.5; cursor:not-allowed; }
        .format { display:flex; align-items:center; gap:8px; }
        .format select { flex:1; }
        progress { width:100%; height:8px; accent-color:#8b5cf6; }
        details { margin-top:8px; }
        summary { cursor:pointer; color:#d4d4d8; }
        ol { max-height:145px; overflow:auto; margin:7px 0 0; padding-left:22px; color:#c4c4cc; }
        li.ok { color:#86efac; } li.error { color:#fca5a5; } li.skip { color:#fde68a; }
        .foot { margin-top:8px; color:#8e8e98; font-size:11px; }
      </style>
      <section class="panel" aria-label="Suno Workspace Downloader">
        <div class="title"><span>Suno Downloader 0.3.2</span><span class="badge">loaded tracks</span></div>
        <div class="summary" id="summary">Scanning…</div>
        <div class="format"><label for="format">Format</label><select id="format"><option value="mp3">MP3</option><option value="wav">WAV</option></select></div>
        <div class="controls">
          <button id="rescan">Rescan</button><button class="primary" id="start">Download</button>
          <button id="cancel" disabled>Cancel</button><button id="reset">Reset history</button>
        </div>
        <div class="status" id="status">Ready.</div>
        <progress id="progress" value="0" max="1"></progress>
        <details><summary>Results</summary><ol id="results"></ol></details>
        <details><summary>Findings (<span id="findingCount">0</span>)</summary>
          <p class="status">Why Suno refused each track, in plain terms. A refused asset is never retried, rewritten or renegotiated.</p>
          <ol id="findings"></ol>
        </details>
        <details><summary>Comparison report (no credentials)</summary>
          <button id="copy">Copy report JSON</button>
          <textarea id="report" readonly aria-label="Comparison report" style="width:100%;height:170px;box-sizing:border-box;margin-top:6px"></textarea>
        </details>
        <details><summary>Raw request log (no credentials)</summary><textarea id="diagnostics" readonly aria-label="Download diagnostics" style="width:100%;height:160px;box-sizing:border-box"></textarea></details>
        <div class="foot">Owned tracks only · one download at a time · refusals are reported, not retried</div>
      </section>`;
    document.documentElement.appendChild(host);

    runtime.ui = {
      host,
      diagnostics: root.getElementById('diagnostics'),
      summary: root.getElementById('summary'),
      format: root.getElementById('format'),
      rescan: root.getElementById('rescan'),
      start: root.getElementById('start'),
      cancel: root.getElementById('cancel'),
      reset: root.getElementById('reset'),
      status: root.getElementById('status'),
      progress: root.getElementById('progress'),
      results: root.getElementById('results'),
      findings: root.getElementById('findings'),
      findingCount: root.getElementById('findingCount'),
      report: root.getElementById('report'),
      copy: root.getElementById('copy'),
    };

    runtime.ui.format.value = settings.format === 'wav' ? 'wav' : 'mp3';
    runtime.ui.format.addEventListener('change', () => {
      runtime.ui.results.replaceChildren();
      setStatus('Ready for ' + runtime.ui.format.value.toUpperCase() + '.');
      settings.format = runtime.ui.format.value;
      saveSettings();
      scanTracks();
    });
    runtime.ui.rescan.addEventListener('click', rescan);
    runtime.ui.start.addEventListener('click', startQueue);
    runtime.ui.cancel.addEventListener('click', cancelQueue);
    runtime.ui.reset.addEventListener('click', resetHistory);
    runtime.ui.copy.addEventListener('click', copyReport);
    renderReport();
  }

  /**
   * Rescan is explicit and user-driven, and it is the only path that drops
   * captured media URLs. It re-reads the page the user is looking at; it never
   * re-requests an asset Suno already refused.
   */
  function rescan() {
    runtime.staleMedia.clear();
    for (const [songId, metadata] of trackMetadata) trackMetadata.set(songId, { ...metadata, mp3: null, wav: null });
    scanTracks();
  }

  function copyReport() {
    const text = buildReport();
    runtime.ui.report.value = text;
    const fallback = () => { runtime.ui.report.select?.(); setStatus('Report ready — press Ctrl+C to copy.'); };
    try {
      navigator.clipboard.writeText(text).then(() => setStatus('Comparison report copied.'), fallback);
    } catch (_) {
      fallback();
    }
  }

  function renderFindings() {
    if (!runtime.ui?.findings) return;
    runtime.ui.findingCount.textContent = String(runtime.findings.length);
    runtime.ui.findings.replaceChildren();
    for (const finding of runtime.findings.slice(-25)) {
      addListItem(runtime.ui.findings,
        `${finding.title} [${String(finding.format).toUpperCase()}] ${FAILURE_CATEGORIES[finding.category]?.label || finding.category}`
        + `${finding.status ? ' · HTTP ' + finding.status : ''} — ${finding.reason}`, 'error');
    }
  }

  function renderSummary(signedInHandle, totalFound) {
    const format = runtime.ui.format.value;
    const skipped = runtime.tracks.filter((track) => isCompleted(track.songId, format)).length;
    const eligible = runtime.tracks.length - skipped;
    const identity = signedInHandle ? `@${signedInHandle}` : 'signed-in profile not found';
    runtime.ui.summary.textContent = `${runtime.tracks.length} owned of ${totalFound} loaded · ${eligible} pending · ${runtime.tracks.filter((track) => track[format]).length} ${format.toUpperCase()} URLs · ${skipped} known · ${identity}`;
    runtime.ui.start.disabled = runtime.running || eligible === 0;
  }

  async function startQueue() {
    if (runtime.running) return;
    scanTracks();

    const format = runtime.ui.format.value;
    const known = runtime.tracks.filter((track) => isCompleted(track.songId, format));
    const queue = runtime.tracks.filter((track) => !isCompleted(track.songId, format));
    runtime.ui.results.replaceChildren();
    for (const track of known) addResult(`${track.title}: already downloaded as ${format.toUpperCase()}`, 'skip');
    if (!queue.length) {
      setStatus('Nothing new to download.');
      return;
    }

    if (!settings.destinationNoticeShown) {
      addResult('Downloads will request the Suno/ subfolder; Chrome may use your normal Downloads folder instead.', 'skip');
      settings.destinationNoticeShown = true;
      saveSettings();
    }

    runtime.running = true;
    runtime.cancelled = false;
    runtime.ui.progress.max = queue.length;
    runtime.ui.progress.value = 0;
    setControlsRunning(true);

    let completed = 0;
    let failed = 0;
    let consecutiveDenials = 0;
    let stopReason = null;

    for (let index = 0; index < queue.length; index += 1) {
      const track = queue[index];
      if (runtime.cancelled) break;

      setStatus(`Resolving ${index + 1}/${queue.length}: ${track.title}`);
      const url = await resolveMediaUrl(track, format);
      if (!url) {
        failed += 1;
        recordFinding(track, format, 'missing_asset', new Error('No media URL exposed for this format'));
        addResult(`${track.title}: no ${format.toUpperCase()} asset exposed — ${FAILURE_CATEGORIES.missing_asset.advice}`, 'error');
        runtime.ui.progress.value = index + 1;
        continue;
      }

      setStatus(`Downloading ${index + 1}/${queue.length}: ${track.title}`);
      const filename = `Suno/${makeFilename(track.title, track.songId, format)}`;

      try {
        await downloadWithRetries(url, filename, format, track.songId);
        markCompleted(track.songId, format);
        runtime.staleMedia.delete(track.songId);
        completed += 1;
        consecutiveDenials = 0;
        addResult(`${track.title}: downloaded`, 'ok');
      } catch (error) {
        if (runtime.cancelled || error?.name === 'AbortError') break;
        const category = classifyFailure(error);
        const info = recordFinding(track, format, category, error);
        failed += 1;
        addResult(`${track.title}: ${info.label}`
          + `${error?.status ? ' · HTTP ' + error.status : ''} — ${info.advice}`, 'error');

        if (category === 'session_invalid') {
          stopReason = 'Stopped: Suno rejected this tab’s session (HTTP 401). Sign in again, then rescan.';
          break;
        }
        if (category === 'not_entitled' || category === 'expired_url') {
          consecutiveDenials += 1;
          if (consecutiveDenials >= MAX_CONSECUTIVE_DENIALS) {
            stopReason = `Stopped after ${consecutiveDenials} consecutive refusals. Suno is not serving these assets to this account right now; the remaining tracks were left untouched.`;
            break;
          }
        } else {
          consecutiveDenials = 0;
        }
      }

      runtime.ui.progress.value = index + 1;
      if (!runtime.cancelled && index < queue.length - 1) await delay(BETWEEN_DOWNLOADS_MS);
    }

    runtime.activeDownload = null;
    runtime.running = false;
    setControlsRunning(false);
    renderFindings();
    scanTracks();

    if (stopReason) setStatus(stopReason);
    else if (runtime.cancelled) setStatus(`Cancelled · ${completed} downloaded · ${failed} failed`);
    else setStatus(`Finished · ${completed} downloaded · ${failed} failed`);
  }

  async function resolveMediaUrl(track, format) {
    // A refused URL is dropped from cache, so the next user-initiated run asks
    // the page for the asset again instead of replaying the stale capture.
    const cached = runtime.staleMedia.has(track.songId)
      ? null
      : (trackMetadata.get(track.songId)?.[format] || track[format]);
    if (cached) return safeMediaUrl(cached);

    try {
      const pageWindow = typeof unsafeWindow === 'object' ? unsafeWindow : window;
      const response = await pageWindow.fetch(track.pageUrl, { credentials: 'same-origin' });
      if (!response.ok) return null;
      const html = await response.text();
      const extracted = extractMetadataFromSongHtml(html, track.songId);
      if (extracted) mergeMetadata(extracted);
      const resolved = trackMetadata.get(track.songId)?.[format] || null;
      if (resolved) runtime.staleMedia.delete(track.songId);
      return resolved;
    } catch (_) {
      return null;
    }
  }

  function extractMetadataFromSongHtml(html, songId) {
    const decoded = String(html)
      .replaceAll('\\u0026', '&')
      .replaceAll('\\/', '/')
      .replaceAll('&amp;', '&');
    const urls = decoded.match(/https:\/\/[^"'<>\\\s]+/g) || [];
    const belongsToSong = (url) => safeMediaUrl(url) && url.toLowerCase().includes(songId.toLowerCase());
    const mp3 = urls.find((url) => belongsToSong(url) && /\.mp3(?:[?#]|$)/i.test(url));
    const wav = urls.find((url) => belongsToSong(url) && /\.wav(?:[?#]|$)/i.test(url));
    const title = decoded.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1]
      || decoded.match(/<title>([^<]+)/i)?.[1]
      || null;
    return { songId, title, mp3, wav };
  }

  async function downloadWithRetries(url, name, format, songId) {
    let lastError;
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
      if (runtime.cancelled) throw abortError();
      if (RETRY_DELAYS_MS[attempt]) await delay(RETRY_DELAYS_MS[attempt]);
      try {
        const blob = await fetchAudio(url, format, songId);
        if (runtime.cancelled) throw abortError();
        const objectUrl = URL.createObjectURL(blob);
        try {
          await downloadOnce(objectUrl, name);
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
        return;
      } catch (error) {
        lastError = error;
        if (!error.songId) error.songId = songId;
        if (runtime.cancelled || error?.name === 'AbortError') throw error;
        // HTTP 401/403 is an authorization decision. Repeating the identical
        // request cannot legitimately change it, so it is never retried, never
        // rewritten, and never falls back to another format.
        if ([401, 403].includes(error?.status)) throw error;
        // HTTP 429 is a throttle rather than a denial: back off, then take the
        // bounded retry.
        if (error?.status === 429 && error.retryAfter) await delay(error.retryAfter);
      }
    }
    throw lastError || new Error('download failed');
  }


  function validateAudio(buffer, format, contentType = '') {
    const bytes = new Uint8Array(buffer);
    if (/text\/|json|xml|mpegurl/i.test(contentType)) {
      throw new Error('Server returned a page or playlist instead of audio; no file saved');
    }
    if (bytes.length < 16384) throw new Error('Audio response is too small; no file saved');
    const ascii = (start, length) => String.fromCharCode(...bytes.subarray(start, start + length));
    if (format === 'wav') {
      if (!['RIFF', 'RF64'].includes(ascii(0, 4)) || ascii(8, 4) !== 'WAVE') {
        throw new Error('Response is not WAV audio; no file saved');
      }
    } else {
      let offset = 0;
      if (ascii(0, 3) === 'ID3') {
        offset = 10 + ((bytes[6] & 127) * 2097152 + (bytes[7] & 127) * 16384
          + (bytes[8] & 127) * 128 + (bytes[9] & 127));
        if (bytes[5] & 16) offset += 10;
      }
      let frame = false;
      for (let i = offset; i < Math.min(bytes.length - 3, offset + 4096); i += 1) {
        if (bytes[i] === 255 && (bytes[i + 1] & 224) === 224
          && (bytes[i + 1] & 24) !== 8 && (bytes[i + 1] & 6) === 2
          && (bytes[i + 2] & 240) !== 0 && (bytes[i + 2] & 240) !== 240
          && (bytes[i + 2] & 12) !== 12) { frame = true; break; }
      }
      if (!frame) throw new Error('Response contains no MP3 audio frame; no file saved');
    }
  }

  function parseRetryAfter(headers) {
    const seconds = Number(String(headers || '').match(/^retry-after:\s*(\d+)/im)?.[1]);
    return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 30000) : 0;
  }

  function fetchAudio(url, format, songId) {
    return new Promise((resolve, reject) => {
      if (runtime.cancelled) { reject(abortError()); return; }
      runtime.activeDownload = GM_xmlhttpRequest({
        method: 'GET', url, responseType: 'arraybuffer', timeout: 180000,
        onload: (response) => {
          recordDiagnostic({ source: 'Scraper background request', method: 'GET', url: diagnosticUrl(url), status: response.status,
            contentType: response.responseHeaders?.match(/^content-type:\s*([^\r\n]+)/im)?.[1] || '', bytes: response.response?.byteLength || 0 });
          runtime.activeDownload = null;
          try {
            if (runtime.cancelled) throw abortError();
            if (response.status !== 200) {
              const error = new Error('Audio request failed: HTTP ' + response.status);
              error.status = response.status;
              error.songId = songId;
              error.retryAfter = parseRetryAfter(response.responseHeaders);
              throw error;
            }
            if (!safeMediaUrl(response.finalUrl || url)) {
              const redirect = new Error('Unexpected audio redirect');
              redirect.songId = songId;
              throw redirect;
            }
            const contentType = response.responseHeaders?.match(/^content-type:\s*([^\r\n]+)/im)?.[1] || '';
            try {
              validateAudio(response.response, format, contentType);
            } catch (invalid) {
              invalid.songId = songId;
              throw invalid;
            }
            resolve(new Blob([response.response], { type: format === 'wav' ? 'audio/wav' : 'audio/mpeg' }));
          } catch (error) { reject(error); }
        },
        onerror: () => { runtime.activeDownload = null; reject(new Error('Audio request failed')); },
        ontimeout: () => { runtime.activeDownload = null; reject(new Error('Audio request timed out')); },
        onabort: () => { runtime.activeDownload = null; reject(abortError()); },
      });
    });
  }

  function downloadOnce(url, name) {
    return new Promise((resolve, reject) => {
      try {
        runtime.activeDownload = GM_download({
          url,
          name,
          saveAs: false,
          conflictAction: 'uniquify',
          onload: () => {
            runtime.activeDownload = null;
            resolve();
          },
          onerror: (details) => {
            runtime.activeDownload = null;
            reject(new Error(details?.error || 'download failed'));
          },
          onabort: () => {
            runtime.activeDownload = null;
            reject(abortError());
          },
          ontimeout: () => {
            runtime.activeDownload = null;
            reject(new Error('download timed out'));
          },
        });
      } catch (error) {
        runtime.activeDownload = null;
        reject(error);
      }
    });
  }

  function cancelQueue() {
    if (!runtime.running) return;
    runtime.cancelled = true;
    setStatus('Cancelling…');
    try {
      runtime.activeDownload?.abort?.();
    } catch (_) {
      // The queue will still stop before the next file.
    }
  }

  function resetHistory() {
    settings.completed = {};
    saveSettings();
    runtime.findings = [];
    runtime.staleMedia.clear();
    runtime.ui.results.replaceChildren();
    renderFindings();
    renderReport();
    setStatus('Download history cleared. Ready for ' + runtime.ui.format.value.toUpperCase() + '.');
    scanTracks();
  }

  function markCompleted(songId, format) {
    settings.completed[`${songId}:${format}`] = Date.now();
    saveSettings();
  }

  function isCompleted(songId, format) {
    return Boolean(settings.completed[`${songId}:${format}`]);
  }

  function makeFilename(title, songId, format) {
    const cleanTitle = String(title || 'untitled')
      .normalize('NFKC')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/g, '')
      .trim()
      .slice(0, 150) || 'untitled';
    return `${cleanTitle}--${songId.slice(0, 8)}.${format}`;
  }

  function setControlsRunning(running) {
    runtime.ui.start.disabled = running;
    runtime.ui.rescan.disabled = running;
    runtime.ui.reset.disabled = running;
    runtime.ui.format.disabled = running;
    runtime.ui.cancel.disabled = !running;
  }

  function setStatus(message) {
    runtime.ui.status.textContent = message;
  }

  function addListItem(list, message, className) {
    const item = document.createElement('li');
    item.textContent = message;
    item.className = className;
    list.appendChild(item);
  }

  function addResult(message, className) {
    addListItem(runtime.ui.results, message, className);
  }

  function abortError() {
    return new DOMException('Download cancelled', 'AbortError');
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
})();
