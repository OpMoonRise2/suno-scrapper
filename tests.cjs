// Run with Node: node tests.cjs
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(__dirname + '/suno-downloader.user.js', 'utf8');
new vm.Script(source);
const timers = [];
const context = {
  URL, Uint8Array, Blob, DOMException, location: { origin: 'https://suno.com' },
  GM_getValue: () => ({}), GM_setValue: () => {},
  window: { addEventListener() {} },
  document: { readyState: 'loading', addEventListener() {} },
  setTimeout: (fn) => { timers.push(fn); return timers.length; },
};
const instrumented = source.replace('  installMetadataBridge();', '')
  .replace(/\}\)\(\);\s*$/, 'globalThis.test = { validateAudio, extractMetadataFromSongHtml, scheduleScan, runtime, fetchAudio, collectSongObjects, discoverRenderedSongs, resolveMediaUrl, diagnosticShape, diagnosticUrl, classifyFailure, recordFinding, buildReport, scrubReport, downloadWithRetries, parseRetryAfter };})();');
vm.runInNewContext(instrumented, context);
const api = context.test;
assert.equal(api.diagnosticUrl('https://cdn1.suno.ai/song.mp3?token=private'), 'https://cdn1.suno.ai/song.mp3');
const safeDiagnostic = JSON.stringify(api.diagnosticShape({authorization:'private',token:'private',lyrics:'private',download_url:'https://cdn1.suno.ai/song.mp3?signature=private',format:'wav'}));
assert.ok(!safeDiagnostic.includes('private'));
assert.ok(safeDiagnostic.includes('wav'));

const mp3 = new Uint8Array(20000); mp3.set([255,251,144,0]);
const wav = new Uint8Array(20000); wav.set(Buffer.from('RIFF')); wav.set(Buffer.from('WAVE'),8);
assert.doesNotThrow(() => api.validateAudio(mp3.buffer,'mp3','audio/mpeg'));
assert.doesNotThrow(() => api.validateAudio(wav.buffer,'wav','audio/wav'));
assert.throws(() => api.validateAudio(new ArrayBuffer(5000),'mp3'));
assert.throws(() => api.validateAudio(new ArrayBuffer(20000),'mp3','text/html'));
assert.throws(() => api.validateAudio(new ArrayBuffer(20000),'mp3'));
assert.throws(() => api.validateAudio(mp3.buffer,'wav'));
const id = '12345678-1234-4123-8123-123456789abc';
const result = api.extractMetadataFromSongHtml('https://cdn1.suno.ai/other.mp3 https://cdn1.suno.ai/' + id + '.mp3', id);
assert.equal(result.mp3, 'https://cdn1.suno.ai/' + id + '.mp3');
api.scheduleScan(); api.scheduleScan(); api.scheduleScan();
assert.equal(timers.length,1);
timers[0](); assert.equal(api.runtime.scanTimer,null);
api.scheduleScan(); assert.equal(timers.length,2);

const secondId = '87654321-1234-4123-8123-123456789abc';
const firstSong = {id, title:'First workspace song', handle:'gcasales91', audio_url:'https://cdn1.suno.ai/' + id + '.mp3'};
const secondSong = {id:secondId, title:'Second workspace song', handle:'gcasales91', audio_url:'https://cdn1.suno.ai/' + secondId + '.mp3'};
assert.equal(api.collectSongObjects({clip:firstSong}).length,1);
assert.equal(api.collectSongObjects({account:{id,title:'Not a song'}}).length,0);
const row = (song) => ({isConnected:true, getAttribute:()=>null, closest:()=>null,
  '__reactFiber$fixture': {type:'div', return:{type:function SongRow(){},memoizedProps:{clip:song},return:null}}});
context.getComputedStyle = () => ({display:'block',visibility:'visible'});
context.document.querySelector = () => ({querySelectorAll:()=>[row(firstSong),row(secondSong)]});
const discovered = api.discoverRenderedSongs();
assert.equal(discovered.size,2, 'Rows without song anchors must be discovered before playback');
assert.equal(discovered.get(id).song.mp3,firstSong.audio_url);
context.document.querySelector = () => ({querySelectorAll:()=>[row(secondSong)]});
assert.equal(api.discoverRenderedSongs().size,1,'Tracks from the previous view must not remain in the candidate list');

(async () => {
  assert.equal(await api.resolveMediaUrl({songId:id},'mp3'),firstSong.audio_url);
  context.GM_xmlhttpRequest = (options) => { queueMicrotask(() => options.onload({status:200,response:mp3.buffer, responseHeaders:'Content-Type: audio/mpeg', finalUrl:'https://cdn1.suno.ai/song.mp3'})); return {}; };
  assert.equal((await api.fetchAudio('https://cdn1.suno.ai/song.mp3','mp3')).size,20000);
  context.GM_xmlhttpRequest = (options) => { queueMicrotask(() => options.onload({status:403})); return {}; };
  await assert.rejects(api.fetchAudio('https://cdn1.suno.ai/song.mp3','mp3'),/403/);

  // Failure classification: a refusal is labelled, never renegotiated.
  assert.equal(api.classifyFailure({status:401}), 'session_invalid');
  assert.equal(api.classifyFailure({status:429}), 'rate_limited');
  assert.equal(api.classifyFailure({status:403,songId:id}), 'not_entitled');
  assert.equal(api.classifyFailure({status:500}), 'server_error');
  assert.equal(api.classifyFailure({status:404}), 'missing_asset');
  assert.equal(api.classifyFailure({message:'Audio request timed out'}), 'network');
  assert.equal(api.classifyFailure({message:'Response is not WAV audio; no file saved'}), 'not_audio');
  assert.equal(api.parseRetryAfter('Retry-After: 7'), 7000);
  assert.equal(api.parseRetryAfter(''), 0);

  // A 403 that Suno itself already served earlier is an expiry, not an entitlement gap.
  api.runtime.nativeMediaSuccess.add(id);
  assert.equal(api.classifyFailure({status:403,songId:id}), 'expired_url');
  api.runtime.nativeMediaSuccess.delete(id);

  // The core guarantee: a denied asset is requested exactly once.
  let denialAttempts = 0;
  context.GM_xmlhttpRequest = (options) => { denialAttempts += 1; queueMicrotask(() => options.onload({status:403})); return {}; };
  await assert.rejects(api.downloadWithRetries('https://cdn1.suno.ai/' + id + '.mp3','Suno/x.mp3','mp3',id), /403/);
  assert.equal(denialAttempts, 1, 'An HTTP 403 must not be retried');

  let unauthorizedAttempts = 0;
  context.GM_xmlhttpRequest = (options) => { unauthorizedAttempts += 1; queueMicrotask(() => options.onload({status:401})); return {}; };
  await assert.rejects(api.downloadWithRetries('https://cdn1.suno.ai/' + id + '.mp3','Suno/x.mp3','mp3',id), /401/);
  assert.equal(unauthorizedAttempts, 1, 'An HTTP 401 must not be retried');

  // Findings carry no credentials and no query strings.
  api.runtime.tracks = [{songId:id, title:'Private song title', mp3:firstSong.audio_url, wav:null}];
  api.recordFinding({songId:id, title:'Private song title'}, 'mp3', 'not_entitled', {status:403});
  const report = api.buildReport();
  assert.ok(report.includes('not_entitled'), 'report must record the refusal category');
  assert.ok(report.includes('Private song title'), 'report must carry the track title for the operator');
  assert.ok(!/suno\.ai\/[^"]*\?/.test(report), 'report must not contain media query strings');
  assert.ok(report.includes('never retried'), 'report must state the no-retry guarantee');
  assert.ok(!api.scrubReport('{"authorization":"Bearer private","x":"https://cdn1.suno.ai/a.mp3?signature=private"}').includes('private'));
  console.log('Passed: syntax, MP3/WAV validation, invalid payload rejection, song URL association, bounded rescans, validated fetch and HTTP errors.');
  console.log('Passed: refusal classification, no-retry on 401/403, retry-after parsing, redacted comparison report.');
})().catch(error => { console.error(error); process.exitCode=1; });
