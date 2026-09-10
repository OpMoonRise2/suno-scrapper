// ==UserScript==
// @name         Suno Workspace Downloader
// @namespace    https://github.com/OpMoonRise2/suno-scrapper
// @version      0.1.0
// @description  Download the signed-in creator's currently loaded Suno tracks as MP3 or WAV.
// @author       OpMoonRise2
// @match        https://suno.com/*
// @run-at       document-start
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
  const SETTINGS_KEY = `${APP_ID}:settings-v1`;
  const SONG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const SONG_PATH_RE = /\/song\/([0-9a-f-]{36})(?:[/?#]|$)/i;
  const RETRY_DELAYS_MS = [0, 1000, 2500];
  const BETWEEN_DOWNLOADS_MS = 1200;
  const OWNED_WORKSPACE_ROUTES = ['/me', '/create', '/studio'];
  const DEFAULT_SETTINGS = {
    format: 'mp3',
    completed: {},
    destinationNoticeShown: false,
  };

  const trackMetadata = new Map();
  const runtime = {
    tracks: [],
    running: false,
    cancelled: false,
    activeDownload: null,
    scanTimer: null,
    ui: null,
  };

  const settings = loadSettings();

  installMetadataBridge();
  window.addEventListener('message', receiveMetadata, false);

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

    const observer = new MutationObserver(() => {
      clearTimeout(runtime.scanTimer);
      runtime.scanTimer = setTimeout(scanTracks, 500);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    window.addEventListener('popstate', scheduleScan);
    window.addEventListener('hashchange', scheduleScan);
  }

  function scheduleScan() {
    clearTimeout(runtime.scanTimer);
    runtime.scanTimer = setTimeout(scanTracks, 250);
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

    const collect = (root) => {
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
            response.clone().json().then((body) => emit(collect(body))).catch(() => {});
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
              emit(collect(JSON.parse(this.responseText)));
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

  function scanTracks() {
    if (!runtime.ui) return;

    const signedInHandle = findSignedInHandle();
    const ownWorkspace = OWNED_WORKSPACE_ROUTES.some((route) => location.pathname.startsWith(route));
    const byId = new Map();
    const songLinks = document.querySelectorAll('a[href*="/song/"]');

    for (const link of songLinks) {
      if (!isRendered(link)) continue;
      const match = new URL(link.href, location.origin).pathname.match(SONG_PATH_RE);
      const songId = match?.[1];
      if (!SONG_ID_RE.test(songId || '')) continue;

      const card = findTrackCard(link);
      const metadata = trackMetadata.get(songId) || {};
      const owner = normalizeHandle(findCardOwner(card)) || metadata.owner || (ownWorkspace ? signedInHandle : null);
      const title = getTrackTitle(link, card) || metadata.title || `untitled-${songId.slice(0, 8)}`;
      const owned = Boolean(signedInHandle && owner && sameHandle(signedInHandle, owner));

      if (!byId.has(songId)) {
        byId.set(songId, {
          songId,
          title,
          owner,
          owned,
          pageUrl: new URL(`/song/${songId}`, location.origin).href,
          mp3: metadata.mp3 || null,
          wav: metadata.wav || null,
        });
      }
    }

    runtime.tracks = [...byId.values()].filter((track) => track.owned);
    renderSummary(signedInHandle, byId.size);
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
    if (label) return label.replace(/^play\s+/i, '');
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
        <div class="title"><span>Suno Downloader</span><span class="badge">loaded tracks</span></div>
        <div class="summary" id="summary">Scanning…</div>
        <div class="format"><label for="format">Format</label><select id="format"><option value="mp3">MP3</option><option value="wav">WAV</option></select></div>
        <div class="controls">
          <button id="rescan">Rescan</button><button class="primary" id="start">Download</button>
          <button id="cancel" disabled>Cancel</button><button id="reset">Reset history</button>
        </div>
        <div class="status" id="status">Ready.</div>
        <progress id="progress" value="0" max="1"></progress>
        <details><summary>Results</summary><ol id="results"></ol></details>
        <div class="foot">Owned tracks only · one download at a time</div>
      </section>`;
    document.documentElement.appendChild(host);

    runtime.ui = {
      host,
      summary: root.getElementById('summary'),
      format: root.getElementById('format'),
      rescan: root.getElementById('rescan'),
      start: root.getElementById('start'),
      cancel: root.getElementById('cancel'),
      reset: root.getElementById('reset'),
      status: root.getElementById('status'),
      progress: root.getElementById('progress'),
      results: root.getElementById('results'),
    };

    runtime.ui.format.value = settings.format === 'wav' ? 'wav' : 'mp3';
    runtime.ui.format.addEventListener('change', () => {
      settings.format = runtime.ui.format.value;
      saveSettings();
      scanTracks();
    });
    runtime.ui.rescan.addEventListener('click', scanTracks);
    runtime.ui.start.addEventListener('click', startQueue);
    runtime.ui.cancel.addEventListener('click', cancelQueue);
    runtime.ui.reset.addEventListener('click', resetHistory);
  }

  function renderSummary(signedInHandle, totalFound) {
    const format = runtime.ui.format.value;
    const skipped = runtime.tracks.filter((track) => isCompleted(track.songId, format)).length;
    const eligible = runtime.tracks.length - skipped;
    const identity = signedInHandle ? `@${signedInHandle}` : 'signed-in profile not found';
    runtime.ui.summary.textContent = `${runtime.tracks.length} owned of ${totalFound} loaded · ${eligible} ready · ${skipped} known · ${identity}`;
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

    for (let index = 0; index < queue.length; index += 1) {
      const track = queue[index];
      if (runtime.cancelled) break;

      setStatus(`Resolving ${index + 1}/${queue.length}: ${track.title}`);
      const url = await resolveMediaUrl(track, format);
      if (!url) {
        failed += 1;
        addResult(`${track.title}: ${format.toUpperCase()} is unavailable`, 'error');
        runtime.ui.progress.value = index + 1;
        continue;
      }

      setStatus(`Downloading ${index + 1}/${queue.length}: ${track.title}`);
      const filename = `Suno/${makeFilename(track.title, track.songId, format)}`;

      try {
        await downloadWithRetries(url, filename);
        markCompleted(track.songId, format);
        completed += 1;
        addResult(`${track.title}: downloaded`, 'ok');
      } catch (error) {
        if (runtime.cancelled || error?.name === 'AbortError') break;
        failed += 1;
        addResult(`${track.title}: ${error?.message || 'download failed'}`, 'error');
      }

      runtime.ui.progress.value = index + 1;
      if (!runtime.cancelled && index < queue.length - 1) await delay(BETWEEN_DOWNLOADS_MS);
    }

    runtime.activeDownload = null;
    runtime.running = false;
    setControlsRunning(false);
    scanTracks();

    if (runtime.cancelled) setStatus(`Cancelled · ${completed} downloaded · ${failed} failed`);
    else setStatus(`Finished · ${completed} downloaded · ${failed} failed`);
  }

  async function resolveMediaUrl(track, format) {
    const cached = trackMetadata.get(track.songId)?.[format] || track[format];
    if (cached) return safeMediaUrl(cached);

    try {
      const pageWindow = typeof unsafeWindow === 'object' ? unsafeWindow : window;
      const response = await pageWindow.fetch(track.pageUrl, { credentials: 'same-origin' });
      if (!response.ok) return null;
      const html = await response.text();
      const extracted = extractMetadataFromSongHtml(html, track.songId);
      if (extracted) mergeMetadata(extracted);
      return trackMetadata.get(track.songId)?.[format] || null;
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
    const mp3 = urls.find((url) => /\.mp3(?:[?#]|$)/i.test(url));
    const wav = urls.find((url) => /\.wav(?:[?#]|$)/i.test(url));
    const title = decoded.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1]
      || decoded.match(/<title>([^<]+)/i)?.[1]
      || null;
    return { songId, title, mp3, wav };
  }

  async function downloadWithRetries(url, name) {
    let lastError;
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
      if (runtime.cancelled) throw abortError();
      if (RETRY_DELAYS_MS[attempt]) await delay(RETRY_DELAYS_MS[attempt]);
      try {
        await downloadOnce(url, name);
        return;
      } catch (error) {
        lastError = error;
        if (runtime.cancelled || error?.name === 'AbortError') throw error;
      }
    }
    throw lastError || new Error('download failed');
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
    addResult('Download history cleared.', 'skip');
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

  function addResult(message, className) {
    const item = document.createElement('li');
    item.textContent = message;
    item.className = className;
    runtime.ui.results.appendChild(item);
  }

  function abortError() {
    return new DOMException('Download cancelled', 'AbortError');
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
})();
