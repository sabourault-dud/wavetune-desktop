// main.js — Wave Tune Desktop v7 — Multi-source universel
const { app, BrowserWindow, ipcMain, dialog, shell, globalShortcut, Notification } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { execFile } = require('child_process');
const { autoUpdater } = require('electron-updater');

const AUDIO = new Set(['.mp3','.m4a','.aac','.flac','.wav','.ogg','.opus','.wma','.aiff','.alac']);
const VIDEO = new Set(['.mp4','.m4v','.mov','.avi','.mkv','.wmv','.mpg','.mpeg','.webm']);
const { setupCoverCache } = require('./cover-cache');

let win = null;
// ════════════════════════════════════════════════════════════════════
// AUTO-UPDATER — checks GitHub Releases on launch, prompts on new version
// ════════════════════════════════════════════════════════════════════
function setupAutoUpdater() {
  // Pas de check en dev (l'app n'est pas packagée)
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    console.warn('[updater] error:', err?.message || err);
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[updater] update available:', info.version);
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[updater] up to date');
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[updater] downloaded:', info.version);
    dialog.showMessageBox({
      type: 'info',
      buttons: ['Redémarrer maintenant', 'Plus tard'],
      defaultId: 0,
      title: 'Mise à jour disponible',
      message: `Wave Tune ${info.version} est prêt à être installé.`,
      detail: 'Redémarre maintenant pour appliquer la mise à jour.',
    }).then(result => {
      if (result.response === 0) autoUpdater.quitAndInstall();
    });
  });

  // Vérifie 5 secondes après le démarrage (laisse le temps à l'app de charger)
  // puis toutes les 4 heures
  setTimeout(() => autoUpdater.checkForUpdatesAndNotify(), 5000);
  setInterval(() => autoUpdater.checkForUpdatesAndNotify(), 4 * 60 * 60 * 1000);
}
const PREFS = path.join(os.homedir(), '.wavetune', 'prefs.json');
const SCAN_CACHE = path.join(os.homedir(), '.wavetune', 'scan-cache.json');

const axios = require('axios');
const FormData = require('form-data');

// ══════════════════════════════════════════════════════════
// ACOUSTID FINGERPRINTING — fpcalc binary + AcoustID API
// ══════════════════════════════════════════════════════════
function locateFpcalc(){
  const platform = process.platform;       // 'darwin' | 'win32' | 'linux'
  const arch = process.arch;                // 'x64' | 'arm64'
  const exe = platform === 'win32' ? 'fpcalc.exe' : 'fpcalc';
  const candidates = [];

  // Platform-specific bundled name (matches what we put in bin/)
  const bundledName = platform === 'darwin' ? 'fpcalc-darwin-universal' :
                      platform === 'win32'  ? `fpcalc-win32-${arch}.exe` :
                                              `fpcalc-linux-${arch}`;

  // 1. Production: bundled inside the packaged app
  try {
    if(process.resourcesPath){
      candidates.push(path.join(process.resourcesPath, 'bin', bundledName));
      candidates.push(path.join(process.resourcesPath, 'bin', exe));
    }
  } catch(_){}

  // 2. Development: alongside main.js in the project's bin/ folder
  candidates.push(path.join(__dirname, 'bin', bundledName));
  candidates.push(path.join(__dirname, 'bin', exe));

  // 3. System-wide install (Homebrew, etc.)
  if(platform === 'darwin' || platform === 'linux'){
    candidates.push('/opt/homebrew/bin/fpcalc');
    candidates.push('/usr/local/bin/fpcalc');
    candidates.push('/usr/bin/fpcalc');
  }

  // 4. Bare name on PATH
  candidates.push(exe);

  for(const c of candidates){
    try {
      // Path-like candidates: must exist on disk
      if(c.includes('/') || c.includes('\\')){
        if(fs.existsSync(c)){
          console.log(`[acoustid] using fpcalc at: ${c}`);
          return c;
        }
      }
    } catch(_){}
  }
  console.log('[acoustid] fpcalc not found — fingerprinting disabled');
  return null;
}

let _fpcalcPath = null;
function getFpcalcPath(){
  if(_fpcalcPath !== null) return _fpcalcPath;
  _fpcalcPath = locateFpcalc() || '';  // empty string = "tried, failed, don't retry"
  return _fpcalcPath;
}

// Run fpcalc on an audio file. Returns { fingerprint, duration } or null.
function fingerprintFile(audioPath){
  return new Promise((resolve) => {
    const fpcalc = getFpcalcPath();
    if(!fpcalc){ resolve(null); return; }
    if(!audioPath || !fs.existsSync(audioPath)){ resolve(null); return; }
    execFile(fpcalc, ['-json', audioPath], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if(err){
        console.log(`[acoustid] fpcalc failed for ${audioPath}: ${err.message}`);
        resolve(null);
        return;
      }
      try {
        const data = JSON.parse(stdout);
        if(data && data.fingerprint && data.duration){
          resolve({ fingerprint: data.fingerprint, duration: Math.round(data.duration) });
        } else { resolve(null); }
      } catch(_){ resolve(null); }
    });
  });
}

// Query AcoustID with a fingerprint+duration. Returns { artist, album, title, year, score } or null.
async function fetchFromAcoustID(fingerprint, duration){
  if(!fingerprint || !duration) return null;
  // ── DISABLED ── AcoustID requires a registered client key.
  // Community-shared metadata path will replace this. Re-enable by removing
  // the `return null` below and providing a real client key in the URL.
  return null;
  try {
    const url = `https://api.acoustid.org/v2/lookup?client=8XaBELgH&format=json&duration=${duration}&fingerprint=${encodeURIComponent(fingerprint)}&meta=recordings+releasegroups+compress`;
    const data = await httpsGet(url);
    if(!data || data.status !== 'ok' || !data.results?.length) return null;
    const best = data.results.find(r => r.score >= 0.7);
    if(!best || !best.recordings?.length) return null;
    const rec = best.recordings[0];
    let year = null, album = null;
    for(const rg of (rec.releasegroups || [])){
      if(rg.firstreleasedate){
        const y = parseInt(String(rg.firstreleasedate).slice(0, 4));
        if(y && (!year || y < year)){ year = y; album = rg.title || album; }
      }
    }
    if(!album && rec.releasegroups?.[0]) album = rec.releasegroups[0].title;
    console.log(`[acoustid] match score=${best.score.toFixed(2)} → ${rec.artists?.[0]?.name || '?'} - ${rec.title || '?'} (${year || '?'})`);
    return {
      artist: rec.artists?.[0]?.name || null,
      title:  rec.title || null,
      album:  album,
      year:   year,
      score:  best.score
    };
  } catch(e){
    console.log('[acoustid] lookup failed:', e.message);
    return null;
  }
}

// Junk genre detection (used by harmonisation overwrite logic in main.js side)
const _JUNK_GENRES_MAIN = new Set([
  'music','musique','other','autre','unknown','inconnu','divers','various','misc','default',
  '12','13','255','-','—','n/a','none'
]);
function isJunkGenreMain(g){
  if(!g) return true;
  const n = String(g).trim().toLowerCase();
  return !n || _JUNK_GENRES_MAIN.has(n) || /^\d+$/.test(n);
}

// At startup, eagerly check fpcalc so the log shows availability state
setTimeout(() => { getFpcalcPath(); }, 500);

// ══════════════════════════════════════════════════════════

// ============================================================
// 1. FONCTIONS UTILITAIRES
// ============================================================

function loadScanCache() {
  try { return JSON.parse(fs.readFileSync(SCAN_CACHE, 'utf8')); } catch {}
  return null;
}

function saveScanCache(data) {
  setImmediate(() => {
    try {
      fs.mkdirSync(path.dirname(SCAN_CACHE), {recursive:true});
      fs.writeFileSync(SCAN_CACHE, JSON.stringify(data));
      console.log('[cache] saved', data.tracks?.length, 'tracks');
    } catch(e) { console.warn('[cache] save failed:', e.message); }
  });
}

function folderFingerprint(folder) {
  try {
    const stat = fs.statSync(folder);
    return `${folder}:${stat.mtimeMs}:${stat.size}`;
  } catch { return null; }
}

let _prefsCache = null;
function loadPrefs() {
  if (_prefsCache) return _prefsCache;
  try { _prefsCache = JSON.parse(fs.readFileSync(PREFS,'utf8')); return _prefsCache; } catch {}
  _prefsCache = { folder: null, itunesXml: null, customLists: [], onboardingDone: false, itunesImportedOnce: false, trackMeta: {}, customCovers: {} };
  return _prefsCache;
}

function savePrefs(p) {
  _prefsCache = p;
  fs.mkdirSync(path.dirname(PREFS),{recursive:true});
  fs.writeFileSync(PREFS, JSON.stringify(p,null,2));
}

// ============================================================
// 2. SCAN DU DOSSIER MUSIQUE
// ============================================================

async function scanAsync(folder) {
  const out = [];
  const dirs = [{ dir: folder, depth: 0 }];
  let count = 0;
  
  while (dirs.length) {
    const { dir, depth } = dirs.shift();
    if (depth > 8) continue;
    
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    
    for (const e of entries) {
      if (e.name[0] === '.') continue;
      const full = path.join(dir, e.name);
      
      if (e.isDirectory()) { 
        dirs.push({ dir: full, depth: depth + 1 }); 
        continue; 
      }
      
      const ext = path.extname(e.name).toLowerCase();
      if (!AUDIO.has(ext)) continue;
      
      try {
        const stat = fs.statSync(full);
        const rel = path.relative(folder, full).split(path.sep);
        const yearFromPath = rel.slice(0,-1).reverse().map(s=>s.match(/\b(19[2-9]\d|20[0-9]\d)\b/)?.[1]).find(Boolean);
        const genericFolderRe = /^(compilations?|various artists?|va|divers|soundtracks?)$/i;
        let guessedArtist = rel.length >= 3 ? rel[rel.length-3] : '';
        if(genericFolderRe.test(guessedArtist.trim())) guessedArtist = '';
        
        out.push({
          path: full,
          title: path.basename(e.name, ext).replace(/^\d+[\s._\-]+/, '').replace(/[-_]/g, ' ').trim(),
          album: rel.length >= 2 ? rel[rel.length-2] : '',
          artist: guessedArtist,
          genre: '',
          year: yearFromPath ? parseInt(yearFromPath, 10) : null,
          size: stat.size,
          sz: stat.size > 1048576 ? (stat.size/1048576).toFixed(1)+' MB' : (stat.size/1024).toFixed(0)+' KB',
        });
        
        if (++count % 500 === 0) await new Promise(r => setImmediate(r));
      } catch {}
    }
  }
  return out;
}

// ============================================================
// 3. PARSEUR iTunes XML
// ============================================================

function dx(s) {
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
          .replace(/&quot;/g,'"').replace(/&apos;/g,"'")
          .replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(+n));
}

function extractDict(xml, fromPos) {
  const start = xml.indexOf('<dict>', fromPos);
  if (start === -1) return null;
  let depth = 1, i = start + 6;
  while (i < xml.length && depth > 0) {
    if (xml.startsWith('<dict>', i))    { depth++; i += 6; }
    else if (xml.startsWith('</dict>', i)) { depth--; i += 7; }
    else i++;
  }
  return { content: xml.slice(start + 6, i - 7), end: i };
}

function extractArray(xml, fromPos) {
  const start = xml.indexOf('<array>', fromPos);
  if (start === -1) return null;
  let depth = 1, i = start + 7;
  while (i < xml.length && depth > 0) {
    if (xml.startsWith('<array>', i))    { depth++; i += 7; }
    else if (xml.startsWith('</array>', i)) { depth--; i += 8; }
    else i++;
  }
  return { content: xml.slice(start + 7, i - 8), end: i };
}

function getVal(block, key) {
  const m = block.match(new RegExp('<key>'+key+'<\\/key>\\s*<(?:string|integer)>([^<]*)<\\/(?:string|integer)>'));
  return m ? dx(m[1]) : null;
}

const SYS = new Set(['Library','Music','Downloaded','Recently Added','Recently Played',
  'Top 25 Most Played','Podcasts','Genius','iTunes DJ','Music Videos','Voice Memos','Audiobooks']);

function parseItunes(xmlPath) {
  console.log('[iTunes] Parsing:', xmlPath);
  const xml = fs.readFileSync(xmlPath, 'utf8');
  const tm = {};
  
  const tracksKey = xml.indexOf('<key>Tracks</key>');
  const playlistsKey = xml.indexOf('<key>Playlists</key>');
  if (tracksKey === -1 || playlistsKey === -1) return [];

  const tracksSection = extractDict(xml, tracksKey);
  if (!tracksSection) return [];

  let pos = 0;
  const td = tracksSection.content;
  while (pos < td.length) {
    const keyStart = td.indexOf('<key>', pos);
    if (keyStart === -1) break;
    const keyEnd = td.indexOf('</key>', keyStart);
    if (keyEnd === -1) break;
    const trackId = td.slice(keyStart + 5, keyEnd).trim();
    pos = keyEnd + 6;
    if (!/^\d+$/.test(trackId)) continue;

    const d = extractDict(td, pos);
    if (!d) break;
    pos = d.end;

    const title = getVal(d.content, 'Name');
    const artist = getVal(d.content, 'Artist');
    const albumArtist = getVal(d.content, 'Album Artist');
    const album = getVal(d.content, 'Album');
    const genre = getVal(d.content, 'Genre');
    const yearRaw = getVal(d.content, 'Year');
    const loc = getVal(d.content, 'Location');
    const kind = getVal(d.content, 'Kind') || '';

    // Patch M : extraction du flag favori et du rating iTunes
    // Rating va de 0 à 100 par tranches de 20 (donc 0, 20, 40, 60, 80, 100 = 0 à 5 étoiles)
    // Seuil favori : 4 étoiles ou plus (rating >= 80), OU le flag explicite "Loved"
    const isLoved = /<key>Loved<\/key>\s*<true\/>/.test(d.content);
    const ratingRaw = getVal(d.content, 'Rating');
    const rating = ratingRaw ? parseInt(ratingRaw, 10) || 0 : 0;
    const isFavorite = isLoved || rating >= 80;
    
    if (!title || !loc) continue;

    const genericArtistRe = /^(compilations?|various artists?|varios|va|divers)$/i;
    let finalArtist = artist || '';
    if(genericArtistRe.test(finalArtist.trim()) && albumArtist && !genericArtistRe.test(albumArtist.trim())){
      finalArtist = albumArtist;
    }
    if(!finalArtist && albumArtist) finalArtist = albumArtist;

    let fp = loc.replace(/^file:\/\//, '');
    try { fp = decodeURIComponent(fp); } catch { fp = fp.replace(/%20/g,' '); }

    const ext = path.extname(fp).toLowerCase();
    const isVideoKind = /movie|video|film|tv show|home video/i.test(kind);
    const isVideoExt = VIDEO.has(ext) && !AUDIO.has(ext);
    if (isVideoKind || (isVideoExt && !kind)) continue;

    tm[trackId] = {
      title,
      artist: finalArtist||'',
      album: album||'',
      genre: genre||'',
      year: yearRaw ? parseInt(yearRaw,10)||null : null,
      path: fp,
      // Patch M : favori iTunes (Loved OU rating >= 4 étoiles = 80)
      isFavorite,
      rating,  // 0-100, on garde la valeur brute pour info
    };
  }
  console.log(`[iTunes] Track map: ${Object.keys(tm).length} tracks`);

  const plArray = extractArray(xml, playlistsKey);
  if (!plArray) return [];

  const lists = [];
  let plPos = 0;
  const pa = plArray.content;

  while (plPos < pa.length) {
    const d = extractDict(pa, plPos);
    if (!d) break;
    plPos = d.end;
    const block = d.content;

    if (block.includes('<key>Master</key>') || block.includes('<key>Distinguished Kind</key>')) continue;
    const name = getVal(block, 'Name');
    if (!name || SYS.has(name)) continue;

    const itemsKeyPos = block.indexOf('<key>Playlist Items</key>');
    if (itemsKeyPos === -1) continue;
    const itemsArray = extractArray(block, itemsKeyPos);
    if (!itemsArray) continue;

    const trackIds = [...itemsArray.content.matchAll(/<key>Track ID<\/key>\s*<integer>(\d+)<\/integer>/g)].map(m => m[1]);
    const tracks = trackIds.map(id => tm[id]).filter(Boolean);
    if (tracks.length === 0) continue;
    
    lists.push({ name, tracks, count: tracks.length });
    console.log(`[iTunes] Playlist "${name}": ${tracks.length} tracks`);
  }

  console.log(`[iTunes] Total: ${lists.length} playlists`);
  return lists;
}

// ============================================================
// 4. FENÊTRE PRINCIPALE
// ============================================================

function createWin() {
  win = new BrowserWindow({
    width:1600, height:1000, minWidth:1440, minHeight:900,
    titleBarStyle:'hiddenInset',
    backgroundColor:'#0E0E0E',
    webPreferences: { preload: path.join(__dirname,'preload.js'), contextIsolation: true }
  });

  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
            "default-src 'self';" +
            "script-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com https://www.gstatic.com https://*.googleapis.com;" +
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;" +
            "font-src 'self' data: https://fonts.gstatic.com;" +
            "media-src * file: blob:;" +
            "img-src * data: file: blob: https://*.mzstatic.com https://*.apple.com;" +
            "connect-src 'self' https://itunes.apple.com https://api.spotify.com https://musicbrainz.org https://api.discogs.com https://en.wikipedia.org https://api.deezer.com https://coverartarchive.org https://*.archive.org https://www.theaudiodb.com https://theaudiodb.com https://ws.audioscrobbler.com https://www.last.fm https://api.acoustid.org https://*.googleapis.com https://*.firebaseio.com https://*.cloudfunctions.net wss://*.firebaseio.com https://firestore.googleapis.com https://identitytoolkit.googleapis.com;" +
            "frame-src 'self' https://*.firebaseapp.com;"
          ]
      }
    });
  });

  win.loadFile(path.join(__dirname,'..','app.html'));
  win.on('closed', () => { win=null; });
}

// ============================================================
// 5. GESTION DES GENRES (15 BUCKETS UNIVERSELLES)
// ============================================================

const GENRE_15_LIST = [
  'Blues, Roots & Gospel','Jazz & Swing','Soul, Funk & Disco','Classic Rock & Hard Rock',
  'Punk, Grunge & Alternative','Heavy Metal & Loud','Hip-Hop & Rap Culture','R&B, Pop & Dance',
  'Folk, Country & Americana','Ambient, New Age & Chill','Electronic, House & Techno','Reggae, Dub & Ska',
  'Latin, Caribbean, Flamenco, Tango','Afrobeat, African & World','Classical & Opera','Soundtrack & Score',
  'Chanson & Variété'
];

const GENRE_MAP_15 = {
  // ── 1. Blues, Roots & Gospel ──
  blues:'Blues, Roots & Gospel', 'delta blues':'Blues, Roots & Gospel', 'electric blues':'Blues, Roots & Gospel',
  'chicago blues':'Blues, Roots & Gospel', 'country blues':'Blues, Roots & Gospel', 'rhythm and blues':'Blues, Roots & Gospel',
  'blues rock':'Blues, Roots & Gospel', 'blues revival':'Blues, Roots & Gospel',
  gospel:'Blues, Roots & Gospel', 'black gospel':'Blues, Roots & Gospel', 'contemporary gospel':'Blues, Roots & Gospel',
  spirituals:'Blues, Roots & Gospel', 'negro spirituals':'Blues, Roots & Gospel', roots:'Blues, Roots & Gospel',
  'jug band':'Blues, Roots & Gospel', 'work song':'Blues, Roots & Gospel',

  // ── 2. Jazz & Swing ──
  jazz:'Jazz & Swing', bebop:'Jazz & Swing', 'be-bop':'Jazz & Swing',
  'hard bop':'Jazz & Swing', 'post-bop':'Jazz & Swing', 'cool jazz':'Jazz & Swing',
  'free jazz':'Jazz & Swing', 'avant-garde jazz':'Jazz & Swing', 'modal jazz':'Jazz & Swing',
  'jazz fusion':'Jazz & Swing', fusion:'Jazz & Swing', 'smooth jazz':'Jazz & Swing',
  'soul jazz':'Jazz & Swing', 'acid jazz':'Jazz & Swing', 'nu jazz':'Jazz & Swing',
  'big band':'Jazz & Swing', swing:'Jazz & Swing', 'vocal jazz':'Jazz & Swing',
  'jazz vocal':'Jazz & Swing', ragtime:'Jazz & Swing', dixieland:'Jazz & Swing',

  // ── 3. Soul, Funk & Disco ──
  soul:'Soul, Funk & Disco', 'northern soul':'Soul, Funk & Disco', 'southern soul':'Soul, Funk & Disco',
  'classic soul':'Soul, Funk & Disco', 'blue-eyed soul':'Soul, Funk & Disco',
  motown:'Soul, Funk & Disco', 'philly soul':'Soul, Funk & Disco',
  funk:'Soul, Funk & Disco', 'p-funk':'Soul, Funk & Disco', 'g-funk':'Soul, Funk & Disco',
  'funk rock':'Soul, Funk & Disco', 'jazz-funk':'Soul, Funk & Disco',
  disco:'Soul, Funk & Disco', 'nu-disco':'Soul, Funk & Disco', 'post-disco':'Soul, Funk & Disco',
  boogie:'Soul, Funk & Disco', groove:'Soul, Funk & Disco',
  'neo soul':'Soul, Funk & Disco', 'neo-soul':'Soul, Funk & Disco',

  // ── 4. Classic Rock & Hard Rock ──
  'classic rock':'Classic Rock & Hard Rock', 'hard rock':'Classic Rock & Hard Rock',
  'progressive rock':'Classic Rock & Hard Rock', 'prog rock':'Classic Rock & Hard Rock',
  'psychedelic rock':'Classic Rock & Hard Rock', psychedelia:'Classic Rock & Hard Rock',
  'arena rock':'Classic Rock & Hard Rock', 'glam rock':'Classic Rock & Hard Rock',
  'southern rock':'Classic Rock & Hard Rock', 'pub rock':'Classic Rock & Hard Rock',
  'rock and roll':'Classic Rock & Hard Rock', "rock 'n' roll":'Classic Rock & Hard Rock',
  rockabilly:'Classic Rock & Hard Rock', 'heartland rock':'Classic Rock & Hard Rock',
  'album rock':'Classic Rock & Hard Rock', 'stadium rock':'Classic Rock & Hard Rock',
  rock:'Classic Rock & Hard Rock',

  // ── 5. Punk, Grunge & Alternative ──
  punk:'Punk, Grunge & Alternative', 'punk rock':'Punk, Grunge & Alternative', 'post-punk':'Punk, Grunge & Alternative',
  'pop punk':'Punk, Grunge & Alternative', 'pop-punk':'Punk, Grunge & Alternative', 'hardcore punk':'Punk, Grunge & Alternative',
  'ska punk':'Punk, Grunge & Alternative', 'post-hardcore':'Punk, Grunge & Alternative',
  'new wave':'Punk, Grunge & Alternative', 'no wave':'Punk, Grunge & Alternative',
  grunge:'Punk, Grunge & Alternative', 'post-grunge':'Punk, Grunge & Alternative',
  indie:'Punk, Grunge & Alternative', 'indie rock':'Punk, Grunge & Alternative',
  alternative:'Punk, Grunge & Alternative', 'alternative rock':'Punk, Grunge & Alternative', 'alt rock':'Punk, Grunge & Alternative',
  'art rock':'Punk, Grunge & Alternative', 'post-rock':'Punk, Grunge & Alternative',
  shoegaze:'Punk, Grunge & Alternative', 'dream pop':'Punk, Grunge & Alternative',
  britpop:'Punk, Grunge & Alternative', 'math rock':'Punk, Grunge & Alternative',
  emo:'Punk, Grunge & Alternative', 'noise rock':'Punk, Grunge & Alternative',

  // ── 6. Heavy Metal & Loud ──
  'heavy metal':'Heavy Metal & Loud', 'death metal':'Heavy Metal & Loud', 'black metal':'Heavy Metal & Loud',
  'thrash metal':'Heavy Metal & Loud', 'doom metal':'Heavy Metal & Loud', 'power metal':'Heavy Metal & Loud',
  'speed metal':'Heavy Metal & Loud', 'symphonic metal':'Heavy Metal & Loud', 'folk metal':'Heavy Metal & Loud',
  'progressive metal':'Heavy Metal & Loud', 'prog metal':'Heavy Metal & Loud',
  metalcore:'Heavy Metal & Loud', deathcore:'Heavy Metal & Loud', 'nu metal':'Heavy Metal & Loud',
  djent:'Heavy Metal & Loud', 'stoner metal':'Heavy Metal & Loud', 'sludge metal':'Heavy Metal & Loud',
  hardcore:'Heavy Metal & Loud', 'melodic death metal':'Heavy Metal & Loud', 'groove metal':'Heavy Metal & Loud',
  doom:'Heavy Metal & Loud', stoner:'Heavy Metal & Loud', thrash:'Heavy Metal & Loud',
  metal:'Heavy Metal & Loud',

  // ── 7. Hip-Hop & Rap ──
  'hip hop':'Hip-Hop & Rap Culture', 'hip-hop':'Hip-Hop & Rap Culture',
  rap:'Hip-Hop & Rap Culture', 'gangsta rap':'Hip-Hop & Rap Culture',
  trap:'Hip-Hop & Rap Culture', 'cloud rap':'Hip-Hop & Rap Culture', drill:'Hip-Hop & Rap Culture',
  grime:'Hip-Hop & Rap Culture', 'boom bap':'Hip-Hop & Rap Culture',
  'old school hip hop':'Hip-Hop & Rap Culture', 'golden age hip hop':'Hip-Hop & Rap Culture',
  'east coast hip hop':'Hip-Hop & Rap Culture', 'west coast hip hop':'Hip-Hop & Rap Culture',
  'southern hip hop':'Hip-Hop & Rap Culture', 'conscious hip hop':'Hip-Hop & Rap Culture',
  'alternative hip hop':'Hip-Hop & Rap Culture', 'underground hip hop':'Hip-Hop & Rap Culture',
  'rap français':'Hip-Hop & Rap Culture', 'french rap':'Hip-Hop & Rap Culture',

  // ── 8. R&B, Pop & Dance ──
  'r&b':'R&B, Pop & Dance', 'rhythm & blues':'R&B, Pop & Dance',
  'contemporary r&b':'R&B, Pop & Dance', 'alternative r&b':'R&B, Pop & Dance',
  'urban contemporary':'R&B, Pop & Dance', 'quiet storm':'R&B, Pop & Dance',
  pop:'R&B, Pop & Dance', 'dance pop':'R&B, Pop & Dance', electropop:'R&B, Pop & Dance',
  'teen pop':'R&B, Pop & Dance', 'power pop':'R&B, Pop & Dance', 'art pop':'R&B, Pop & Dance',
  'synth pop':'R&B, Pop & Dance', 'synth-pop':'R&B, Pop & Dance', synthpop:'R&B, Pop & Dance',
  hyperpop:'R&B, Pop & Dance', 'bedroom pop':'R&B, Pop & Dance', 'indie pop':'R&B, Pop & Dance',
  'chamber pop':'R&B, Pop & Dance', 'k-pop':'R&B, Pop & Dance', 'j-pop':'R&B, Pop & Dance',
  'adult contemporary':'R&B, Pop & Dance', 'new jack swing':'R&B, Pop & Dance',

  // ── 9. Folk, Country & Americana ──
  folk:'Folk, Country & Americana', 'folk rock':'Folk, Country & Americana', 'contemporary folk':'Folk, Country & Americana',
  'traditional folk':'Folk, Country & Americana', 'neo-folk':'Folk, Country & Americana', 'freak folk':'Folk, Country & Americana',
  'indie folk':'Folk, Country & Americana', 'anti-folk':'Folk, Country & Americana',
  country:'Folk, Country & Americana', 'alt-country':'Folk, Country & Americana', 'alternative country':'Folk, Country & Americana',
  'country rock':'Folk, Country & Americana', 'country pop':'Folk, Country & Americana',
  'outlaw country':'Folk, Country & Americana', 'honky tonk':'Folk, Country & Americana', 'honky-tonk':'Folk, Country & Americana',
  bluegrass:'Folk, Country & Americana', newgrass:'Folk, Country & Americana',
  americana:'Folk, Country & Americana', appalachian:'Folk, Country & Americana',
  'singer-songwriter':'Folk, Country & Americana', 'singer songwriter':'Folk, Country & Americana',
  acoustic:'Folk, Country & Americana', cowboy:'Folk, Country & Americana',

  // ── 10. Ambient, New Age & Chill ──
  ambient:'Ambient, New Age & Chill', 'dark ambient':'Ambient, New Age & Chill', 'ambient techno':'Ambient, New Age & Chill',
  'new age':'Ambient, New Age & Chill', 'new-age':'Ambient, New Age & Chill',
  chill:'Ambient, New Age & Chill', chillout:'Ambient, New Age & Chill', 'chill-out':'Ambient, New Age & Chill',
  'lo-fi':'Ambient, New Age & Chill', lofi:'Ambient, New Age & Chill',
  downtempo:'Ambient, New Age & Chill', 'trip hop':'Ambient, New Age & Chill', 'trip-hop':'Ambient, New Age & Chill',
  chillwave:'Ambient, New Age & Chill',
  meditation:'Ambient, New Age & Chill', drone:'Ambient, New Age & Chill',

  // ── 11. Electronic, House & Techno ──
  electronic:'Electronic, House & Techno', 'electronic music':'Electronic, House & Techno', electronica:'Electronic, House & Techno',
  techno:'Electronic, House & Techno', 'minimal techno':'Electronic, House & Techno', 'melodic techno':'Electronic, House & Techno',
  'detroit techno':'Electronic, House & Techno', 'acid techno':'Electronic, House & Techno',
  house:'Electronic, House & Techno', 'deep house':'Electronic, House & Techno', 'tech house':'Electronic, House & Techno',
  'progressive house':'Electronic, House & Techno', 'afro house':'Electronic, House & Techno',
  'melodic house':'Electronic, House & Techno', 'acid house':'Electronic, House & Techno', 'electro house':'Electronic, House & Techno',
  edm:'Electronic, House & Techno', 'dance music':'Electronic, House & Techno',
  idm:'Electronic, House & Techno', 'intelligent dance music':'Electronic, House & Techno',
  'drum and bass':'Electronic, House & Techno', 'drum & bass':'Electronic, House & Techno', dnb:'Electronic, House & Techno',
  dubstep:'Electronic, House & Techno', 'future bass':'Electronic, House & Techno', trance:'Electronic, House & Techno',
  psytrance:'Electronic, House & Techno', 'big beat':'Electronic, House & Techno', breakbeat:'Electronic, House & Techno',
  club:'Electronic, House & Techno', synthwave:'Electronic, House & Techno', 'synth wave':'Electronic, House & Techno',
  darksynth:'Electronic, House & Techno', vaporwave:'Electronic, House & Techno', retrowave:'Electronic, House & Techno',
  'italo disco':'Electronic, House & Techno', 'future pop':'Electronic, House & Techno',

  // ── 12. Reggae, Dub & Ska ──
  reggae:'Reggae, Dub & Ska', 'roots reggae':'Reggae, Dub & Ska', 'reggae fusion':'Reggae, Dub & Ska',
  'lovers rock':'Reggae, Dub & Ska',
  dub:'Reggae, Dub & Ska', 'dub music':'Reggae, Dub & Ska', 'dub reggae':'Reggae, Dub & Ska',
  ska:'Reggae, Dub & Ska', 'two tone':'Reggae, Dub & Ska', '2 tone':'Reggae, Dub & Ska',
  rocksteady:'Reggae, Dub & Ska',
  dancehall:'Reggae, Dub & Ska', ragga:'Reggae, Dub & Ska',

  // ── 13. Latin, Caribbean, Flamenco, Tango ──
  latin:'Latin, Caribbean, Flamenco, Tango', 'latin pop':'Latin, Caribbean, Flamenco, Tango', 'latin rock':'Latin, Caribbean, Flamenco, Tango',
  salsa:'Latin, Caribbean, Flamenco, Tango', reggaeton:'Latin, Caribbean, Flamenco, Tango', bachata:'Latin, Caribbean, Flamenco, Tango',
  merengue:'Latin, Caribbean, Flamenco, Tango', cumbia:'Latin, Caribbean, Flamenco, Tango', 'latin jazz':'Latin, Caribbean, Flamenco, Tango',
  'latin trap':'Latin, Caribbean, Flamenco, Tango', 'latin alternative':'Latin, Caribbean, Flamenco, Tango',
  tango:'Latin, Caribbean, Flamenco, Tango', bolero:'Latin, Caribbean, Flamenco, Tango', mariachi:'Latin, Caribbean, Flamenco, Tango',
  ranchera:'Latin, Caribbean, Flamenco, Tango', banda:'Latin, Caribbean, Flamenco, Tango', corridos:'Latin, Caribbean, Flamenco, Tango',
  samba:'Latin, Caribbean, Flamenco, Tango', 'bossa nova':'Latin, Caribbean, Flamenco, Tango', bossa:'Latin, Caribbean, Flamenco, Tango',
  mpb:'Latin, Caribbean, Flamenco, Tango', tropicalia:'Latin, Caribbean, Flamenco, Tango', 'tropicália':'Latin, Caribbean, Flamenco, Tango',
  forro:'Latin, Caribbean, Flamenco, Tango', 'forró':'Latin, Caribbean, Flamenco, Tango',
  calypso:'Latin, Caribbean, Flamenco, Tango', soca:'Latin, Caribbean, Flamenco, Tango', zouk:'Latin, Caribbean, Flamenco, Tango',
  kizomba:'Latin, Caribbean, Flamenco, Tango', compas:'Latin, Caribbean, Flamenco, Tango',

  // ── 14. Afrobeat, African & World ──
  afrobeat:'Afrobeat, African & World', afrobeats:'Afrobeat, African & World', afropop:'Afrobeat, African & World',
  'afro-pop':'Afrobeat, African & World', 'afro-fusion':'Afrobeat, African & World', afroswing:'Afrobeat, African & World',
  highlife:'Afrobeat, African & World', juju:'Afrobeat, African & World',
  'ethio-jazz':'Afrobeat, African & World', 'ethiopian jazz':'Afrobeat, African & World',
  mbaqanga:'Afrobeat, African & World', soukous:'Afrobeat, African & World', benga:'Afrobeat, African & World',
  amapiano:'Afrobeat, African & World', gqom:'Afrobeat, African & World', kwaito:'Afrobeat, African & World',
  world:'Afrobeat, African & World', 'world music':'Afrobeat, African & World', worldbeat:'Afrobeat, African & World',
  traditional:'Afrobeat, African & World', ethnic:'Afrobeat, African & World',
  celtic:'Afrobeat, African & World', flamenco:'Afrobeat, African & World',
  'middle eastern':'Afrobeat, African & World', arabic:'Afrobeat, African & World', 'raï':'Afrobeat, African & World',
  'indian classical':'Afrobeat, African & World', bollywood:'Afrobeat, African & World', bhangra:'Afrobeat, African & World',
  gnawa:'Afrobeat, African & World', mbalax:'Afrobeat, African & World',

  // ── 15. Classical & Opera ──
  classical:'Classical & Opera', 'classical music':'Classical & Opera',
  'neo-classical':'Classical & Opera', neoclassical:'Classical & Opera',
  'modern classical':'Classical & Opera', 'contemporary classical':'Classical & Opera',
  'early music':'Classical & Opera', medieval:'Classical & Opera', renaissance:'Classical & Opera',
  baroque:'Classical & Opera', romantic:'Classical & Opera',
  'chamber music':'Classical & Opera', orchestral:'Classical & Opera', symphony:'Classical & Opera',
  symphonic:'Classical & Opera', concerto:'Classical & Opera', sonata:'Classical & Opera',
  opera:'Classical & Opera', operetta:'Classical & Opera',
  choral:'Classical & Opera', piano:'Classical & Opera',
  instrumental:'Classical & Opera',
  // alias de migration : ancien bucket fusionné → nouveau parent classique
  'classical, opera & score':'Classical & Opera',

  // ── 16. Soundtrack & Score ──
  soundtrack:'Soundtrack & Score', 'film score':'Soundtrack & Score', score:'Soundtrack & Score',
  cinematic:'Soundtrack & Score', 'film music':'Soundtrack & Score',
  'game music':'Soundtrack & Score', 'video game music':'Soundtrack & Score', vgm:'Soundtrack & Score',
  'original soundtrack':'Soundtrack & Score', ost:'Soundtrack & Score', 'epic music':'Soundtrack & Score',

  // ── 17. Chanson & Variété ──
  chanson:'Chanson & Variété',
  'chanson française':'Chanson & Variété', 'chanson francaise':'Chanson & Variété',
  'chanson à texte':'Chanson & Variété', 'chanson a texte':'Chanson & Variété',
  'chanson réaliste':'Chanson & Variété', 'chanson realiste':'Chanson & Variété',
  'nouvelle chanson française':'Chanson & Variété', 'nouvelle chanson francaise':'Chanson & Variété',
  'variété française':'Chanson & Variété', 'variete francaise':'Chanson & Variété',
  'variété':'Chanson & Variété', 'variete':'Chanson & Variété',
  'french pop':'Chanson & Variété', 'french chanson':'Chanson & Variété',
  'yé-yé':'Chanson & Variété', 'ye-ye':'Chanson & Variété', yeye:'Chanson & Variété',
  musette:'Chanson & Variété', 'bal-musette':'Chanson & Variété'
};

// ── Normalisation des genres bruts (accents + casse + ponctuation) ──────────
function _normGenre(s){
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function _deplural(s){
  return s.split(' ').map(w => w.length > 3 ? w.replace(/s$/, '') : w).join(' ');
}
const _GM15_NORM = (() => { const o = {}; for (const k in GENRE_MAP_15) { const nk = _normGenre(k); if (nk) o[nk] = GENRE_MAP_15[k]; } return o; })();

function mapToGenre15(raw) {
  if (!raw) return null;
  if (GENRE_15_LIST.includes(raw)) return raw;
  const r = _normGenre(raw);
  if (!r) return null;
  if (_GM15_NORM[r]) return _GM15_NORM[r];
  const keys = Object.keys(_GM15_NORM).sort((a,b) => b.length - a.length);
  for (const key of keys) {
    if (key.length <= 3) continue;
    const rgx = new RegExp('(^|[^a-z0-9])' + key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '([^a-z0-9]|$)', 'i');
    if (rgx.test(r)) return _GM15_NORM[key];
  }
  const rp = _deplural(r);
  if (rp !== r && _GM15_NORM[rp]) return _GM15_NORM[rp];
  return null;
}

// ============================================================
// 6. REQUÊTES HTTP
// ============================================================

const https = require('https');

function httpsGet(url, _retry = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'WaveTune/3.0 (music-player; contact@wavetune.app)', 'Accept': 'application/json' },
      timeout: 8000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpsGet(res.headers.location, _retry).then(resolve).catch(reject);
        res.resume(); return;
      }
      // Retry transient server errors (429 rate-limit, 503 unavailable) twice with backoff.
      if ((res.statusCode === 429 || res.statusCode === 503) && _retry < 2) {
        res.resume();
        const wait = (_retry + 1) * 1500; // 1.5s then 3s
        setTimeout(() => httpsGet(url, _retry + 1).then(resolve).catch(reject), wait);
        return;
      }
      if (res.statusCode >= 400) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const ct = res.headers['content-type'] || '';
      if (!ct.includes('json') && !ct.includes('javascript')) {
        res.resume();
        reject(new Error(`Non-JSON response`));
        return;
      }
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── META CACHE (mémoire + disque) ───────────────────────────────
// Cache session (Map) + persistance disque. Bumpe META_CACHE_VERSION quand la
// logique d'inférence change significativement pour invalider les anciennes
// entrées (= fausses années issues des anciennes logiques).
const _metaCache = new Map(); // "artist||album" → {genre, year}
const META_CACHE_FILE = path.join(os.homedir(), '.wavetune', 'meta-cache.json');
const META_CACHE_TTL = 30 * 24 * 3600 * 1000; // 30 jours
const META_CACHE_VERSION = 12;  // bump : repli pochette Wikipédia (FR/EN) ajouté. Réinvalide les albums cachés « sans pochette » en v11.

function _loadMetaCacheFromDisk() {
  try {
    const raw = JSON.parse(fs.readFileSync(META_CACHE_FILE, 'utf8'));
    const version = raw?._version || 1;
    const entries = raw?.entries || {};
    if (version !== META_CACHE_VERSION) {
      console.log(`[meta-cache] version mismatch (disk=${version}, code=${META_CACHE_VERSION}) — flushing`);
      return;
    }
    const now = Date.now();
    let loaded = 0, expired = 0;
    for (const [k, v] of Object.entries(entries)) {
      if (!v || typeof v !== 'object') continue;
      if (v.ts && (now - v.ts) > META_CACHE_TTL) { expired++; continue; }
      _metaCache.set(k, {
        genre: v.genre || null,
        year:  v.year  || null,
        yearTrusted:  !!v.yearTrusted,
        genreTrusted: !!v.genreTrusted,
        rawByField: v.rawByField || null   // restaure artiste consolidé + POCHETTES
      });
      loaded++;
    }
    console.log(`[meta-cache] loaded ${loaded} entries, ${expired} expired`);
  } catch { /* no cache yet */ }
}
_loadMetaCacheFromDisk();

let _cachePersistTimer = null;
function _schedulePersistCache() {
  if (_cachePersistTimer) return;
  _cachePersistTimer = setTimeout(() => {
    _cachePersistTimer = null;
    try {
      fs.mkdirSync(path.dirname(META_CACHE_FILE), { recursive: true });
      const now = Date.now();
      const entries = {};
      for (const [k, v] of _metaCache.entries()) {
        if (!v || (!v.genre && !v.year && !v.rawByField)) continue;
        entries[k] = {
          genre: v.genre || null,
          year:  v.year  || null,
          yearTrusted:  !!v.yearTrusted,
          genreTrusted: !!v.genreTrusted,
          // Persiste rawByField (artiste consolidé + POCHETTES iTunes/Deezer)
          // pour qu'ils survivent au redémarrage. Sans ça, un hit de cache après
          // relance renvoyait genre/année seuls → plus aucune pochette ni artiste.
          rawByField: v.rawByField || null,
          ts: now
        };
      }
      fs.writeFileSync(META_CACHE_FILE, JSON.stringify({ _version: META_CACHE_VERSION, entries }));
    } catch (e) { console.warn('[meta-cache] persist failed:', e.message); }
  }, 15000); // flush every 15s
}

// ============================================================
// 7. SOURCES POUR MÉTADONNÉES (CROSS-REFERENCE)
// ============================================================

// ── Title-matching helpers ──
// Les API retournent souvent le "bon artiste, mauvais album". On normalise les
// titres (accents, ponctuation, "Remastered / Deluxe / Edition / Vol. 2") pour
// ne garder que les résultats dont le titre matche réellement.
function _normTitle(s) {
  let t = (s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Si TOUT le titre est entre crochets (ex. "[Led Zeppelin IV]" — convention
  // MusicBrainz pour un album sans titre officiel), on retire juste les crochets
  // SANS supprimer le contenu (sinon le titre deviendrait vide → match raté).
  const fullyBracketed = /^\s*\[[^\]]+\]\s*$/.test(t);
  if (fullyBracketed) {
    t = t.replace(/^\s*\[|\]\s*$/g, '');
  } else {
    t = t.replace(/\([^)]*\)/g, ' ')   // "(remastered 2009)"
         .replace(/\[[^\]]*\]/g, ' '); // "[disc 1]"
  }
  return t
    .replace(/\b(remaster(ed)?|deluxe|expanded|anniversary|edition|mono|stereo|live|ep|single|original soundtrack|ost|bonus|special|collector'?s?|digital)\b/g, ' ')
    .replace(/\b(vol\.?|volume|part|pt\.?|disc|cd)\s*\d+\b/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function titleMatches(candidate, queried) {
  const a = _normTitle(candidate);
  const b = _normTitle(queried);
  if (!a || !b) return false;
  if (a === b) return true;
  if (b.length >= 4 && a.includes(b)) return true;
  if (a.length >= 4 && b.includes(a)) return true;
  return false;
}
// Best-of / anthology titles : date non-fiable (= date de la compilation,
// pas de l'œuvre originale).
function looksLikeCompilation(title) {
  const t = (title || '').toLowerCase();
  return /\b(best of|greatest hits|anthology|collection|the essential|the very best|compilation|retrospective)\b/.test(t);
}

// Année valide (1600 — année courante).
function _parseYearStrict(s) {
  const m = (s || '').match(/^(1[6-9]\d{2}|20\d{2})/);
  if (!m) return null;
  const y = parseInt(m[1]);
  const currentYear = new Date().getFullYear();
  return (y >= 1600 && y <= currentYear) ? y : null;
}

// 7a. MusicBrainz (années originales + tags)
//     Requête Lucene structurée (release:"..." AND artist:"...") beaucoup plus
//     précise que "terms en vrac". On filtre ensuite par titre matché pour ne
//     garder que le bon release-group, puis on prend SON first-release-date.
//     Retourne aussi `trusted` = true quand le match est solide.
// Recherche par ENREGISTREMENT sur MusicBrainz (source libre canonique, celle
// qui alimente une bonne partie des résultats Google). Renvoie l'artiste réel +
// l'année d'ORIGINE (first-release-date) d'un MORCEAU, indépendamment de l'album
// — crucial pour compils/B.O. où l'album ne dit rien de la piste. Tolère les
// fautes de frappe via la recherche floue Lucene (pretend~ ≈ pretender), puis
// filtre sur la ressemblance du titre (anti-faux-positif) et privilégie l'année
// la plus ancienne (l'original prime sur les reprises/rééditions).
// Normalisation de titre commune (accents/ponctuation retirés).
function _normRecTitle(s) { return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, ''); }

// Score de ressemblance de titre : 2 = exact, 1 = inclusion avec garde de
// longueur (le + court ≥60% du + long ET ≥5 car.), 0 = trop différent.
function _titleScore(rn, tn) {
  if (rn === tn) return 2;
  const _minL = Math.min(rn.length, tn.length), _maxL = Math.max(rn.length, tn.length) || 1;
  if ((rn.includes(tn) || tn.includes(rn)) && _minL >= 5 && _minL >= _maxL * 0.6) return 1;
  return 0;
}

// Candidats par TITRE via iTunes (entity=song), depuis le main (User-Agent OK →
// pas de 403). Apple trie par POPULARITÉ (comme Google) et tolère les typos →
// ramène les versions canoniques que MusicBrainz enterre. Donne aussi la pochette.
async function _recordingCandidatesItunes(title, artist) {
  if (!title) return [];
  try {
    const term = [artist, title].filter(Boolean).join(' ');
    const data = await httpsGet(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&limit=15`);
    const results = data?.results || [];
    const tn = _normRecTitle(title);
    const out = [];
    let rank = 0;
    for (const it of results) {
      const ts = _titleScore(_normRecTitle(it.trackName), tn);
      if (ts) {
        const yr = it.releaseDate ? parseInt(it.releaseDate.split('-')[0]) : null;
       out.push({
          titleScore: ts, year: yr, artist: it.artistName || null, title: it.trackName || null,
          album: it.collectionName || null, genre: it.primaryGenreName || null,
          cover: it.artworkUrl100 ? it.artworkUrl100.replace('100x100bb', '600x600bb') : null,
          source: 'iTunes', pop: rank   // rang Apple = proxy de popularité (0 = + populaire)
        });
      }
      rank++;
    }
    return out;
  } catch (e) { return []; }
}

// Tracklist ORDONNÉE d'un album via iTunes (search album → collectionId → lookup
// entity=song). Sert à proposer les titres dans l'éditeur quand le titre manque.
// Best-effort : renvoie [] si rien. Réutilise httpsGet + titleMatches existants.
async function fetchAlbumTracklistItunes(artist, album) {
  if (!album) return [];
  try {
    const term = [artist, album].filter(Boolean).join(' ');
    const s = await httpsGet(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=album&limit=5`);
    const albums = (s && s.results || []).filter(a => a.collectionId);
    if (!albums.length) return [];
    const pick = albums.find(a => titleMatches(a.collectionName || '', album)) || albums[0];
    const look = await httpsGet(`https://itunes.apple.com/lookup?id=${pick.collectionId}&entity=song&limit=200`);
    const songs = (look && look.results || []).filter(r => r.wrapperType === 'track' && r.trackName);
    if (!songs.length) return [];
    songs.sort((a, b) => (a.discNumber || 1) - (b.discNumber || 1) || (a.trackNumber || 0) - (b.trackNumber || 0));
    const multiDisc = songs.some(r => (r.discNumber || 1) > 1);
    return {
      album: pick.collectionName || album,
      artist: pick.artistName || artist || null,
      tracks: songs.map(r => ({ n: r.trackNumber || null, disc: multiDisc ? (r.discNumber || 1) : null, title: r.trackName })),
    };
  } catch (_) { return []; }
}

ipcMain.handle('fetch-album-tracklist', async (_evt, payload) => {
  const { artist, album } = payload || {};
  return await fetchAlbumTracklistItunes(artist || '', album || '');
});

// Candidats par ENREGISTREMENT via MusicBrainz : couverture + date de 1re sortie
// précise. Requête ciblée (termes significatifs requis, flou sur les longs).
async function _recordingCandidatesMB(title, artist) {
  if (!title || title.length < 2) return [];
  try {
    const clean = String(title).replace(/["()\[\]]/g, ' ').replace(/\s{2,}/g, ' ').trim();
    const terms = clean.split(/\s+/).filter(w => w.length >= 2);
    if (!terms.length) return [];
    const sig = terms.filter(w => w.length >= 4);
    const useTerms = sig.length ? sig : terms;
    let q = `recording:(${useTerms.map(w => w.length >= 6 ? `+${w}~` : `+${w}`).join(' ')})`;
    if (artist && artist.length >= 2 && !/various|soundtrack|compilation|bande originale/i.test(artist)) {
      const aClean = String(artist).replace(/["()\[\]]/g, ' ').trim();
      if (aClean) q += ` AND artist:(${aClean})`;
    }
    const data = await httpsGet(`https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(q)}&fmt=json&limit=25`);
    const recs = data?.recordings || [];
    const tn = _normRecTitle(title);
    const out = [];
    for (const r of recs) {
      const ts = _titleScore(_normRecTitle(r.title), tn);
      if (!ts) continue;
      const frd = r['first-release-date'] || '';
      const yr = frd ? parseInt(frd.split('-')[0]) : null;
      const ac = (r['artist-credit'] || []).map(c => (c.name || c.artist?.name || '')).filter(Boolean).join(', ');
      out.push({ titleScore: ts, year: yr, artist: ac || null, title: r.title || null, album: (r.releases || [])[0]?.title || null, genre: null, cover: null, source: 'MB', pop: 99 });
    }
    return out;
  } catch (e) { return []; }
}

// Choix final parmi les candidats iTunes + MB, par SCORE PONDÉRÉ (pas un tri
// lexicographique). Indispensable car un titre fichier avec typo ("The Great
// Pretend") matche EXACTEMENT des obscurs homonymes (titleScore 2) alors que la
// vraie version ("...Pretender") n'est qu'une inclusion (titleScore 1). On
// combine donc : ressemblance de titre + POPULARITÉ (rang Apple, comme Google) +
// PROXIMITÉ à l'indice d'année (l'original d'une compil ≈ l'année de la compil)
// + léger bonus à l'ancienneté (l'original prime).
function _pickRecording(title, cands, yearHint, artistHint) {
  if (!cands.length) return null;
  const _h = (yearHint && yearHint > 1000) ? yearHint : null;
  // Artiste du fichier (s'il est fiable, pas "Various/soundtrack") → on PRIVILÉGIE
  // fortement les enregistrements de cet artiste. Corrige les fausses identifs type
  // Iron Maiden → reprise "Popscotch" : le tag "Iron Maiden" ramène l'original.
  const _ah = (artistHint && artistHint.length >= 2 && !/various|soundtrack|compilation|bande originale/i.test(artistHint))
    ? artistHint.toLowerCase() : null;
  for (const c of cands) {
    let s = (c.titleScore || 0) * 10;                       // titre : exact 20, inclusion 10
    s += Math.max(0, 16 - (c.pop == null ? 99 : c.pop));    // popularité iTunes (rang 0 → +16 ; MB → 0)
    if (_h && c.year) s += Math.max(0, 22 - Math.min(22, Math.abs(c.year - _h))); // proximité indice
    if (_ah && c.artist && c.artist.toLowerCase().includes(_ah)) s += 25;          // artiste du fichier prime
    if (c.year) s += Math.max(0, 2025 - c.year) / 500;      // ancienneté (départage fin)
    // A — On veut l'année de l'ENREGISTREMENT ORIGINAL (ex. 1968), pas celle d'une
    // compil/best-of (ex. 1991). On pénalise donc les candidats dont l'ALBUM est une
    // compil. Équilibré par le bonus artiste (+25) ; si SEULES des compils existent,
    // elles sont toutes pénalisées pareil → la plus pertinente gagne quand même.
    if (c.album && /greatest hits|best of|the very best|anthology|the essential|definitive|\bcollection\b|compilation/i.test(c.album)) s -= 18;
    c._s = s;
  }
  cands.sort((a, b) => b._s - a._s);
  const top = cands[0];
  if (!top.artist && !top.year) return null;
  return { artist: top.artist, year: top.year, album: top.album, title: top.title || null, genre: top.genre || null, cover: top.cover || null, score: 60 + (top.titleScore || 0) * 20 };
}

// Année d'ORIGINE : parmi les candidats dont le titre matche EXACTEMENT (score 2,
// pas les remixes/live « (…) ») et dont l'artiste recoupe l'artiste retenu, on
// prend la 1re sortie la PLUS ANCIENNE plausible. Philosophie produit : la date
// d'origine prime sur les rééditions/reprises. Ex. « Respect » retenu via la
// version Blues Brothers 2000 (1998) → l'enregistrement Aretha Franklin (1967)
// recoupe le crédit « The Blues Brothers & Aretha Franklin » → 1967.
// Renvoie { year, artist } si une année plus ancienne est trouvée, sinon null.
function _oldestPlausibleRecYear(cands, pickedArtist, pickedYear) {
  if (!Array.isArray(cands) || !cands.length || !pickedArtist || !pickedYear) return null;
  const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const pa = norm(pickedArtist);
  if (!pa) return null;
  const paWords = new Set(pa.split(/[\s,&._-]+/).filter(w => w.length >= 4));
  const overlap = (b) => {
    b = norm(b);
    if (!b) return false;
    if (b === pa || b.includes(pa) || pa.includes(b)) return true;
    for (const w of b.split(/[\s,&._-]+/)) if (w.length >= 4 && paWords.has(w)) return true;
    return false;
  };
  const maxY = new Date().getFullYear() + 1;
  let best = null;
  for (const c of cands) {
    if (!c || !c.year || c.titleScore !== 2) continue;
    if (c.year < 1900 || c.year > maxY) continue;
    if (!overlap(c.artist)) continue;
    if (!best || c.year < best.year) best = { year: c.year, artist: c.artist || null };
  }
  return (best && best.year < pickedYear) ? best : null;
}

// C206 : crédit artiste d'une entité MusicBrainz (« Sonny Terry & Brownie McGhee »).
// Reconstitue le crédit complet en respectant les joinphrase (« & », « feat. »…).
function _mbCredit(entity) {
  const ac = entity && entity['artist-credit'];
  if (!Array.isArray(ac) || !ac.length) return '';
  return ac.map(c => String(c.name || (c.artist && c.artist.name) || '') + String(c.joinphrase || '')).join('').trim();
}

// Nettoie un nom d'album pour la recherche (retire [Disc 1], (Deluxe Edition), etc.) 
// C193 : si l'album est ENTIÈREMENT entre crochets, on déballe au lieu
// d'effacer — sinon « [The House That Dirt Built] » devenait une chaîne
// vide et l'ancrage tracklist abandonnait (return null) avant de chercher.
function _cleanAlbumQuery(album) {
  let s = String(album || '');
  const _fb = s.match(/^\s*\[(.+)\]\s*$/s);
  if (_fb && _fb[1].trim()) s = _fb[1].trim();
  // C199 : marqueur de disque physique en fin de nom (« … Cd 2 ») — voir
  // normalizeAlbumName, même règle.
  s = s.replace(/\s*[-–—:]?\s*\b(cd|disc|disk|disque)\s*[-.]?\s*\d+\b\s*$/i, '');
  return s.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

// ANCRAGE PAR TRACKLIST (la vraie solution aux compils/B.O.) : au lieu de chercher
// le TITRE dans tout MusicBrainz — qui ramène homonymes et reprises (« Panamericana »
// par El Klan, « Can I Play With Madness » par Popscotch) —, on cherche l'ALBUM en
// tant que RELEASE, on récupère sa tracklist avec les crédits + dates PAR PISTE, et
// on retrouve LA piste par son titre DANS cette release. Déterministe : une release
// a rarement deux pistes de même titre. Gratuit, CC0, sans clé (comme la fiche Discogs).
//   « Calle 54 » → piste « Panamericana » = Paquito D'Rivera
//   « Best Of The Beast » → piste « Can I Play With Madness » = Iron Maiden / 1988
// Renvoie { artist, year, title, album:null, cover:null, genre:null, score } ou null.
// album:null = signal « garder l'album du fichier » (on ne disperse pas une B.O.).
async function _releaseTracklistAnchor(album, title, artistHint, opts = {}) {
  const _alb = _cleanAlbumQuery(album);
  if (!_alb || !title) return null;
  const tnWanted = _normRecTitle(title);
  if (!tnWanted) return null;
  try {
    // 1. Chercher des releases candidates par nom d'album (+ artiste si fiable).
    let q = `release:(${_alb.replace(/[":()\[\]]/g, ' ').trim()})`;
    if (artistHint && artistHint.length >= 2 && !/various|soundtrack|compilation|bande originale/i.test(artistHint)) {
      const aq = String(artistHint).replace(/[":()\[\]]/g, ' ').trim();
      if (aq) q += ` AND artist:(${aq})`;
    }
    const sr = await httpsGet(`https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(q)}&fmt=json&limit=8`);
    const releases = sr?.releases || [];
    if (!releases.length) return null;

    // 2. Pour les meilleures releases (triées par pertinence MB), fetch la tracklist
    //    complète et chercher la piste par titre. Stop à la 1re bonne correspondance.
    let best = null, bestSc = -1;
    const seen = new Set();
    for (const rel of releases.slice(0, 5)) {
      if (!rel.id || seen.has(rel.id)) continue;
      seen.add(rel.id);
      await new Promise(r => setTimeout(r, 1100)); // MusicBrainz : 1 req/s
      let det;
      try {
        det = await httpsGet(`https://musicbrainz.org/ws/2/release/${rel.id}?fmt=json&inc=recordings+artist-credits+release-groups`);
      } catch (e) { continue; }
      const media = det?.media || [];
      const rgDate = det['release-group']?.['first-release-date'] || rel['release-group']?.['first-release-date'] || '';
      const rgYear = rgDate ? parseInt(rgDate.split('-')[0]) : null;
      // Le groupe est-il une compil/best-of/live ? Si oui, son année est celle de
      // la compilation (fausse) → on ne s'en sert PAS comme repli d'année.
      const _rgSec = det['release-group']?.['secondary-types'] || rel['release-group']?.['secondary-types'] || [];
      const _rgTitle = det['release-group']?.title || rel['release-group']?.title || '';
      const rgIsComp = _rgSec.some(t => /compilation|live/i.test(t))
                    || /best of|greatest hits|the very best|anthology|collection|\blive\b/i.test(_rgTitle);
      for (const md of media) {
        for (const tr of (md.tracks || [])) {
          const tn = _normRecTitle(tr.title || tr.recording?.title || '');
          const ts = _titleScore(tn, tnWanted);
          if (!ts) continue;
          // Artiste : crédit PAR PISTE (le vrai artiste sur la compil) ; repli sur
          // le crédit de l'enregistrement (albums mono-artiste).
          const ac = (tr['artist-credit'] || tr.recording?.['artist-credit'] || [])
            .map(c => (c.name || c.artist?.name || '')).filter(Boolean).join(', ');
          // Année : 1re sortie de l'ENREGISTREMENT (= année d'origine, prime sur les
          // rééditions/compils) si MB l'embarque, sinon date du groupe de sortie.
          const recDate = tr.recording?.['first-release-date'] || '';
          const recYear = recDate ? parseInt(recDate.split('-')[0]) : null;
          // Compil/best-of/live : pas d'année d'enregistrement → null (PAS l'année
          // de la compil). Album normal : l'année du groupe reste un repli valable.
          const year = recYear || (rgIsComp ? null : rgYear) || null;
          // Score : ressemblance titre (×30) + bonus durée (si dispo) + bonus artiste.
          let sc = ts * 30;
          const lenMs = tr.length || tr.recording?.length || 0;
          if (opts.durationSec && lenMs) {
            const dd = Math.abs(Math.round(lenMs / 1000) - opts.durationSec);
            if (dd <= 3) sc += 25; else if (dd <= 8) sc += 10; else if (dd > 30) sc -= 15;
          }
          if (ac) sc += 10;
          if (recYear) sc += 5;
          if (sc > bestSc) { bestSc = sc; best = { artist: ac || null, year, title: tr.title || tr.recording?.title || null }; }
        }
      }
      if (best && best.artist && bestSc >= 30) break; // bonne release trouvée
    }
    // On cherche surtout l'ARTISTE réel (le champ qui manque) : sans lui, inutile.
    if (!best || !best.artist) return null;
    console.log(`[anchor] "${title}" sur "${_alb}" → ${best.artist} / ${best.year || '?'} (sc ${bestSc})`);
    return { artist: best.artist, year: best.year || null, title: best.title || null, album: null, cover: null, genre: null, score: 95 };
  } catch (e) {
    console.log('[anchor] échec:', e?.message || e);
    return null;
  }
}

async function fetchFromMusicBrainz(album, artist) {
  try {
    const parts = [];
    if (album)  parts.push(`release:"${String(album).replace(/"/g, '\\"')}"`);
    if (artist) parts.push(`artist:"${String(artist).replace(/"/g, '\\"')}"`);
    if (!parts.length) return { genre: null, year: null, trusted: false };
    const q = encodeURIComponent(parts.join(' AND '));
    const data = await httpsGet(`https://musicbrainz.org/ws/2/release/?query=${q}&fmt=json&limit=5&inc=release-groups`);
    const releases = data.releases || [];
    if (!releases.length) return { genre: null, year: null, trusted: false };

    // Garder seulement les releases dont le release-group title ou la release
    // title matche l'album demandé. Si tout est filtré, fallback sur la 1ère
    // (et on marque trusted=false).
    const matching = [];
    for (const rel of releases) {
      const relTitle = rel.title || '';
      const rgTitle  = rel['release-group']?.title || '';
      const secTypes = rel['release-group']?.['secondary-types'] || [];
      const isComp = secTypes.includes('Compilation') || looksLikeCompilation(rgTitle) || looksLikeCompilation(relTitle);
      const isLive = secTypes.includes('Live');
      const score  = typeof rel.score === 'number' ? rel.score : 100;
      if (!album || titleMatches(rgTitle, album) || titleMatches(relTitle, album)) {
        matching.push({ rel, score, isComp, isLive });
      }
    }
    const useList = matching.length
      ? matching
      : [{ rel: releases[0], score: releases[0].score || 80, isComp: true, isLive: false }];
    useList.sort((a, b) => {
      const rankA = (a.isComp ? 2 : 0) + (a.isLive ? 1 : 0);
      const rankB = (b.isComp ? 2 : 0) + (b.isLive ? 1 : 0);
      if (rankA !== rankB) return rankA - rankB;
      return (b.score || 0) - (a.score || 0);
    });
    const best = useList[0];

    // Année : first-release-date du release-group (authoritative).
    // Fallback sur rel.date uniquement si ce n'est pas une compilation
    // (sinon "date" = date de la compilation, pas de l'œuvre originale).
    const firstReleaseDate = best.rel['release-group']?.['first-release-date'] || '';
    const thisReleaseDate  = best.rel.date || '';
    let year = _parseYearStrict(firstReleaseDate);
    if (year === null && !best.isComp) year = _parseYearStrict(thisReleaseDate);

    // Tags du release-group + release
    const rel = best.rel;
    const allTags = [
      ...(rel['release-group']?.genres || []),
      ...(rel['release-group']?.tags || []),
      ...(rel.genres || []),
      ...(rel.tags || [])
    ];
    const solidTags = allTags.filter(t => (t.count || 0) >= 2)
      .sort((a, b) => (b.count || 0) - (a.count || 0))
      .map(t => t.name || t.value || '');
    let genre = null;
    for (const tag of solidTags) {
      const g = mapToGenre15(tag);
      if (g) { genre = g; break; }
    }
    if (!genre && allTags.length <= 3) {
      for (const t of allTags) {
        const g = mapToGenre15(t.name || t.value || '');
        if (g) { genre = g; break; }
      }
    }
    const trusted = matching.length > 0 && !best.isComp;
    return { genre, year, trusted };
  } catch (e) { return { genre: null, year: null, trusted: false }; }
}

// 7b. Discogs (genres et styles)
async function fetchFromDiscogs(artist, album) {
  try {
    if (!artist && !album) return { genre: null, year: null, trusted: false };
    // type=master → le MASTER porte l'année originale (release = pressing).
    const params = new URLSearchParams();
    params.set('type', 'master');
    if (artist) params.set('artist', artist);
    if (album)  params.set('release_title', album);
    params.set('per_page', '5');
    let data = await httpsGet(`https://api.discogs.com/database/search?${params.toString()}`);
    let items = data.results || [];
    let usedMasters = true;
    if (!items.length) {
      // fallback sur release si aucun master
      usedMasters = false;
      const p2 = new URLSearchParams();
      p2.set('type', 'release');
      if (artist) p2.set('artist', artist);
      if (album)  p2.set('release_title', album);
      p2.set('per_page', '5');
      data = await httpsGet(`https://api.discogs.com/database/search?${p2.toString()}`);
      items = data.results || [];
      if (!items.length) return { genre: null, year: null, trusted: false };
    }

    // Filter by title match — Discogs `title` = "Artist - Album"
    const matching = [];
    for (const it of items) {
      const parts = String(it.title || '').split(' - ', 2);
      const albumPart = parts[1] || parts[0];
      if (!album || titleMatches(albumPart, album)) matching.push(it);
    }
    const useList = matching.length ? matching : (usedMasters ? items.slice(0, 1) : []);
    if (!useList.length) return { genre: null, year: null, trusted: false };

    const best = useList[0];
    const year = _parseYearStrict(best.year);

    let genre = null;
    // Collect genres + styles across top matching hits; style is more precise.
    for (const it of useList.slice(0, 3)) {
      if (genre) break;
      for (const g of [...(it.style || []), ...(it.genre || [])]) {
        const mapped = mapToGenre15(g);
        if (mapped) { genre = mapped; break; }
      }
    }
    // trusted = on a un master ET le titre matche réellement
    const trusted = usedMasters && matching.length > 0;
    return { genre, year, trusted };
  } catch (e) { return { genre: null, year: null, trusted: false }; }
}

// 7c. Deezer — titre matché, genre via détail album, année NON-TRUSTED
//     (release_date Deezer = souvent date d'ingestion digitale plutôt que
//     date originale, donc on ne la trust pas pour les vieux albums).
const LASTFM_API_KEY = 'fe52d59e6d926cc8364f1ccb20d247ad';
async function fetchFromLastfm(artist, album) {
  try {
    if (!LASTFM_API_KEY || !artist) return { genre: null, genreRaw: null, year: null, trusted: false, source: 'lastfm' };
    const a = encodeURIComponent(artist);
    let tags = [];
    if (album) {
      const al = encodeURIComponent(album);
      try {
        const d = await httpsGet(`https://ws.audioscrobbler.com/2.0/?method=album.gettoptags&artist=${a}&album=${al}&api_key=${LASTFM_API_KEY}&format=json&autocorrect=1`);
        const t = d?.toptags?.tag;
        if (Array.isArray(t)) tags = t; else if (t) tags = [t];
      } catch(e) {}
    }
    if (!tags.length) {
      try {
        const d = await httpsGet(`https://ws.audioscrobbler.com/2.0/?method=artist.gettoptags&artist=${a}&api_key=${LASTFM_API_KEY}&format=json&autocorrect=1`);
        const t = d?.toptags?.tag;
        if (Array.isArray(t)) tags = t; else if (t) tags = [t];
      } catch(e) {}
    }
    if (!tags.length) return { genre: null, genreRaw: null, year: null, trusted: false, source: 'lastfm' };
    tags.sort((x,y) => (parseInt(y.count)||0) - (parseInt(x.count)||0));
    let genre = null, genreRaw = null;
    for (const tg of tags) {
      const name = (tg?.name || '').trim();
      if (!name) continue;
      const mapped = mapToGenre15(name);
      if (mapped) { genre = mapped; genreRaw = name; break; }
    }
    if (!genreRaw && tags[0]?.name) genreRaw = tags[0].name.trim();
    return { genre, genreRaw, year: null, trusted: false, source: 'lastfm' };
  } catch(e) {
    return { genre: null, genreRaw: null, year: null, trusted: false, source: 'lastfm' };
  }
}

async function fetchFromDeezer(album, artist) {
  try {
    const q = encodeURIComponent(`${artist || ''} ${album || ''}`.trim());
    if (!q || q === '%20') return { genre: null, year: null, trusted: false };
    const data = await httpsGet(`https://api.deezer.com/search/album?q=${q}&limit=5`);
    const items = data.data || [];
    if (!items.length) return { genre: null, year: null, trusted: false };

    // C206 : on retient si le top vient d'un VRAI match de titre (et pas du
    // simple repli items[0]) — seule cette corroboration est fiable.
    const _dzMatch = album ? items.find(it => titleMatches(it.title || '', album)) : items[0];
    const top = _dzMatch || items[0];
    let year = null;
    let genre = null;
    if (top?.id) {
      try {
        const detail = await httpsGet(`https://api.deezer.com/album/${top.id}`);
        if (detail?.release_date) {
          year = _parseYearStrict(detail.release_date);
        }
        if (Array.isArray(detail?.genres?.data)) {
          for (const g of detail.genres.data) {
            const mapped = mapToGenre15(g?.name || '');
            if (mapped) { genre = mapped; break; }
          }
        }
      } catch { /* ignore detail fail */ }
    }
    // Pochettes (Option A) : cover_xl/cover_big de chaque résultat de recherche.
    const covers = [];
    for (const it of items) {
      const url = it.cover_xl || it.cover_big || it.cover_medium || null;
      if (url) covers.push({
        url,
        album: it.title || '',
        artist: it.artist?.name || '',
        year: (it.release_date || '').slice(0, 4) || null,
        source: 'Deezer',
        quality: it.cover_xl ? 1000 : 500
      });
    }
    // Deezer year = untrusted (voir commentaire ci-dessus)
    // C211 : idem iTunes — sans match de titre, top = items[0] = un autre album.
    return { genre: _dzMatch ? genre : null, year: _dzMatch ? year : null, trusted: false, covers,
             artist: _dzMatch ? (top.artist?.name || null) : null,   // C206
             album:  _dzMatch ? (top.title || null) : null };
  } catch(e) { return { genre: null, year: null, trusted: false }; }
}

// 7d. Wikipedia (dernier recours pour le genre)
// Dernier recours GENRE : Wikidata (gratuit, sans clé, données structurées).
// Cherche l'entité artiste par nom, lit sa propriété "genre musical" (P136),
// récupère le libellé du genre et le mappe vers les 16. Non-trusted (proposition).
// Trouve souvent des artistes obscurs que Wikipedia texte rate, et c'est plus
// fiable à parser (structuré). N'est appelé QUE si rien d'autre n'a donné de genre.
// fetchFromWikidata : version unique conservatrice définie plus bas (~ligne 1700,
// recherche par artiste + garde-fou MUSIC_RE, retour libellé bucket). L'ancienne
// version (retour objet, sans garde-fou) a été retirée pour éviter la collision.

async function fetchFromWikipedia(artist) {
  if (!artist) return null;
  try {
    const q = encodeURIComponent(artist);
    const data = await httpsGet(`https://en.wikipedia.org/api/rest_v1/page/summary/${q}`);
    // FIX précédence de || : "a || '' + b" se parse comme "a || ('' + b)",
    // ce qui fait qu'on n'utilise JAMAIS description + extract ensemble.
    const text = ((data.description || '') + ' ' + (data.extract || '')).toLowerCase();
    const tags = ['blues','gospel','jazz','swing','soul','funk','disco','rock','punk','grunge','alternative','metal','hip hop','rap','pop','r&b','folk','country','ambient','electronic','techno','house','reggae','dub','ska','latin','salsa','afrobeat','classical','opera','soundtrack'];
    for (const t of tags) {
      if (text.includes(t)) {
        const mapped = mapToGenre15(t);
        if (mapped) return mapped;
      }
    }
    return null;
  } catch(e) { return null; }
}

// ============================================================
// 8. FONCTIONS NICHE (COMPILATIONS, ARTISTES PEU CONNUS)
// ============================================================

// 8z. MusicBrainz RELEASE-GROUP (source primaire durcie pour l'année)
//     L'endpoint /release-group/ porte la first-release-date CANONIQUE du RG
//     (la plus ancienne sortie de l'œuvre, tous pressings confondus). Contrairement
//     au RG embarqué dans /release/ — souvent sans date, ce qui faisait retomber
//     sur la date du pressing matché (= rééditions 2024). On rejette d'emblée tout
//     RG dont les types trahissent une compilation/live/remaster.
//     Retourne { year, genre, trusted, source:'mb-rg' } ou trusted:false si douteux.
const _MB_BAD_SECONDARY = ['Compilation', 'Live', 'Remix', 'DJ-mix', 'Mixtape/Street'];
async function fetchFromMusicBrainzReleaseGroup(album, artist) {
  try {
    const parts = [];
    if (album)  parts.push(`releasegroup:"${String(album).replace(/"/g, '\\"')}"`);
    if (artist) parts.push(`artist:"${String(artist).replace(/"/g, '\\"')}"`);
    if (!parts.length) return { genre: null, year: null, trusted: false, source: 'mb-rg' };
    const query = encodeURIComponent(parts.join(' AND '));
    const data = await httpsGet(`https://musicbrainz.org/ws/2/release-group/?query=${query}&fmt=json&limit=8&inc=genres+tags`);
    let groups = data['release-groups'] || [];
    // C204 : la PHRASE EXACTE quotée est fragile — « Brownie McGhee & Sonny
    // Terry » ne matche jamais le crédit MB « Sonny Terry & Brownie McGhee »
    // (ordre inversé). Repli en recherche par TERMES (ordre des mots
    // indifférent) ; le post-filtre titleMatches protège des homonymes.
    if (!groups.length) {
      const _san = s => String(s || '').replace(/["&:()\[\]!]/g, ' ').replace(/\s+/g, ' ').trim();
      const p2 = [];
      if (album  && _san(album))  p2.push(`releasegroup:(${_san(album)})`);
      if (artist && _san(artist)) p2.push(`artist:(${_san(artist)})`);
      if (p2.length) {
        await new Promise(r => setTimeout(r, 1100)); // throttle MB 1 req/s
        const d2 = await httpsGet(`https://musicbrainz.org/ws/2/release-group/?query=${encodeURIComponent(p2.join(' AND '))}&fmt=json&limit=8&inc=genres+tags`);
        groups = d2['release-groups'] || [];
        if (groups.length) console.log(`[mb-rg] phrase exacte vide → repli par termes OK (${groups.length} candidats)`);
      }
      if (!groups.length) return { genre: null, year: null, trusted: false, source: 'mb-rg' };
    }

    // Enrichir + filtrer : on veut un RG primaire "Album", titre matché,
    // SANS secondary-type suspect (Compilation/Live/Remix/DJ-mix).
   // Types PRIMAIRES non-musicaux : émissions radio, interviews, livres audio…
    // Leur date est parasite (ex. « In the Studio: Led Zeppelin IV » = Broadcast 1990,
    // pas l'album original de 1971). On les exclut.
    const _MB_BAD_PRIMARY = ['Broadcast', 'Interview', 'Audiobook', 'Spokenword', 'Audio drama', 'Other'];
    const enriched = groups.map(rg => {
      const title    = rg.title || '';
      const primary  = rg['primary-type'] || '';
      const secTypes = rg['secondary-types'] || [];
      const isBadType = _MB_BAD_PRIMARY.includes(primary);
      const isComp   = secTypes.some(t => _MB_BAD_SECONDARY.includes(t)) || looksLikeCompilation(title);
      const matches  = !album || titleMatches(title, album);
      const isAlbum  = primary === 'Album';
      const year     = _parseYearStrict(rg['first-release-date'] || '');
      return { rg, title, isBadType, isComp, matches, isAlbum, year, score: rg.score || 0 };
    });

    // On ne garde que les RG matchés, type musical, non-comp, année plausible.
    const clean = enriched.filter(e => e.matches && !e.isBadType && !e.isComp && e.year !== null);
    if (!clean.length) {
      // Aucun candidat propre → on ne tranche PAS l'année ici (laisse la revue).
      // On tente quand même un genre depuis le meilleur match brut.
      const fallback = enriched.filter(e => e.matches).sort((a, b) => b.score - a.score)[0] || enriched[0];
      let g = null;
      // C211 : `|| enriched[0]` reprend un release-group ARBITRAIRE quand rien ne
      // matche → on en tirait le genre d'un homonyme. Genre de repli uniquement
      // si le RG matche réellement l'album demandé.
      if (fallback && fallback.matches) {
        const tags = [...(fallback.rg.genres || []), ...(fallback.rg.tags || [])]
          .filter(t => (t.count || 0) >= 2)
          .sort((a, b) => (b.count || 0) - (a.count || 0));
        for (const t of tags) { const m = mapToGenre15(t.name || t.value || ''); if (m) { g = m; break; } }
      }
      return { genre: g, year: null, trusted: false, source: 'mb-rg' };
    }

    // Tri : Album primaire d'abord, puis meilleur score, puis ANNÉE LA PLUS ANCIENNE
    // (en cas d'égalité, l'œuvre originale prime sur une variante plus récente).
    clean.sort((a, b) => {
      if (a.isAlbum !== b.isAlbum) return a.isAlbum ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      return a.year - b.year;
    });
    const best = clean[0];
    // Année finale = min des candidats propres (la plus ancienne sortie crédible).
    const year = clean.reduce((min, e) => (e.year < min ? e.year : min), best.year);

    // Genre depuis les tags du RG retenu.
    let genre = null;
    const tags = [...(best.rg.genres || []), ...(best.rg.tags || [])]
      .filter(t => (t.count || 0) >= 2)
      .sort((a, b) => (b.count || 0) - (a.count || 0));
    for (const t of tags) { const m = mapToGenre15(t.name || t.value || ''); if (m) { genre = m; break; } }

    // trusted = match propre, Album primaire, année plausible.
    const trusted = best.matches && best.isAlbum && year !== null;
    // C206 : remonter l'ARTISTE et l'ALBUM réellement matchés. Sans ça le pool
    // de corroboration reste vide et le garde-fou de _processItem refuse tout
    // (« aucune source en ligne ne connaît ce morceau ») même quand la source a
    // parfaitement identifié l'album. Uniquement si le titre a matché (best ∈ clean).
    return { genre, year, trusted, source: 'mb-rg', artist: _mbCredit(best.rg) || null, album: best.title || null,
             rgid: best.rg.id || null };   // C212 : MBID du release-group (pochette Cover Art Archive)
 } catch (e) {
    console.warn('[MusicBrainz-RG] error:', e.message);
    return { genre: null, year: null, trusted: false, source: 'mb-rg', _err: e.message };
  }
}

// COVER ART ARCHIVE (option 3) : pochette fiable indexée par l'identifiant
// MusicBrainz. On cherche le release-group correspondant à l'album TAGGÉ (compils
// incluses → on vise la pochette du tag, ex. la « Greatest Hits »), on vérifie que
// CAA a bien une face avant, puis on renvoie l'URL front-500. Appelée UNIQUEMENT
// en dernier recours (aucune cover iTunes/Deezer) → ne tape MB/CAA que sur les
// rares cas sans pochette (protège le lot du rate-limit).
// C212 : POCHETTE Cover Art Archive à partir d'un release-group MBID DÉJÀ résolu.
// Contrairement à fetchCoverArtForAlbum(), on ne refait AUCUNE recherche
// MusicBrainz : fetchFromMusicBrainzReleaseGroup a déjà trouvé le release-group
// ET validé son titre. Gain : 1 requête MB + 1,1 s de throttle en moins par album
// (~30 min sur une bibliothèque de 1 500 albums).
// Surtout : la pochette est adossée à l'ENTITÉ MusicBrainz, pas à une
// correspondance de noms — c'est ce qui débloque les COMPILATIONS, où l'artiste
// de la piste (« Aretha Franklin ») ne matche jamais celui de l'album
// (« Various Artists ») et faisait rejeter toutes les pochettes.
async function fetchCaaByRgid(rgid, rgTitle, artist, year) {
  if (!rgid) return null;
  try {
    // L'index JSON renvoie 404 s'il n'y a aucune illustration pour ce RG.
    const caa = await httpsGet(`https://coverartarchive.org/release-group/${rgid}`);
    const hasFront = Array.isArray(caa && caa.images)
      && caa.images.some(im => im.front || (im.types || []).includes('Front'));
    if (!hasFront) return null;
    return {
      url: `https://coverartarchive.org/release-group/${rgid}/front-1200`,
      album: rgTitle || null, artist: artist || null, year: year || null,
      source: 'Cover Art Archive', quality: 1200
    };
  } catch (e) {
    return null;   // pas d'art = pas d'art
  }
}

async function fetchCoverArtForAlbum(album, artist) {
  if (!album) return null;
  try {
    const parts = [`releasegroup:"${String(album).replace(/"/g, '\\"')}"`];
    if (artist) parts.push(`artist:"${String(artist).replace(/"/g, '\\"')}"`);
    const q = encodeURIComponent(parts.join(' AND '));
    const data = await httpsGet(`https://musicbrainz.org/ws/2/release-group/?query=${q}&fmt=json&limit=6`);
    const groups = data['release-groups'] || [];
    if (!groups.length) return null;
    // Meilleur RG dont le TITRE matche l'album demandé (score MB en départage).
    const cand = groups
      .filter(rg => titleMatches(rg.title || '', album))
      .sort((a, b) => (b.score || 0) - (a.score || 0));
    // Item 7 — œuvre classique : n'accepter QUE si un release-group matche
    // l'œuvre demandée (sinon « groups[0] » serait une autre œuvre du même
    // compositeur). Mieux vaut pas de cover qu'une cover de la mauvaise œuvre.
    const _isClassicalWork = (typeof _looksLikeClassicalWork === 'function')
      && _looksLikeClassicalWork(artist, album);
    const rg = cand[0] || (_isClassicalWork ? null : groups[0]);
    if (!rg || !rg.id) return null;
    await new Promise(r => setTimeout(r, 1100)); // courtoisie MusicBrainz (1 req/s)
    // Vérifie l'existence d'une face avant via l'index JSON CAA (404 si pas d'art).
    let hasFront = false;
    try {
      const caa = await httpsGet(`https://coverartarchive.org/release-group/${rg.id}`);
      hasFront = Array.isArray(caa && caa.images)
        && caa.images.some(im => im.front || (im.types || []).includes('Front'));
    } catch (e) { hasFront = false; }
    if (!hasFront) return null;
    const yr = _parseYearStrict(rg['first-release-date'] || '');
    return {
      url: `https://coverartarchive.org/release-group/${rg.id}/front-1200`,
      album: rg.title || album, artist: artist || null, year: yr || null,
      source: 'Cover Art Archive', quality: 1200
    };
  } catch (e) {
    console.warn('[CoverArtArchive] error:', e && e.message || e);
    return null;
  }
}

// ── Round 3 — POCHETTE via Wikipédia (dernier recours, SANS authentification) ──
// Forte pour la chanson FR / B.O. / pressages obscurs là où iTunes/Deezer/CAA calent.
// Prudent : on n'accepte l'image d'en-tête que si la page ressemble bien à l'ALBUM
// demandé (titre qui matche, ou description « album/single/bande originale »…), sinon
// on risquerait de récupérer une photo d'artiste. Mieux pas de cover qu'une fausse.
async function _wikiCover(host, artist, album) {
  const q = encodeURIComponent([album, artist].filter(Boolean).join(' '));
  const url = `https://${host}/w/api.php?action=query&format=json&redirects=1`
            + `&generator=search&gsrsearch=${q}&gsrlimit=4&gsrnamespace=0`
            + `&prop=pageimages|pageterms&piprop=original`;
  let data;
  try { data = await httpsGet(url); } catch (e) { return null; }
  const pages = data && data.query && data.query.pages;
  if (!pages) return null;
  const list = Object.values(pages)
    .filter(p => p && p.original && p.original.source)
    .sort((a, b) => (a.index || 99) - (b.index || 99));
  const albumKw = /\b(album|single|\bep\b|soundtrack|bande[ -]?originale|bande[ -]?son|cantata|opera|opéra|symphon)/i;
  for (const p of list) {
    const desc = (p.terms && p.terms.description && p.terms.description[0]) || '';
    const okTitle = (typeof titleMatches === 'function') && titleMatches(p.title || '', album);
    const okDesc  = albumKw.test(desc);
    if (okTitle || okDesc) {
      return {
        url: p.original.source, album: album, artist: artist || null, year: null,
        source: `Wikipedia (${host.split('.')[0]})`, quality: p.original.width || 0
      };
    }
  }
  return null;
}

async function fetchCoverWikipedia(artist, album) {
  if (!album) return null;
  let r = await _wikiCover('fr.wikipedia.org', artist, album);   // FR d'abord (chanson/variété)
  if (r && r.url) return r;
  await new Promise(res => setTimeout(res, 300));                 // courtoisie
  r = await _wikiCover('en.wikipedia.org', artist, album);        // puis EN
  return (r && r.url) ? r : null;
}

async function fetchFromMusicBrainzEnhanced(album, artist) {
  try {
    const parts = [];
    if (artist) parts.push(`artist:"${String(artist).replace(/"/g, '\\"')}"`);
    if (album)  parts.push(`release:"${String(album).replace(/"/g, '\\"')}"`);
    if (!parts.length) return { genre: null, year: null, trusted: false };
    const query = encodeURIComponent(parts.join(' AND '));

    const data = await httpsGet(`https://musicbrainz.org/ws/2/release/?query=${query}&fmt=json&limit=10&inc=release-groups+genres+tags`);
    let releases = data.releases || [];
    // C204 : même repli que mb-rg — phrase exacte quotée trop fragile quand
    // l'ordre des artistes diffère du crédit MusicBrainz.
    if (!releases.length) {
      const _san = s => String(s || '').replace(/["&:()\[\]!]/g, ' ').replace(/\s+/g, ' ').trim();
      const p2 = [];
      if (artist && _san(artist)) p2.push(`artist:(${_san(artist)})`);
      if (album  && _san(album))  p2.push(`release:(${_san(album)})`);
      if (p2.length) {
        await new Promise(r => setTimeout(r, 1100)); // throttle MB 1 req/s
        const d2 = await httpsGet(`https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(p2.join(' AND '))}&fmt=json&limit=10&inc=release-groups+genres+tags`);
        releases = d2.releases || [];
        if (releases.length) console.log(`[mb] phrase exacte vide → repli par termes OK (${releases.length} candidats)`);
      }
      if (!releases.length) return { genre: null, year: null, trusted: false };
    }

    // Filter to matches, compute per-hit metadata
    const enriched = releases.map(rel => {
      const rgTitle  = rel['release-group']?.title || '';
      const relTitle = rel.title || '';
      const secTypes = rel['release-group']?.['secondary-types'] || [];
      const isComp = secTypes.includes('Compilation') || looksLikeCompilation(rgTitle) || looksLikeCompilation(relTitle);
      const isLive = secTypes.includes('Live');
      const matches = !album || titleMatches(rgTitle, album) || titleMatches(relTitle, album);
      return { rel, rgTitle, relTitle, isComp, isLive, matches, score: rel.score || 0 };
    });
    const matched = enriched.filter(e => e.matches);
    const useList = matched.length ? matched : enriched.slice(0, 1);
    useList.sort((a, b) => {
      const rankA = (a.isComp ? 2 : 0) + (a.isLive ? 1 : 0);
      const rankB = (b.isComp ? 2 : 0) + (b.isLive ? 1 : 0);
      if (rankA !== rankB) return rankA - rankB;
      return b.score - a.score;
    });
    const best = useList[0];

    // ✅ CORRECTION : priorité au release-group first-release-date
    // C'est LA date originale de l'album
    const firstReleaseDate = best.rel['release-group']?.['first-release-date'] || '';
    let year = _parseYearStrict(firstReleaseDate);
    let trusted = matched.length > 0 && !best.isComp && !best.isLive && year !== null;
    
    // Fallback sur la date de cette release UNIQUEMENT si pas de first-release-date
    // et que ce n'est pas une réédition évidente
    if (!year && !best.isComp && !best.isLive) {
      const thisReleaseDate = best.rel.date || '';
      year = _parseYearStrict(thisReleaseDate);
      trusted = trusted && year !== null;
    }

    // Genre (inchangé)
    let genre = null;
    const allTags = [
      ...(best.rel['release-group']?.genres || []),
      ...(best.rel['release-group']?.tags   || []),
      ...(best.rel.genres || []),
      ...(best.rel.tags   || [])
    ];
    const solidTags = allTags.filter(t => (t.count || 0) >= 2)
      .sort((a, b) => (b.count || 0) - (a.count || 0));
    for (const tag of solidTags) {
      const mapped = mapToGenre15(tag.name || tag.value || '');
      if (mapped) { genre = mapped; break; }
    }
    if (!genre && allTags.length <= 3) {
      for (const tag of allTags) {
        const mapped = mapToGenre15(tag.name || tag.value || '');
        if (mapped) { genre = mapped; break; }
      }
    }

    // C206 : artiste/album réellement matchés (uniquement si le titre a matché)
    // C211 : et sans match, aucun genre/année non plus — useList retombait sur
    // enriched[0] (une release arbitraire de la recherche).
    const _ok = matched.length > 0;
    return { genre: _ok ? genre : null, year: _ok ? year : null, trusted: _ok && trusted,
             artist: _ok ? (_mbCredit(best.rel) || null) : null,
             album:  _ok ? (best.rgTitle || best.relTitle || null) : null };
  } catch(e) { 
    console.warn('[MusicBrainz] error:', e.message);
    return { genre: null, year: null, trusted: false }; 
  }
}

async function fetchFromDiscogsPublic(artist, album) {
  try {
    if (!artist && !album) return { genre: null, year: null, trusted: false };
    // type=master carries the original year. Structured fields are far more
    // precise than bare `q=`. Fall back to type=release only if no master.
    const params = new URLSearchParams();
    params.set('type', 'master');
    if (artist && !album?.toLowerCase().includes('various')) params.set('artist', artist);
    if (album)  params.set('release_title', album);
    params.set('per_page', '5');
    let data = await httpsGet(`https://api.discogs.com/database/search?${params.toString()}`);
    let items = data.results || [];
    let usedMasters = true;

    // Pass 2: type=release with structured artist/title (catches singles, eps, etc.)
    if (!items.length) {
      usedMasters = false;
      const p2 = new URLSearchParams();
      p2.set('type', 'release');
      if (artist && !album?.toLowerCase().includes('various')) p2.set('artist', artist);
      if (album) p2.set('release_title', album);
      p2.set('per_page', '5');
      data = await httpsGet(`https://api.discogs.com/database/search?${p2.toString()}`);
      items = data.results || [];
    }

    // Pass 3: FUZZY — q= searches ALL fields like Google. Catches records whose
    // stored title differs from the file's tag (e.g. file "Chilli With Honey" vs
    // Discogs "When I'm Alone / Chili With Honey").
    if (!items.length) {
      const p3 = new URLSearchParams();
      p3.set('type', 'release');
      p3.set('q', `${artist || ''} ${album || ''}`.trim());
      p3.set('per_page', '10');
      const url3 = `https://api.discogs.com/database/search?${p3.toString()}`;
      console.log(`[Discogs fuzzy] querying: ${url3}`);
      try {
        const data3 = await httpsGet(url3);
        items = data3?.results || [];
        console.log(`[Discogs fuzzy] q= returned ${items.length} hits for "${artist} - ${album}"`);
        if (items.length > 0 && items[0]) {
          console.log(`[Discogs fuzzy] first hit:`, JSON.stringify({
            title: items[0].title,
            year:  items[0].year,
            genre: items[0].genre,
            style: items[0].style
          }));
        }
      } catch (e) {
        console.log(`[Discogs fuzzy] ERROR for "${artist} - ${album}":`, e.message);
      }
    }

    // Last resort: if all 3 passes returned nothing, fall back to album-name keyword heuristic.
    if (!items.length) {
      let fallbackGenre = null;
      if (album) {
        const al = album.toLowerCase();
        if (al.includes('disco') || al.includes('funk')) fallbackGenre = 'Soul, Funk & Disco';
        else if (al.includes('afro') || al.includes('african')) fallbackGenre = 'Afrobeat, African & World';
        else if (al.includes('reggae') || al.includes('dub')) fallbackGenre = 'Reggae, Dub & Ska';
        else if (al.includes('latin') || al.includes('salsa')) fallbackGenre = 'Latin, Caribbean, Flamenco, Tango';
        else if (al.includes('punk') || al.includes('grunge')) fallbackGenre = 'Punk, Grunge & Alternative';
        else if (al.includes('metal')) fallbackGenre = 'Heavy Metal & Loud';
        else if (al.includes('electronic') || al.includes('techno')) fallbackGenre = 'Electronic, House & Techno';
      }
      return { genre: fallbackGenre, year: null, trusted: false };
    }

    // Filter by title match — Discogs title = "Artist - Album"
    const matching = [];
    for (const it of items) {
      const parts = String(it.title || '').split(' - ', 2);
      const albumPart = parts[1] || parts[0];
      if (!album || titleMatches(albumPart, album)) matching.push(it);
    }
    const useList = matching.length ? matching : (usedMasters ? items.slice(0, 1) : items.slice(0, 3));
    if (!useList.length) return { genre: null, year: null, trusted: false };

    const best = useList[0];
    // C211 : album demandé mais AUCUN titre ne matche → ces hits parlent d'un
    // AUTRE disque (surtout via la passe 3 « fuzzy q= », qui cherche dans tous
    // les champs). En tirer genre/année produisait de fausses données
    // d'homonyme. Pas de match = pas de donnée. NB : l'heuristique par NOM
    // D'ALBUM ci-dessous reste active (elle ne dépend d'aucun résultat).
    const _dgOk = !album || matching.length > 0;
    const year = _dgOk ? _parseYearStrict(best.year) : null;

    let genre = null;
    if (_dgOk) for (const it of useList.slice(0, 3)) {
      if (genre) break;
      for (const g of [...(it.style || []), ...(it.genre || [])]) {
        const mapped = mapToGenre15(g);
        if (mapped) { genre = mapped; break; }
      }
    }
    // Niche heuristics if still nothing
    if (!genre && album) {
      const al = album.toLowerCase();
      if (al.includes('disco') || al.includes('funk')) genre = 'Soul, Funk & Disco';
      else if (al.includes('afro') || al.includes('african')) genre = 'Afrobeat, African & World';
      else if (al.includes('reggae') || al.includes('dub')) genre = 'Reggae, Dub & Ska';
      else if (al.includes('latin') || al.includes('salsa')) genre = 'Latin, Caribbean, Flamenco, Tango';
      else if (al.includes('punk') || al.includes('grunge')) genre = 'Punk, Grunge & Alternative';
      else if (al.includes('metal')) genre = 'Heavy Metal & Loud';
      else if (al.includes('electronic') || al.includes('techno')) genre = 'Electronic, House & Techno';
    }
    const trusted = usedMasters && matching.length > 0;
    // C206 : titre Discogs = « Artiste - Album » → corroboration extraite
    // (uniquement si le titre a réellement matché le tag local).
    let _dgArtist = null, _dgAlbum = null;
    if (matching.length > 0) {
      const _p = String(best.title || '').split(' - ', 2);
      if (_p.length > 1) { _dgArtist = _p[0].trim() || null; _dgAlbum = _p[1].trim() || null; }
      else { _dgAlbum = (_p[0] || '').trim() || null; }
    }
    return { genre, year, trusted, artist: _dgArtist, album: _dgAlbum };
  } catch(e) { return { genre: null, year: null, trusted: false }; }
}

// ── iTunes Search API (free, no key, already in CSP) ────────────
// Bon pour le GENRE sur mainstream. L'ANNÉE est non-trusted (= date
// d'ingestion digitale sur le store iTunes, souvent postérieure au release).
async function fetchFromItunes(artist, album) {
  try {
    const terms = [artist, album].filter(Boolean).join(' ');
    if (!terms.trim()) return { genre: null, year: null, trusted: false };
    const q = encodeURIComponent(terms);
    const data = await httpsGet(`https://itunes.apple.com/search?term=${q}&entity=album&limit=5&media=music`);
    const items = data.results || [];
    if (!items.length) return { genre: null, year: null, trusted: false };

    const matching = album
      ? items.filter(it => titleMatches(it.collectionName || '', album))
      : items;
    const useList = matching.length ? matching : [items[0]];

    let year = null;
    let genre = null;
    const covers = [];
    for (const it of useList) {
      if (!genre && it.primaryGenreName) {
        const mapped = mapToGenre15(it.primaryGenreName);
        if (mapped) genre = mapped;
      }
      const y = _parseYearStrict(it.releaseDate);
      if (y && (year === null || y < year)) year = y;
      // Pochette (Option A : c'est le main qui la collecte) : 100x100 → 600x600.
      const art = it.artworkUrl100 ? it.artworkUrl100.replace('100x100bb', '1200x1200bb') : null;
      if (art) covers.push({
        url: art,
        album: it.collectionName || '',
        artist: it.artistName || '',
        year: (it.releaseDate || '').slice(0, 4) || null,
        genre: it.primaryGenreName || null,
        source: 'iTunes',
        quality: 600
      });
    }
    // iTunes year = untrusted
    // C206 : artiste/album réellement matchés (seulement si titleMatches a validé
    // l'album — pas sur le repli items[0], qui peut être un homonyme).
    const _itOk = matching.length > 0;
    // C211 : aucun titre ne matche l'album demandé → ces résultats parlent d'un
    // AUTRE album. Le repli items[0] injectait alors un genre et une année
    // d'homonyme (« Gong Under Ground Modern » → un album classique de 1996,
    // affiché comme MEILLEUR MATCH). Pas de match = pas de donnée. Les pochettes
    // restent proposées (validées en aval par _consolidateCover).
    return { genre: _itOk ? genre : null, year: _itOk ? year : null, trusted: false, covers,
             artist: _itOk ? (useList[0].artistName || null) : null,
             album:  _itOk ? (useList[0].collectionName || null) : null };
  } catch (e) { return { genre: null, year: null, trusted: false }; }
}

async function fetchFromWikipediaEnhanced(artist, album) {
  if (!artist && !album) return null;
  try {
    let data = null;
    if (artist) {
      const q = encodeURIComponent(artist);
      try { data = await httpsGet(`https://en.wikipedia.org/api/rest_v1/page/summary/${q}`); } catch(e) {}
    }
    if ((!data || !data.extract) && album) {
      const q = encodeURIComponent(album);
      try { data = await httpsGet(`https://en.wikipedia.org/api/rest_v1/page/summary/${q}`); } catch(e) {}
    }
    if (!data || !data.extract) return null;
    
    const text = ((data.description || '') + ' ' + (data.extract || '')).toLowerCase();
    const genreKeywords = {
      'blues':'Blues, Roots & Gospel','gospel':'Blues, Roots & Gospel',
      'jazz':'Jazz & Swing','swing':'Jazz & Swing',
      'soul':'Soul, Funk & Disco','funk':'Soul, Funk & Disco','disco':'Soul, Funk & Disco',
      'rock':'Classic Rock & Hard Rock','hard rock':'Classic Rock & Hard Rock',
      'punk':'Punk, Grunge & Alternative','grunge':'Punk, Grunge & Alternative','alternative':'Punk, Grunge & Alternative',
      'metal':'Heavy Metal & Loud',
      'hip hop':'Hip-Hop & Rap Culture','rap':'Hip-Hop & Rap Culture',
      'pop':'R&B, Pop & Dance','r&b':'R&B, Pop & Dance',
      'folk':'Folk, Country & Americana','country':'Folk, Country & Americana',
      'ambient':'Ambient, New Age & Chill','electronic':'Electronic, House & Techno','techno':'Electronic, House & Techno','house':'Electronic, House & Techno',
      'reggae':'Reggae, Dub & Ska','dub':'Reggae, Dub & Ska','ska':'Reggae, Dub & Ska',
      'latin':'Latin, Caribbean, Flamenco, Tango','salsa':'Latin, Caribbean, Flamenco, Tango',
      'afrobeat':'Afrobeat, African & World','african':'Afrobeat, African & World',
     'classical':'Classical & Opera','opera':'Classical & Opera','soundtrack':'Soundtrack & Score'
    };
    for (const [keyword, genre] of Object.entries(genreKeywords)) {
      if (text.includes(keyword)) return genre;
    }
    return null;
  } catch(e) { return null; }
}

// ── Wikipedia : œuvre historique (Composed/Premiered/...) OU enregistrement
// (Recorded/Released) selon ce que l'infobox expose. Refonte session 5.
//
// Distinction sémantique majeure :
//   • Composed/Written/Premiered/Performed → date HISTORIQUE de l'œuvre
//     (composition/création). Immuable, écrase les rééditions / pressings.
//     C'est l'autorité ultime pour Mozart, Bach, jazz standards, etc.
//   • Recorded/Released → date d'enregistrement / parution. Peut être une
//     réédition. Vote normal (intégré à la convergence ultérieurement).
//
// Stratégie de recherche :
//   • Si l'album/artiste ressemble à une œuvre (marqueurs classiques OU
//     nom d'artiste long capitalisé probablement compositeur OU titre
//     d'œuvre lyrique connue) → search "${composerLast} ${work} composition"
//     pour tomber sur l'article de l'ŒUVRE plutôt que la bio.
//   • Sinon → search "${artist} ${album} song" pour l'article album/chanson.
//
// Retour : { year, source, isHistorical } ou null.
//   source = 'Wikipedia (composed)' / '(premiered)' / '(recorded)' / '(released)' / etc.
//   isHistorical = true pour Composed/Written/Premiered/Performed, false sinon.
// Compositeurs classiques connus (noms de famille, sans accents). Liste FINIE
// et stable — c'est un signal « œuvre classique », pas un override d'artiste. Sert
// uniquement à autoriser la recherche d'année de composition (jamais à fixer un genre),
// donc un faux positif retombe sur null sans rien écrire de faux.
const _CLASSICAL_COMPOSERS = /\b(mozart|beethoven|bach|brahms|dvorak|tchaikovsky|tchaikovski|haydn|handel|vivaldi|chopin|schubert|schumann|mendelssohn|mahler|wagner|verdi|puccini|rossini|debussy|ravel|satie|stravinsky|prokofiev|rachmaninov|rachmaninoff|shostakovich|sibelius|grieg|elgar|holst|bizet|saint-saens|faure|berlioz|liszt|paganini|telemann|purcell|monteverdi|scarlatti|bruckner|bartok|orff|smetana|janacek|borodin|mussorgsky|rimsky-korsakov|glinka|albeniz|granados|respighi|hindemith|poulenc|britten|nielsen|massenet|gounod|delibes|offenbach|donizetti|bellini|vaughan williams)\b/;
function _normCl(x){ return String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }

function _looksLikeClassicalWork(artist, album) {
  const al = album || '';
  // 1. Marqueurs forts dans le titre (existant)
  if (/\b(symphony|sinfonia|concerto|sonata|quartet|quintet|prelude|nocturne|fugue|cantata)\b[\s.]*(no\.?\s*\d|n\.?\s*\d|in\s+[a-g]\b|\d)/i.test(al)) return true;
  if (/\b(op\.?\s*\d|k\.?\s*\d{2,}|bwv\s*\d|hob\b)/i.test(al)) return true;
  if (/\b(requiem|vigil|oratorio|mass\s+in|te\s+deum|magnificat)\b/i.test(al)) return true;
  // 2. Noms d'œuvres lyriques/classiques connues (heuristique, pas exhaustive)
  if (/\b(don giovanni|le nozze di figaro|cosi fan tutte|die zauberflote|the magic flute|la traviata|rigoletto|il trovatore|nabucco|aida|otello|carmen|faust|la boheme|la bohème|tosca|madama butterfly|turandot|the barber of seville|il barbiere|the marriage of figaro|fidelio|tannhauser|tannhäuser|lohengrin|parsifal|tristan und isolde|the ring|der ring|orfeo|peter grimes|the rake's progress|wozzeck|porgy and bess|messiah|st\.? matthew passion|st\.? john passion|the well-tempered clavier|goldberg variations|brandenburg|water music|music for the royal fireworks|the four seasons|le quattro stagioni|stabat mater|missa solemnis|carmina burana|bolero|boléro|peer gynt|pictures at an exhibition|swan lake|the nutcracker|sleeping beauty|romeo and juliet|firebird|petrushka|the rite of spring|la mer|clair de lune|nocturnes|preludes|etudes|nuages gris|gymnopedies|gymnopédies|gnossiennes)\b/i.test(al)) return true;
  // 3. Artiste qui ressemble à un compositeur : nom long, tous mots capitalisés
  if (artist) {
    const parts = artist.trim().split(/\s+/);
    if (parts.length >= 3 && parts.every(p => /^[A-ZÀ-Ý]/.test(p))) return true;
  }
  // 4. Nom de compositeur connu dans le titre/album OU l'artiste → œuvre classique
  if (_CLASSICAL_COMPOSERS.test(_normCl(al)) || _CLASSICAL_COMPOSERS.test(_normCl(artist))) return true;
  return false;
}

async function fetchWikipediaWork(artist, album, title) {
  try {
    if (!artist && !album && !title) return null;

    // Le signal d'œuvre (Op./BWV/nom d'œuvre) est SOUVENT dans le TITRE, pas l'album
    // (ex. « Grieg_ Holberg Suite » + titre « … Op. 40 »). On combine les deux.
    const _wk = ((album || '') + ' ' + (title || '')).trim();
    const looksWork = _looksLikeClassicalWork(artist, _wk);

    // COURT-CIRCUIT PERF : si pas signal d'œuvre, on skippe complètement Wikipedia.
    // Le mode "chanson" (Recorded/Released) est actuellement info-only — il ne
    // change pas la décision. L'appeler sur 95% de la bibliothèque coûterait
    // ~3000 requêtes Wikipedia supplémentaires par warm pour zéro effet pratique.
    // À ré-activer en Phase 2.5 quand on intégrera Recorded/Released au cluster.
    if (!looksWork) return null;

    // Mode œuvre : compositeur en nom de famille + œuvre + mot-clé "composition"
    // pour pousser Wikipedia vers l'article de l'ŒUVRE, pas la bio.
    let composerRaw = '', work = album || '';
    const colon = (album || '').indexOf(':');
    if (colon > 0) {
      composerRaw = album.slice(0, colon).trim();
      work = album.slice(colon + 1).trim();
    } else {
      composerRaw = artist || '';
    }
    // Marqueur univoque (BWV/K./Hob./D.) → le COMPOSITEUR prime sur l'interprète
    // (ex. album « Bach_ … » + artiste « Daniel Barenboim » → compositeur = Bach).
    const _mk = _mainDetectComposerFromMarkers(title, album);
    let composerLast = _mk || (composerRaw.split(/\s+/).pop() || '').trim();
    // Nettoie l'œuvre : « _ » parasite, séparateurs, et préfixe compositeur redondant.
    work = (work || album || '').replace(/_/g, ' ').replace(/\bvespers\b/ig, '').replace(/\s+-\s+/g, ' ').replace(/\s+/g, ' ').trim();
    if (composerLast) work = work.replace(new RegExp('^' + composerLast + '\\s+', 'i'), '').trim();
    const workHasComposer = composerLast && new RegExp(`\b${composerLast}\b`, 'i').test(work);
    const searchQuery = (workHasComposer ? `${work} composition` : `${composerLast} ${work} composition`).trim();
    if (!searchQuery || searchQuery === 'composition') return null;

    // 1. Recherche
    const sUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(searchQuery)}&format=json&origin=*`;
    const sData = await httpsGet(sUrl);
    const pages = sData?.query?.search || [];
    if (!pages.length) return null;

    // Sélection : Wikipedia trie déjà par pertinence. Le piège du wordcount est
    // qu'il favorise la BIOGRAPHIE du compositeur (longue) sur l'ŒUVRE (courte),
    // et la bio n'a pas de date « Composed ». On évite donc la bio (titre = nom
    // du compositeur) et on préfère une page dont le titre matche l'œuvre.
    const _normW = (t) => (t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const _composerNames = [_normW(composerRaw || artist), _normW(composerLast)].filter(Boolean);
    const _isBio = (t) => _composerNames.includes(_normW(t));
    const _workWords = _normW(work).split(/\s+/).filter(w => w.length >= 4);
    const _matchesWork = (t) => { const tl = _normW(t); return _workWords.some(w => tl.includes(w)); };
    const bestPage = pages.find(p => !_isBio(p.title) && _matchesWork(p.title))
                  || pages.find(p => !_isBio(p.title))
                  || pages[0];
    const pageTitle = bestPage.title;

    // 2. Parse HTML
    const pUrl = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(pageTitle)}&prop=text&format=json&origin=*`;
    const pData = await httpsGet(pUrl);
    const html = pData?.parse?.text?.['*'] || '';
    if (!html) return null;

    // Extracteur générique d'année depuis un champ infobox.
    function _extractYear(fieldName) {
      const re = new RegExp(`<th[^>]*>\\s*${fieldName}[^<]*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`, 'i');
      const m = html.match(re);
      if (!m) return null;
      const txt = m[1].replace(/<[^>]*>/g, ' ').replace(/&#?\w+;/g, ' ').trim();
      const yrs = txt.match(/\b(1[4-9][0-9]{2}|20[0-9]{2})\b/g);
      if (!yrs || !yrs.length) return null;
      const y = parseInt(yrs[0]);
      const maxY = new Date().getFullYear();
      return (y >= 1400 && y <= maxY) ? y : null;
    }

    // 3. PRIORITÉ : champs d'œuvre (date historique = autorité immuable)
    const _historicalFields = ['Composed', 'Written', 'Premiered', 'Performed'];
    for (const field of _historicalFields) {
      const y = _extractYear(field);
      if (y) {
        console.log(`[meta-wiki] HISTORICAL ${field}=${y} for "${pageTitle}" (search: "${searchQuery}")`);
        return { year: y, source: `Wikipedia (${field.toLowerCase()})`, isHistorical: true };
      }
    }

    // 4. Fallback : champs d'enregistrement (intégrés au vote normal)
    for (const field of ['Recorded', 'Released']) {
      const y = _extractYear(field);
      if (y) {
        console.log(`[meta-wiki] RECORDING ${field}=${y} for "${pageTitle}" (search: "${searchQuery}")`);
        return { year: y, source: `Wikipedia (${field.toLowerCase()})`, isHistorical: false };
      }
    }

    // 5. Fallback PROSE : beaucoup d'articles d'œuvres n'ont PAS d'infobox
    //    (ex. « Holberg Suite »). On cherche l'année de composition dans le
    //    texte d'intro, ANCRÉE sur un verbe de composition pour éviter de
    //    capter une date parasite (ex. naissance de Holberg 1684 vs 1884).
    const _plain = html.replace(/<style[\s\S]*?<\/style>/gi, ' ')
                       .replace(/<[^>]*>/g, ' ')
                       .replace(/&#?\w+;/g, ' ')
                       .replace(/\s+/g, ' ')
                       .slice(0, 2500);
    const _proseRe = /\b(?:composed|written|premiered|first performed|date of composition)\b[^.!?]{0,120}?\b(1[4-9][0-9]{2}|20[0-9]{2})\b/i;
    const _pm = _plain.match(_proseRe);
    if (_pm) {
      const y = parseInt(_pm[1]);
      if (y >= 1400 && y <= new Date().getFullYear()) {
        console.log(`[meta-wiki] PROSE composed=${y} for "${pageTitle}" (search: "${searchQuery}")`);
        return { year: y, source: 'Wikipedia (composed)', isHistorical: true };
      }
    }

    return null;
  } catch (e) {
    console.warn('[meta-wiki] error:', e.message);
    return null;
  }
}



function isJunkGenreMain(g){
  if(!g) return true;
  const n = String(g).trim().toLowerCase();
  return !n || _JUNK_GENRES_MAIN.has(n) || /^\d+$/.test(n);
}

// ── QUERY NORMALIZATION ─────────────────────────────────────
// Strip common annotations that throw off MB/Discogs title matching.
// Examples removed:
//   "(Live in der Stadthalle Wuppertal)"  → ""
//   "(Remastered 2019)"                    → ""
//   "(Deluxe Edition)"                     → ""
//   "(Bonus Track Version)"                → ""
//   trailing "_", "?", "!"                 → ""
// ══════════════════════════════════════════════════════════════════════
// C214 — MOTEUR DE SIMILARITÉ (fondation du score de confiance)
// ══════════════════════════════════════════════════════════════════════
// Normalisation Unicode NFKD : « éxitos » = « exitos », « Bahía » = « Bahia »,
// « Kjarkas » = « Kjärkas ». Indispensable au catalogue latino/andin, où les
// bases occidentales stockent l'accentuation de façon erratique.
function _simNorm(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')     // dépose les diacritiques
    .toLowerCase()
    .replace(/\b(remaster(ed)?|deluxe|expanded|edition|version|anniversary|mono|stereo|bonus|explicit)\b/g, ' ')
    .replace(/\b(cd|disc|disk|disque)\s*\d+\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')        // ponctuation, &, tirets…
    .replace(/\s+/g, ' ')
    .trim();
}

// Jaro-Winkler : tolère fautes de frappe et variantes d'orthographe.
function _jaroWinkler(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const win = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array(a.length).fill(false);
  const bm = new Array(b.length).fill(false);
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - win), hi = Math.min(b.length, i + win + 1);
    for (let j = lo; j < hi; j++) {
      if (!bm[j] && a[i] === b[j]) { am[i] = true; bm[j] = true; m++; break; }
    }
  }
  if (!m) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = ((m / a.length) + (m / b.length) + ((m - t / 2) / m)) / 3;
  let p = 0;
  while (p < 4 && p < a.length && p < b.length && a[p] === b[p]) p++;
  return jaro + p * 0.1 * (1 - jaro);
}

// Similarité par ENSEMBLE DE MOTS : insensible à l'ORDRE. C'est elle qui donne
// 1.0 à « Brownie McGhee & Sonny Terry » vs « Sonny Terry & Brownie McGhee »,
// là où Jaro-Winkler, positionnel, s'effondre sur une inversion de duo.
function _tokenSim(a, b) {
  const ta = new Set(a.split(' ').filter(w => w.length > 1));
  const tb = new Set(b.split(' ').filter(w => w.length > 1));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  // Recouvrement (et non Jaccard) : un titre plus long ne pénalise pas d'emblée.
  const cover = inter / Math.min(ta.size, tb.size);
  // MAIS un ensemble très déséquilibré est suspect : « Gong » est intégralement
  // contenu dans « Gong Under » sans être le même artiste. On amortit d'autant
  // plus que les deux ensembles sont de tailles éloignées.
  const ratio = Math.min(ta.size, tb.size) / Math.max(ta.size, tb.size);
  return cover * (0.5 + 0.5 * ratio);
}

// Le meilleur des deux signaux : l'un couvre l'ordre, l'autre l'orthographe.
function _similarity(a, b) {
  const na = _simNorm(a), nb = _simNorm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  return Math.max(_tokenSim(na, nb), _jaroWinkler(na, nb));
}

// QUALITÉ DU MATCH d'une source : à quel point l'artiste et l'album qu'elle a
// RÉELLEMENT trouvés (C206) collent aux tags locaux. 0 = hors sujet, 1 = exact.
// C'est le facteur qui pondérera sa voix dans le score de confiance (C215).
function _matchQuality(localArtist, localAlbum, res) {
  if (!res) return 0;
  const sa = res.artist ? _similarity(localArtist, res.artist) : null;
  const sb = res.album  ? _similarity(localAlbum,  res.album)  : null;
  // Moyenne géométrique : les DEUX doivent tenir. Un artiste parfait avec un
  // album hors sujet ne doit pas produire un score moyen rassurant.
  if (sa !== null && sb !== null) return Math.sqrt(sa * sb);
  if (sb !== null) return sb * 0.9;   // album seul corroboré → légère décote
  if (sa !== null) return sa * 0.7;   // artiste seul → décote plus forte
  return 0.5;                          // source muette sur l'identité (Wikipédia, Last.fm) → neutre
}

function normalizeAlbumName(name){
  if(!name) return '';
  let s = String(name);
  // C192 : album ENTIÈREMENT entre crochets (« [The House That Dirt Built] »,
  // « [Riot Act] (JP RETAIL) ») — déballer AVANT tout : les crochets laissés
  // tels quels sont interprétés par Lucene (MusicBrainz) comme une range
  // query → zéro résultat → année jamais trouvée par l'auto.
  const _fb = s.match(/^\s*\[(.+)\]\s*(\([^)]*\))?\s*$/s);
  if (_fb && _fb[1].trim()) s = _fb[1].trim();
  // Strip parenthesized re-issue / live / version annotations
  s = s.replace(/\s*[\(\[]\s*(remaster(ed|isation)?(\s*\d{4})?|deluxe(\s*edition)?|special(\s*edition)?|expanded(\s*edition)?|anniversary(\s*edition)?|bonus(\s*track(\s*version)?)?|live(\s+(in|at|from|on)\s+[^\)\]]+)?|extended(\s+(version|cut|mix))?|director'?s\s*cut|original(\s+(motion\s+picture\s+)?soundtrack|\s+score)?)\s*[\)\]]/gi, '');
 // Répare le "_" SÉPARATEUR d'import : "ABBA Gold_ Greatest" → "ABBA Gold Greatest",
  // "AC_DC" → "AC DC". Le "_" entouré ou suivi d'espace/fin vient d'un import qui a
  // remplacé un ":" ou "/" → on le rend espace (meilleur matching MB/iTunes/Wikipedia).
  s = s.replace(/_+/g, ' ');
  // Strip trailing weird punctuation that came from filenames (e.g. "Brasileiro_")
  s = s.replace(/[\s\-?!.]+$/, '');
  // C199 : marqueur de DISQUE PHYSIQUE en fin de nom (« … Cd 2 », « … Disc 1 »,
  // « … - Disque 2 ») — jamais dans le titre canonique du release group MB.
  // On ne touche PAS à « Vol. 2 » (peut faire partie du vrai titre).
  s = s.replace(/\s*[-–—:]?\s*\b(cd|disc|disk|disque)\s*[-.]?\s*\d+\b\s*$/i, '');
  // Collapse double spaces
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

// Strip "feat. X" / "ft. X" / "with X" — keeps the primary artist for matching.
// Conservative: only known patterns, keeps the rest as-is.
function normalizeArtistName(name){
  if(!name) return '';
  let s = String(name);
  // "Artist feat. Other" / "Artist ft Other" / "Artist (feat. Other)"
  s = s.replace(/\s*[\(\[]?\s*(feat\.?|ft\.?|featuring|with)\s+[^\)\]]+[\)\]]?/gi, '');
 // Répare le "_" séparateur d'import (ex. "AC_DC" → "AC DC") pour le matching.
  s = s.replace(/_+/g, ' ').replace(/\s{2,}/g, ' ');
  // Trailing connectors
  s = s.replace(/\s*[,&]\s*$/, '');
  return s.trim();
}

// ════════════════════════════════════════════════════════════════════════
// HELPERS CONSOLIDATION PAR CHAMP — étape C chat 6 (port renderer → main)
// ────────────────────────────────────────────────────────────────────────
// Réutilisés à l'intérieur de fetchMetadataMultiSource pour produire un
// pool rawByField + des champs consolidés (year/genre/artist/album) avec
// règles trust dédiées. Préfixe _mainXxx pour éviter collision si on
// exposait un jour les mêmes noms côté preload.
// ════════════════════════════════════════════════════════════════════════

// Détection compositeur via marqueurs univoques (K./BWV/D./Hob.).
// Op. exclu (ambigu Beethoven/Chopin/Brahms).
function _mainDetectComposerFromMarkers(title, album) {
  const text = ((title || '') + ' ' + (album || '')).toLowerCase();
  if (/\bk\.?\s*\d{2,4}\b/.test(text))   return 'Mozart';
  if (/\bbwv\s*\d{1,4}\b/.test(text))    return 'Bach';
  if (/\bhob\.?[\s\w]*\d+\b/.test(text)) return 'Haydn';
  if (/\bd\.?\s*\d{3,4}\b/.test(text) && /\bschubert\b/i.test(text)) return 'Schubert';
  return null;
}

function _mainTagArtistAbsentFromPool(tagArtist, artistCands, composer) {
  const tag = (tagArtist || '').toLowerCase().trim();
  if (!tag) return true;
  if (tag === composer.toLowerCase() || tag.includes(composer.toLowerCase())) return false;
  for (const a of artistCands) {
    const v = (a.value || '').toLowerCase().trim();
    if (!v) continue;
    if (v === tag || v.includes(tag) || tag.includes(v)) return false;
  }
  return true;
}

function _mainFindYearCluster(candidates) {
  if (!candidates.length) return null;
  const years = candidates.map(c => parseInt(c.value)).filter(y => y >= 1400 && y <= new Date().getFullYear());
  if (!years.length) return null;
  let best = null;
  for (const y of years) {
    const members = candidates.filter(c => {
      const v = parseInt(c.value);
      return v >= 1400 && Math.abs(v - y) <= 1;
    });
    if (!best || members.length > best.members.length) best = { value: y, members };
  }
  return best;
}

function _mainConsolidateYear(candidates, localYear) {
  const localY = localYear ? parseInt(localYear) : null;
  const out = { value: localY, source: localY ? 'local-tag' : null, trusted: false, candidates: [...candidates] };
  if (!candidates.length) return out;

  // 1. Wikipedia work-source : plus ancienne gagne (philosophie composition > réédition).
  const wikis = candidates.filter(c => /Wikipedia/i.test(c.source || '') && parseInt(c.value) >= 1400);
  if (wikis.length) {
    const oldestWiki = wikis.sort((a, b) => parseInt(a.value) - parseInt(b.value))[0];
    out.value = parseInt(oldestWiki.value);
    out.source = wikis.length > 1 ? `${oldestWiki.source} (oldest of ${wikis.length} wiki)` : oldestWiki.source;
    out.trusted = true;
    return out;
  }
  // 2. Cluster ±1 an ≥3 membres → plus ancienne du cluster.
  const cluster = _mainFindYearCluster(candidates);
  if (cluster && cluster.members.length >= 3) {
    const oldest = Math.min(...cluster.members.map(m => parseInt(m.value)));
    out.value = oldest;
    out.source = `convergence (${cluster.members.length} sources ±1 an, plus ancienne)`;
    out.trusted = true;
    return out;
  }
  // 3. Aucune autorité → plus ancienne année cohérente, non-trusted.
  const sorted = candidates
    .filter(c => c.value && parseInt(c.value) >= 1400)
    .sort((a, b) => parseInt(a.value) - parseInt(b.value));
  if (sorted.length > 0) {
    out.value = parseInt(sorted[0].value);
    out.source = `${sorted[0].source} (oldest of ${sorted.length})`;
    out.trusted = false;
  }
  return out;
}

function _mainConsolidateGenre(candidates, localGenre) {
  const out = { value: localGenre || null, source: localGenre ? 'local-tag' : null, trusted: false, candidates: [...candidates] };
  if (!candidates.length) return out;
  // 1. MusicBrainz (éditorial) → trusted direct.
  const mb = candidates.find(c => /MusicBrainz|^mb$|^mbrg$/i.test(c.source || ''));
  if (mb) {
    out.value = mb.value;
    out.source = mb.source;
    out.trusted = true;
    return out;
  }
  // 2. Convergence ≥2 sources sur même bucket.
  const counts = new Map();
  for (const c of candidates) {
    if (!c.value) continue;
    counts.set(c.value, (counts.get(c.value) || 0) + 1);
  }
  let best = null, bestCount = 0;
  for (const [g, n] of counts) {
    if (n > bestCount) { best = g; bestCount = n; }
  }
  if (best && bestCount >= 2) {
    out.value = best;
    out.source = `convergence (${bestCount} sources)`;
    out.trusted = true;
    return out;
  }
  out.value = candidates[0].value;
  out.source = candidates[0].source;
  out.trusted = false;
  return out;
}

function _mainConsolidateArtist(candidates, tagArtist, composerFromPass2) {
  const out = { value: tagArtist || null, source: tagArtist ? 'local-tag' : null, trusted: false, candidates: [...candidates] };
  if (!candidates.length) return out;
  const counts = new Map();
  for (const c of candidates) {
    const k = (c.value || '').toLowerCase().trim();
    if (!k) continue;
    if (!counts.has(k)) counts.set(k, { count: 0, original: c.value, sources: [] });
    const entry = counts.get(k);
    entry.count++;
    entry.sources.push(c.source);
  }
  let top = null;
  for (const [, v] of counts) {
    if (!top || v.count > top.count) top = v;
  }
  if (!top) return out;
  const tagLower = (tagArtist || '').toLowerCase().trim();
  const topLower = top.original.toLowerCase().trim();
  const tagMatches = tagLower && (tagLower === topLower || tagLower.includes(topLower) || topLower.includes(tagLower));
  if (tagMatches && top.count >= 2) {
    out.value = top.original;
    out.source = `consensus ×${top.count}`;
    out.trusted = true;
    return out;
  }
  if (composerFromPass2) {
    out.value = top.original;
    out.source = `compositeur déduit (×${top.count})`;
    out.trusted = false;
    return out;
  }
  out.value = top.original;
  out.source = `consensus ×${top.count} (tag local mismatch)`;
  out.trusted = false;
  return out;
}

// ════════════════════════════════════════════════════════════════════════

// ── WIKIDATA : genre de DERNIER RECOURS ──────────────────────────────
// Déclenchée UNIQUEMENT si aucune source (votes + Wikipedia) n'a donné de
// genre. Lit P136 (genre musical) de l'entité artiste (à défaut album),
// résout les Q-ids en libellés EN, puis mappe vers un bucket parent.
// Retour : libellé bucket (même vocabulaire que fetchFromWikipediaEnhanced)
// ou null. Réseau : 2-3 appels JSON max, throttlés au niveau album.
// ⚠️ Garder le mini-dictionnaire cohérent avec fetchFromWikipediaEnhanced.
async function fetchFromWikidata(artist, album) {
  if (!artist && !album) return null;
  const WD = 'https://www.wikidata.org/w/api.php';
  const mapLabel = (label) => {
    const t = String(label || '').toLowerCase();
    const M = {
      'blues':'Blues, Roots & Gospel','gospel':'Blues, Roots & Gospel',
      'jazz':'Jazz & Swing','swing':'Jazz & Swing',
      'soul':'Soul, Funk & Disco','funk':'Soul, Funk & Disco','disco':'Soul, Funk & Disco',
      'hard rock':'Classic Rock & Hard Rock','rock':'Classic Rock & Hard Rock',
      'grunge':'Punk, Grunge & Alternative','punk':'Punk, Grunge & Alternative','alternative':'Punk, Grunge & Alternative',
      'metal':'Heavy Metal & Loud',
      'hip hop':'Hip-Hop & Rap Culture','rap':'Hip-Hop & Rap Culture',
      'rhythm and blues':'R&B, Pop & Dance','r&b':'R&B, Pop & Dance','pop':'R&B, Pop & Dance',
      'americana':'Folk, Country & Americana','country':'Folk, Country & Americana','folk':'Folk, Country & Americana',
      'new age':'Ambient, New Age & Chill','ambient':'Ambient, New Age & Chill',
      'techno':'Electronic, House & Techno','house':'Electronic, House & Techno','electronic':'Electronic, House & Techno',
      'reggae':'Reggae, Dub & Ska','dub':'Reggae, Dub & Ska','ska':'Reggae, Dub & Ska',
      'salsa':'Latin, Caribbean, Flamenco, Tango','latin':'Latin, Caribbean, Flamenco, Tango',
      'afrobeat':'Afrobeat, African & World','african':'Afrobeat, African & World',
      'opera':'Classical & Opera','classical':'Classical & Opera',
      'film score':'Soundtrack & Score','soundtrack':'Soundtrack & Score'
    };
    for (const [kw, bucket] of Object.entries(M)) { if (t.includes(kw)) return bucket; }
    return null;
  };
  try {
    // Garde-fou : on ne retient un résultat que si sa DESCRIPTION Wikidata
    // est manifestement musicale (artiste/groupe/œuvre). Sinon un titre
    // d'album générique (« How », « Back », « Saudade ») matcherait un
    // homonyme sans rapport et collerait un faux genre. On cherche par
    // ARTISTE uniquement (clé sémantiquement correcte pour le genre).
    const MUSIC_RE = /\b(musician|singer|songwriter|composer|rapper|band|duo|musical group|musical ensemble|rock group|girl group|boy band|orchestra|choir|disc jockey|dj|record producer|guitarist|pianist|drummer|bassist|violinist|vocalist|music|album|song|single|extended play|soundtrack)\b/i;
    const findEntity = async (term) => {
      if (!term) return null;
      const u = `${WD}?action=wbsearchentities&search=${encodeURIComponent(term)}&language=en&uselang=en&type=item&limit=5&format=json`;
      const d = await httpsGet(u).catch(() => null);
      const arr = (d && Array.isArray(d.search)) ? d.search : [];
      const hit = arr.find(h => h && h.id && MUSIC_RE.test(String(h.description || '')));
      return hit ? hit.id : null;
    };
    const qid = await findEntity(artist);
    if (!qid) return null;
    const claimsUrl = `${WD}?action=wbgetentities&ids=${qid}&props=claims&format=json`;
    const cd = await httpsGet(claimsUrl).catch(() => null);
    const claims = cd && cd.entities && cd.entities[qid] && cd.entities[qid].claims;
    const p136 = claims && claims.P136;
    if (!Array.isArray(p136) || !p136.length) return null;
    const genreIds = p136
      .map(s => s && s.mainsnak && s.mainsnak.datavalue && s.mainsnak.datavalue.value && s.mainsnak.datavalue.value.id)
      .filter(Boolean)
      .slice(0, 6);
    if (!genreIds.length) return null;
    const labelsUrl = `${WD}?action=wbgetentities&ids=${genreIds.join('|')}&props=labels&languages=en&format=json`;
    const ld = await httpsGet(labelsUrl).catch(() => null);
    const ents = ld && ld.entities;
    if (!ents) return null;
    for (const gid of genreIds) {
      const lbl = ents[gid] && ents[gid].labels && ents[gid].labels.en && ents[gid].labels.en.value;
      const bucket = mapLabel(lbl);
      if (bucket) { console.log(`[meta] Wikidata genre → ${bucket} (via ${lbl || gid})`); return bucket; }
    }
    return null;
  } catch (e) { return null; }
}

async function fetchMetadataMultiSource(album, artist, ctx = {}) {
  // Normalize the search inputs (strip "(Live in...)", "feat. X", etc.) so MB/Discogs find matches.
  // The original `album` and `artist` strings stay unchanged for cache keys + logging.
  const albumQ  = normalizeAlbumName(album);
  const artistQ = normalizeArtistName(artist);
  const wasNormalized = (albumQ !== album) || (artistQ !== artist);
  if(wasNormalized){
    console.log(`[meta] normalized "${artist} - ${album}" → "${artistQ} - ${albumQ}"`);
  }

  // Parallèle : 4 sources "album" rapides (MB + Discogs + Deezer + iTunes).
  // First pass uses the normalized strings.
 // MB-RG d'ABORD, seul (source primaire pour l'année). Évite que les 2 appels
  // MusicBrainz simultanés (RG + Enhanced) se rate-limitent mutuellement (503 →
  // retry → timeout → null). On lui laisse la voie libre.
  const _mbrgFirst = await fetchFromMusicBrainzReleaseGroup(albumQ, artistQ)
    .catch(() => ({ genre: null, year: null, trusted: false, source: 'mb-rg' }));
  // Petite pause pour respecter la limite MusicBrainz avant le prochain appel MB.
  await new Promise(r => setTimeout(r, 1100));
  const firstPass = await Promise.allSettled([
    fetchFromMusicBrainzEnhanced(albumQ, artistQ),
    fetchFromDiscogsPublic(artistQ, albumQ),
    fetchFromDeezer(albumQ, artistQ),
    fetchFromItunes(artistQ, albumQ),
    Promise.resolve(_mbrgFirst),  // MB-RG déjà résolu, garde la position [4]
    fetchFromLastfm(artistQ, albumQ)   // [5] Last.fm — sous-genres
  ]);
  let results = firstPass.map(s => s.status === 'fulfilled' ? s.value : { genre: null, year: null, trusted: false });

  // If first pass found nothing AND we did normalize, try once more with the originals
  // (some edge cases — "Live at Carnegie Hall" IS the actual album title in MB).
  const totallyEmpty = results.every(r => !r.genre && !r.year);
  if(totallyEmpty && wasNormalized){
    console.log(`[meta] first pass empty for normalized inputs, retrying with originals`);
    const secondPass = await Promise.allSettled([
      fetchFromMusicBrainzEnhanced(album, artist),
      fetchFromDiscogsPublic(artist, album),
      fetchFromDeezer(album, artist),
      fetchFromItunes(artist, album),
      fetchFromMusicBrainzReleaseGroup(album, artist)
    ]);
    results = secondPass.map(s => s.status === 'fulfilled' ? s.value : { genre: null, year: null, trusted: false });
  }

  // C205 : DERNIER REPLI — tout est encore vide alors qu'un album est fourni.
  // L'artiste est souvent le coupable (ordre d'un duo inversé, orthographe,
  // crédit « & » vs « and », nom de groupe vs solo). On relance SANS artiste :
  // le titre d'album suffit à identifier l'œuvre, et le sanity-check en aval
  // (wordOverlap artiste/album) reste là pour refuser un homonyme.
  const _stillEmpty = results.every(r => !r.genre && !r.year);
  if (_stillEmpty && albumQ && artistQ) {
    console.log(`[meta] tout vide avec artiste → repli album seul : "${albumQ}"`);
    const thirdPass = await Promise.allSettled([
      fetchFromMusicBrainzEnhanced(albumQ, ''),
      fetchFromDiscogsPublic('', albumQ),
      fetchFromDeezer(albumQ, ''),
      fetchFromItunes('', albumQ),
      fetchFromMusicBrainzReleaseGroup(albumQ, ''),
      fetchFromLastfm('', albumQ)
    ]);
    const _r3 = thirdPass.map(s => s.status === 'fulfilled' ? s.value : { genre: null, year: null, trusted: false });
    if (!_r3.every(r => !r.genre && !r.year)) {
      console.log(`[meta] repli album seul : résultats trouvés`);
      results = _r3;
    }
  }

  const [mb, dg, dz, it, mbrg, lf] = results;

  // ── ANNÉE : CONVERGENCE D'ABORD, CASCADE ENSUITE ──
  //
  // Refonte session 5 — stratégie en 3 étapes :
  //   1. CONVERGENCE : si ≥ 3 sources distinctes (sur 5) s'accordent dans une
  //      fenêtre ±1 an, on signe à min(cluster). Trusted. Le min applique
  //      mécaniquement « composition > réédition ». Cette voie court-circuite
  //      la cascade : la convergence statistique l'emporte sur l'ordre des
  //      sources, ce qui neutralise les faux positifs MB-RG isolés.
  //   2. CASCADE : si pas de convergence, on retombe sur l'ordre durci
  //      classique (MB-RG > MB > Discogs > low-trusts). iTunes/Deezer ne
  //      décident jamais seuls (= dates digitales, pas enregistrement).
  //   3. SANITY-CHECK BIDIRECTIONNEL : si on a signé via cascade et que les
  //      autres sources convergent ailleurs (>10 ans d'écart), dégradation
  //      en low-trust (revue). Couvre les deux sens : MB-RG plus récent OU
  //      plus ancien que la convergence des autres = suspect.

  let year = null;
  let yearSource = null;

  // Candidats année avec leur source. L'ordre du tableau ne compte pas
  // (la décision se fait par clustering). iTunes/Deezer sont inclus dans le
  // vote de convergence (un store digital qui confirme MB/Discogs est un
  // signal positif), mais ne peuvent toujours pas trancher seuls — voir
  // étape 2 cascade.
  const _yearCandidates = [
    { y: _parseYearStrict(String(mbrg?.year || '')), src: 'mbrg', trusted: !!mbrg?.trusted },
    { y: _parseYearStrict(String(mb?.year   || '')), src: 'mb',   trusted: !!mb?.trusted   },
    { y: _parseYearStrict(String(dg?.year   || '')), src: 'dg',   trusted: !!dg?.trusted   },
    { y: _parseYearStrict(String(it?.year   || '')), src: 'it',   trusted: false },
    { y: _parseYearStrict(String(dz?.year   || '')), src: 'dz',   trusted: false },
  ].filter(c => c.y !== null);

  // Cherche le cluster maximal : pour chaque candidat, compte combien d'autres
  // tombent dans ±1 an autour de lui. Le gagnant maximise le nb de sources
  // distinctes ; à égalité, l'année la plus ANCIENNE prime (philosophie produit).
  function _findCluster(cands) {
    let best = null;
    for (const c of cands) {
      const members = cands.filter(o => Math.abs(o.y - c.y) <= 1);
      const sources = new Set(members.map(m => m.src));
      const minYear = members.reduce((m, x) => x.y < m ? x.y : m, c.y);
      const entry = { sources, minYear, anchor: c.y };
      if (!best ||
          entry.sources.size > best.sources.size ||
          (entry.sources.size === best.sources.size && entry.minYear < best.minYear)) {
        best = entry;
      }
    }
    return best;
  }
  const _cluster = _yearCandidates.length ? _findCluster(_yearCandidates) : null;

  // 1. CONVERGENCE — ≥ 3 sources distinctes alignées → on signe à min(cluster).
  if (_cluster && _cluster.sources.size >= 3) {
    year = _cluster.minYear;
    const _members = [..._cluster.sources].sort().join('+');
    yearSource = `Converge-${_cluster.sources.size}/5 (${_members})`;
    console.log(`[meta] convergence: ${_cluster.sources.size} sources ~${_cluster.anchor} (${_members}) → ${year}`);
  }

  // 2. CASCADE — pas de convergence, retombe sur l'ordre durci classique.
  //    MB-RG d'abord (immune rééditions), même low-trust, puis MB/Discogs,
  //    puis low-trusts. iTunes/Deezer JAMAIS seuls.
  if (!year) {
    if      (mbrg?.year && mbrg.trusted) { year = mbrg.year; yearSource = 'MusicBrainz-RG'; }
    else if (mbrg?.year)                 { year = mbrg.year; yearSource = 'MusicBrainz-RG (low trust)'; }
    else if (mb?.year && mb.trusted)     { year = mb.year;   yearSource = 'MusicBrainz'; }
    else if (dg?.year && dg.trusted)     { year = dg.year;   yearSource = 'Discogs'; }
    else if (mb?.year)                   { year = mb.year;   yearSource = 'MusicBrainz (low trust)'; }
    else if (dg?.year)                   { year = dg.year;   yearSource = 'Discogs (low trust)'; }
  }

  // 3. SANITY-CHECK BIDIRECTIONNEL — uniquement si on a signé via cascade
  //    (pas via convergence : la convergence valide déjà mécaniquement).
  //    On forme le cluster majoritaire des AUTRES sources (exclut la source
  //    choisie). Si écart > 10 ans dans n'importe quel sens, dégradation.
  const _isConverged = !!(yearSource && yearSource.startsWith('Converge-'));
  const _isLowTrust  = !!(yearSource && yearSource.includes('low'));
  if (year && !_isConverged && !_isLowTrust) {
    const _chosenSrc = yearSource?.startsWith('MusicBrainz-RG') ? 'mbrg'
                    :  yearSource?.startsWith('MusicBrainz')    ? 'mb'
                    :  yearSource?.startsWith('Discogs')        ? 'dg'
                    :  null;
    const _others = _yearCandidates.filter(c => c.src !== _chosenSrc);
    const _otherCluster = _others.length ? _findCluster(_others) : null;
    if (_otherCluster && _otherCluster.sources.size >= 2) {
      const gap = year - _otherCluster.minYear;
      if (gap > 10) {
        // Choisi PLUS RÉCENT que ≥2 autres sources = réédition probable → on FORCE
        // l'année d'origine (la plus ancienne du cluster). L'original prime toujours.
        console.log(`[meta] réédition détectée: ${yearSource}=${year} mais ${_otherCluster.sources.size} sources ~${_otherCluster.minYear} → forcé à ${_otherCluster.minYear}`);
        year = _otherCluster.minYear;
        yearSource = yearSource + ` → ${_otherCluster.minYear} (corrigé convergence)`;
      } else if (gap < -10) {
        // Choisi plus ANCIEN que le cluster : on garde (l'ancien prime) mais on
        // dégrade en revue par prudence (peut être une erreur "trop vieille").
        console.log(`[meta] sanity-check: ${yearSource}=${year} mais ${_otherCluster.sources.size} autres ~${_otherCluster.minYear} (plus ancien de ${Math.abs(gap)} ans) → dégradé en revue`);
        yearSource = yearSource + ' (low trust)';
      }
    }
  }
  
  // Heuristique : si l'album contient "Live" ou "Best of", on est plus prudent
  if (year && album) {
    const albumLower = album.toLowerCase();
    if (albumLower.includes('live') || albumLower.includes('best of') || 
        albumLower.includes('greatest hits') || albumLower.includes('anthology')) {
      // Pour les lives/compils, l'année peut être correcte (date du concert/compilation)
      // On garde mais on loggue
      console.log(`[meta] ${album} is compilation/live, keeping year ${year} (${yearSource})`);
    }
  }
  
  // Fallback : si aucune année trouvée et que l'artiste a un override, on garde null
  if (!year && ctx.hasOverride) {
    console.log(`[meta] No reliable year for ${artist} - ${album}, using null`);
  }

  // ── GENRE ── (inchangé, toujours bon)
  const votes = new Map();
  function pushVote(g, w) {
    if (!g) return;
    votes.set(g, (votes.get(g) || 0) + w);
  }
  pushVote(mbrg?.genre, mbrg?.trusted ? 4 : 3);
  pushVote(mb?.genre, mb?.trusted ? 4 : 3);
  pushVote(dg?.genre, dg?.trusted ? 4 : 3);
  pushVote(it?.genre, 1);  // iTunes genre peu fiable
  pushVote(dz?.genre, 1);  // Deezer genre peu fiable
  
  let genre = null;
  if (votes.size) {
    const sorted = [...votes.entries()].sort((a,b) => b[1] - a[1]);
    genre = sorted[0][0];
  }

  // Fallback Wikipedia
  if (!genre && (artist || album)) {
    const wikiGenre = await fetchFromWikipediaEnhanced(artist, album);
    if (wikiGenre) genre = wikiGenre;
  }

  // Dernier recours : Wikidata (P136) si toujours aucun genre.
  if (!genre && (artist || album)) {
    try {
      const wdGenre = await fetchFromWikidata(artist, album);
      if (wdGenre) genre = wdGenre;
    } catch (e) { /* Wikidata optionnel */ }
  }

  // (2e bloc Wikidata retiré : doublon de l'appel ci-dessus, et il attendait un
  // objet .genre alors que fetchFromWikidata renvoie désormais un libellé string.)

  // ── WIKIPEDIA : œuvre historique OU enregistrement ──
  // Refonte session 5 : remplace l'ancien Wikipedia composé strict (limité au
  // classique avec marqueur fort). La nouvelle fonction fetchWikipediaWork
  // distingue deux types de résultats selon l'infobox :
  //   • Date HISTORIQUE (Composed/Written/Premiered/Performed) → autorité ultime
  //     sur la composition, immune aux rééditions. ÉCRASE le résultat actuel
  //     si elle est nettement plus ancienne (gap ≥ 20 ans). Reste TRUSTED.
  //     Couvre Mozart Don Giovanni → 1787 même si MB/Discogs/iTunes disent 1982.
  //   • Date d'ENREGISTREMENT (Recorded/Released) → info-only pour l'instant
  //     (Phase 2.5 : intégration au cluster de convergence en 6e source).
  let _wikiHistForRBF = null;
  try {
    const wikiWork = await fetchWikipediaWork(artist, album, ctx && ctx.title);
    if (wikiWork) {
      if (wikiWork.isHistorical) {
        // Mémorise pour propagation aux candidats du renderer (voir plus bas).
        _wikiHistForRBF = { year: wikiWork.year, source: wikiWork.source };
        if (!year || (year - wikiWork.year >= 20)) {
          console.log(`[meta] Wikipedia HISTORICAL ${wikiWork.year} (${wikiWork.source}) écrase ${year || '?'} (${yearSource || 'none'})`);
          year = wikiWork.year;
          yearSource = wikiWork.source;
        } else {
          console.log(`[meta] Wikipedia ${wikiWork.source}=${wikiWork.year} ignoré (gap < 20 ans avec ${yearSource}=${year})`);
        }
      } else {
        console.log(`[meta] Wikipedia ${wikiWork.source}=${wikiWork.year} (recording, info-only), garde ${yearSource || 'none'}=${year || '?'}`);
      }
    }
  } catch(e) { /* Wikipedia optionnel, on n'échoue jamais dessus */ }

  // Trusted = convergence multi-sources OU MB/Discogs (non-low) OU Wikipedia historique.
  // Calculé APRÈS le bloc Wikipedia pour refléter une éventuelle écriture historique.
  const _wikiHistoricalRe = /^Wikipedia \((composed|written|premiered|performed)\)$/;
  const yearTrusted = !!(yearSource && (
    yearSource.startsWith('Converge-') ||
    _wikiHistoricalRe.test(yearSource) ||
    ((yearSource.startsWith('MusicBrainz') || yearSource.startsWith('Discogs')) && !yearSource.includes('low'))
  ));

  // Consensus signals — expose so renderer can decide whether to overwrite existing tags.
  // High-confidence flag: both trusted sources agreed, OR an artist override forced the value.
  const genreTrusted = !!((mb?.trusted && mb?.genre === genre) && (dg?.trusted && dg?.genre === genre)) ||
                       !!ctx.hasOverride;
 console.log(`[meta] ${artist} - ${album} → year: ${year || '?'} (${yearSource || 'none'}, trusted=${yearTrusted}), genre: ${genre || '?'} (trusted=${genreTrusted})`);
  // DEBUG TEMPORAIRE : expose le détail des sources pour diagnostic côté renderer.
  // ────────────────────────────────────────────────────────────────────
  // Étape C chat 6 : construction rawByField + consolidation par champ.
  // Le retour legacy { genre, year, yearTrusted, genreTrusted } reste
  // intact ; on ajoute rawByField + artist consolidé + composerDeduced
  // pour alimenter la modale revue future et la passe 2 batch.
  // ────────────────────────────────────────────────────────────────────
  const _rawByField = { year: [], genre: [], artist: [], album: [], cover: [] };
  // C214 : QUALITÉ DU MATCH par source — à quel point l'artiste/album qu'elle a
  // réellement trouvé (C206) colle aux tags locaux. Calculé UNE fois par source,
  // puis attaché à chacun de ses candidats : c'est la pondération du score de
  // confiance côté renderer (C215). Une source hors sujet pèse zéro.
  const _q = new Map();
  for (const [src, raw] of [['MusicBrainz-RG', mbrg], ['MusicBrainz', mb], ['Discogs', dg], ['iTunes', it], ['Deezer', dz], ['Last.fm', lf]]) {
    _q.set(src, _matchQuality(artist || '', album || '', raw));
  }
  console.log(`[match] « ${artist || '?'} — ${album || '?'} » : ` +
    [..._q.entries()].filter(([, v]) => v > 0).map(([s, v]) => `${s} ${v.toFixed(2)}`).join(' · '));
  // Year candidates (parsed strict, ≥1400)
  for (const [src, raw] of [['MusicBrainz-RG', mbrg], ['MusicBrainz', mb], ['Discogs', dg], ['iTunes', it], ['Deezer', dz]]) {
    const y = _parseYearStrict(String(raw?.year || ''));
    if (y) _rawByField.year.push({ value: y, source: src, q: _q.get(src) });
  }
  // Année HISTORIQUE Wikipédia (1er passage) : sans ça elle reste dans `year`
  // legacy et le renderer (qui consolide depuis rawByField) ne la voit jamais.
  // En candidat « Wikipedia », elle bénéficie de la priorité absolue côté renderer.
  if (_wikiHistForRBF && _wikiHistForRBF.year) {
    const _wy = _parseYearStrict(String(_wikiHistForRBF.year)) || _wikiHistForRBF.year;
    if (_wy) _rawByField.year.unshift({ value: _wy, source: _wikiHistForRBF.source || 'Wikipedia (composed)' });
  }
  // Genre candidates
  for (const [src, raw] of [['MusicBrainz-RG', mbrg], ['MusicBrainz', mb], ['Discogs', dg], ['iTunes', it], ['Deezer', dz], ['Last.fm', lf]]) {
    if (raw?.genre) _rawByField.genre.push({ value: raw.genre, source: src, raw: (raw.genreRaw || raw.genre), q: _q.get(src) });
    else if (raw?.genreRaw) _rawByField.genre.push({ value: null, source: src, raw: raw.genreRaw, q: _q.get(src) });
  }
  // Artist + album candidates : on ne récupère que ce que les sources
  // exposent (la majorité ne renvoie pas artist/album bruts, on tolère).
  for (const [src, raw] of [['MusicBrainz-RG', mbrg], ['MusicBrainz', mb], ['Discogs', dg], ['iTunes', it], ['Deezer', dz]]) {
    if (raw?.artist) _rawByField.artist.push({ value: raw.artist, source: src, q: _q.get(src) });
    if (raw?.album)  _rawByField.album.push({  value: raw.album,  source: src, q: _q.get(src) });
  }
  

  // ── C212 — POCHETTES : trois sources, par ordre de fiabilité ──────────
  // 1. Cover Art Archive via le release-group DÉJÀ résolu par mb-rg. Le titre a
  //    été validé par titleMatches → la pochette est adossée à l'ENTITÉ
  //    MusicBrainz, pas à une correspondance de noms. C'est la seule qui
  //    fonctionne sur les COMPILATIONS. Aucune requête MusicBrainz en plus.
  if (mbrg && mbrg.rgid) {
    try {
      const _caaRg = await fetchCaaByRgid(mbrg.rgid, mbrg.album || album, mbrg.artist || artist, mbrg.year);
      if (_caaRg && _caaRg.url) _rawByField.cover.push(_caaRg);
    } catch (e) { /* pas de cover = pas de cover */ }
  }

  // 2. Pochettes iTunes / Deezer. Elles étaient CONSTRUITES par les fetchers
  //    (url + album + artiste + qualité) puis JAMAIS lues : aucune référence à
  //    `.covers` n'existait dans ce fichier — pur code mort. On les branche.
  //    Aucun risque d'homonyme : _consolidateCover (renderer) ne retient que les
  //    candidats dont l'album matche le tag local.
  for (const _cs of [it, dz]) {
    for (const _c of (_cs && _cs.covers) || []) {
      if (_c && _c.url) _rawByField.cover.push(_c);
    }
  }

  // 3. Dernier recours : recherche CAA autonome (elle, refait une recherche MB) —
  //    uniquement si mb-rg n'a rien donné et qu'on n'a toujours aucune pochette.
  if (!_rawByField.cover.length && album) {
    try {
      const _caa = await fetchCoverArtForAlbum(album, artist);
      if (_caa && _caa.url) _rawByField.cover.push(_caa);
    } catch (e) { /* pas de cover = pas de cover */ }
  }

  // Round 3 — toujours rien ? dernier recours Wikipédia (FR puis EN).
  if (!_rawByField.cover.length && album) {
    try {
      const _wk = await fetchCoverWikipedia(artist, album);
      if (_wk && _wk.url) _rawByField.cover.push(_wk);
    } catch (e) { /* pas de cover = pas de cover */ }
  }

  // Passe 2 : si marqueur Köchel/BWV/D./Hob. dans album/titre ET tag artist
  // absent du pool → relance MusicBrainz Enhanced + Wikipedia avec le
  // compositeur déduit. Une seule passe max.
  const _trackTitle = ctx?.title || '';
  const _composer   = _mainDetectComposerFromMarkers(_trackTitle, album);
  let _pass2Done = false;
  if (_composer && _mainTagArtistAbsentFromPool(artist, _rawByField.artist, _composer)) {
    console.log(`[meta] PASSE 2 — compositeur déduit: ${_composer} (tag pourri: "${artist || '∅'}")`);
    try {
      const _p2Wiki = await fetchWikipediaWork(_composer, album).catch(() => null);
      if (_p2Wiki?.year) {
        _rawByField.year.push({ value: _parseYearStrict(String(_p2Wiki.year)), source: 'Wikipedia-pass2' });
      }
      if (_p2Wiki?.genre) {
        _rawByField.genre.push({ value: _p2Wiki.genre, source: 'Wikipedia-pass2' });
      }
      _rawByField.artist.push({ value: _composer, source: 'composer-deduced' });
      _pass2Done = true;
    } catch (e) {
      console.warn('[meta] passe 2 erreur:', e?.message);
    }
  }

  // Consolidation par champ (alimentera la modale revue future).
  const _consolidated = {
    year:   _mainConsolidateYear(_rawByField.year, null),
    genre:  _mainConsolidateGenre(_rawByField.genre, null),
    artist: _mainConsolidateArtist(_rawByField.artist, artist, _pass2Done ? _composer : null),
    album:  null, // pas exploité côté batch pour l'instant (le tag fichier reste autoritaire)
  };

  const _debug = {
    yearSource,
    mbrg: { year: mbrg?.year, trusted: mbrg?.trusted },
    mb:   { year: mb?.year,   trusted: mb?.trusted },
    dg:   { year: dg?.year,   trusted: dg?.trusted },
    it:   { year: it?.year },
    dz:   { year: dz?.year },
    // Étape C : exposable à la modale revue
    rawByField: _rawByField,
    consolidated: _consolidated,
    pass2Done: _pass2Done,
    composerDeduced: _pass2Done ? _composer : null,
  };
  return {
    genre, year, yearTrusted, genreTrusted,
    // Champs additionnels (rétrocompat : optionnels, le code legacy les ignore)
    artistConsolidated: _consolidated.artist?.value || null,
    artistTrusted:      _consolidated.artist?.trusted || false,
    composerDeduced:    _pass2Done ? _composer : null,
    rawByField:         _rawByField,
    _debug
  };
}
// ============================================================
// 9. OVERRIDES ARTISTES (CORRECTIONS MANUELLES - MODIFIABLES)
// ============================================================
// Ces overrides corrigent les erreurs des API.
// L'utilisateur peut les modifier dans prefs.json s'il le souhaite.
// ============================================================

function normArtist(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}

// Overrides par défaut (chargés depuis prefs si existants)
let ARTIST_GENRE_OVERRIDES = {
  // Latin, Caribbean, Flamenco, Tango
  'silvio rodriguez': 'Latin, Caribbean, Flamenco, Tango', 'pablo milanes': 'Latin, Caribbean, Flamenco, Tango',
  'victor jara': 'Latin, Caribbean, Flamenco, Tango', 'violeta parra': 'Latin, Caribbean, Flamenco, Tango',
  'mercedes sosa': 'Latin, Caribbean, Flamenco, Tango', 'buena vista social club': 'Latin, Caribbean, Flamenco, Tango',
  'compay segundo': 'Latin, Caribbean, Flamenco, Tango', 'celia cruz': 'Latin, Caribbean, Flamenco, Tango',
  'caetano veloso': 'Latin, Caribbean, Flamenco, Tango', 'gilberto gil': 'Latin, Caribbean, Flamenco, Tango',
  // Afrobeat
  'fela kuti': 'Afrobeat, African & World',
  // Reggae
  'bob marley': 'Reggae, Dub & Ska', 'jimmy cliff': 'Reggae, Dub & Ska',
  // Blues
  'b.b. king': 'Blues, Roots & Gospel', 'muddy waters': 'Blues, Roots & Gospel',
  'howlin wolf': 'Blues, Roots & Gospel', 'john lee hooker': 'Blues, Roots & Gospel',
  // Jazz
  'miles davis': 'Jazz & Swing', 'john coltrane': 'Jazz & Swing', 'billie holiday': 'Jazz & Swing',
  'ella fitzgerald': 'Jazz & Swing', 'louis armstrong': 'Jazz & Swing',
  // Soul
  'nina simone': 'Soul, Funk & Disco', 'aretha franklin': 'Soul, Funk & Disco',
  'james brown': 'Soul, Funk & Disco', 'stevie wonder': 'Soul, Funk & Disco'
};

// Charger les overrides depuis les préférences (permet à l'utilisateur de les modifier)
function loadArtistOverrides() {
  const prefs = loadPrefs();
  if (prefs.artistOverrides && typeof prefs.artistOverrides === 'object') {
    ARTIST_GENRE_OVERRIDES = { ...ARTIST_GENRE_OVERRIDES, ...prefs.artistOverrides };
  }
}

// Sauvegarder les overrides (si l'utilisateur veut en ajouter)
function saveArtistOverrides(overrides) {
  const prefs = loadPrefs();
  prefs.artistOverrides = overrides;
  savePrefs(prefs);
  ARTIST_GENRE_OVERRIDES = { ...ARTIST_GENRE_OVERRIDES, ...overrides };
}

// Appeler au démarrage
loadArtistOverrides();

// ============================================================
// 10. IPC HANDLERS
// ============================================================

function safeSend(webContents, channel, data) {
  try {
    if (webContents && !webContents.isDestroyed() && !webContents.isCrashed()) {
      webContents.send(channel, data);
    }
  } catch (e) {}
}

ipcMain.handle('setFullscreen', (_, flag) => {
  if(win && !win.isDestroyed()) win.setFullScreen(!!flag);
});

ipcMain.handle('get-artist-overrides', () => ARTIST_GENRE_OVERRIDES);



ipcMain.handle('debug-mbrg', async (_, { artist, album }) => {
  try {
    const r = await fetchFromMusicBrainzReleaseGroup(album, artist);
    return { ok: true, result: r };
  } catch (e) {
    return { ok: false, error: e.message, stack: e.stack };
  }
});

ipcMain.handle('fetch-online-meta', async (_, albumGroups) => {
  if (!Array.isArray(albumGroups) || !albumGroups.length) return {};
  console.log(`[fetch-online-meta] DÉMARRAGE — ${albumGroups.length} groupes reçus`);
  const prefs = loadPrefs();
  prefs.trackMeta = prefs.trackMeta || {};
  const results = {};
  let totalUpdated = 0;
  let mbCallsSent = 0;

  try {

  for (let gi = 0; gi < albumGroups.length; gi++) {
    const group = albumGroups[gi];
    const { album, artist, paths } = group;
    if (!paths?.length) continue;

    // Recherche par ENREGISTREMENT (déclenchée par le « Rechercher » manuel via
    // _searchByTrack) : on veut UNIQUEMENT l'artiste/année réels du morceau depuis
    // MusicBrainz, sans toucher l'album ni le cache ni la persistance.
    if (group.trackSearch && group.title) {
      let _rec = null;
      // ÉTAPE 1 — Ancrage par tracklist d'abord pour les compils/B.O. ou les titres
      // SANS artiste (cas où la recherche par titre seule échoue : homonymes/reprises).
      // On scope au bon album → on lit l'artiste/année réels de LA piste.
      if (group.album && (group.isComp || !artist)) {
        _rec = await _releaseTracklistAnchor(group.album, group.title, artist, { durationSec: group.durationSec || null });
      }
      // ÉTAPE 2 — Repli : recherche par titre (iTunes popularité + MusicBrainz).
      if (!_rec) {
        const _it = await _recordingCandidatesItunes(group.title, artist);
        const _mb = await _recordingCandidatesMB(group.title, artist);
        const _cands = [..._it, ..._mb];
        _rec = _pickRecording(group.title, _cands, group.yearHint, artist);
        console.log(`[trackSearch] "${group.title}" (indice ${group.yearHint || '∅'}) — iTunes:${_it.length} MB:${_mb.length} → ${_rec ? (_rec.artist || '?') + ' / ' + (_rec.year || '?') : 'rien'}`);
        if (_cands.length) console.log('[trackSearch] top 3:', _cands.slice(0, 3).map(c => `${c.artist || '?'}/${c.year || '?'}[${c.source}]`).join(' | '));
        // ANNÉE D'ORIGINE : le bestMatch peut être une reprise/version récente.
        // On affine avec les candidats déjà en main (aucun appel réseau en plus).
        if (_rec && _rec.year) {
          const _old = _oldestPlausibleRecYear(_cands, _rec.artist, parseInt(_rec.year));
          if (_old) {
            console.log(`[trackSearch] année affinée (origine) : ${_rec.year} → ${_old.year} (${_old.artist || '?'})`);
            _rec.year = _old.year;
          }
        }
      } else {
        console.log(`[trackSearch] ANCRAGE tracklist "${group.title}" → ${_rec.artist} / ${_rec.year || '?'}`);
        // ANNÉE D'ORIGINE : l'ancrage donne l'artiste réel de LA piste, mais son
        // année est celle de CET enregistrement (ex. version Blues Brothers 2000
        // = 1998). Une requête recording ciblée retrouve la 1re sortie du titre
        // par un artiste qui recoupe le crédit → l'origine prime (ex. 1967).
        if (_rec.year && _rec.artist) {
          await new Promise(r => setTimeout(r, 1100)); // MusicBrainz : 1 req/s
          const _cands2 = await _recordingCandidatesMB(_rec.title || group.title, null);
          const _old = _oldestPlausibleRecYear(_cands2, _rec.artist, parseInt(_rec.year));
          if (_old) {
            console.log(`[trackSearch] année affinée (origine) : ${_rec.year} → ${_old.year} (${_old.artist || '?'})`);
            _rec.year = _old.year;
          }
        }
      }
      for (const p of paths) results[p] = { trackLevel: _rec || null };
      continue;
    }

    if (gi % 5 === 0) console.log(`[fetch-online-meta] progress ${gi}/${albumGroups.length} — current: ${artist || '∅'} / ${album || '∅'}`);

   const cacheKey = `${artist||''}||${album||''}${group.title ? '||'+group.title : ''}`;
    // force:true (passé par groupe ou global) → ignore le cache et re-fetche.
    // Sert au re-test développeur ET au futur « tout re-vérifier » utilisateur.
    const _force = !!(group._force || group.force);
    const cached = _metaCache.has(cacheKey) && !_force;

    // MusicBrainz = 1 req/sec max. On respecte 1.1s SEULEMENT entre vrais
    // appels réseau (pas entre hits de cache). Sur relance, tous les hits
    // sont cache → plus aucune attente.
    if (!cached && mbCallsSent > 0) {
      await new Promise(r => setTimeout(r, 1100));
    }

    let genre = null, year = null;
    const normalizedArtist = normArtist(artist);
    const hasOverride = !!(normalizedArtist && ARTIST_GENRE_OVERRIDES[normalizedArtist]);
    if (hasOverride) {
      genre = ARTIST_GENRE_OVERRIDES[normalizedArtist];
    }

    let multi;
    if (cached) {
      multi = _metaCache.get(cacheKey);
    } else {
      multi = await fetchMetadataMultiSource(album, artist, { hasOverride, title: group.title || '' });
      _metaCache.set(cacheKey, multi);
      _schedulePersistCache();
      mbCallsSent++;
    }
    if (!genre && multi?.genre) genre = multi.genre;
    if (multi?.year) year = multi.year;
    const yearTrusted  = !!multi?.yearTrusted;
    const genreTrusted = !!multi?.genreTrusted || hasOverride;

    // For compilations, the album-level lookup gives a release year (probably
    // the compilation date) which is NOT what we want. We do per-track lookups
    // (using each track's own artist + title) so each cue keeps its true
    // recording year + original artist's genre. Album-level genre still flows
    // as a fallback when per-track returns nothing.
    if (group.isCompilation) {
      for (const p of paths) {
        const trackInfo = prefs.trackMeta[p] || {};
        if (trackInfo.userModified) continue;
        // We don't have the track's title here at the IPC layer — fall back
        // gracefully: use album genre (compilations often share a vibe), but
        // SKIP the year (compilation years are unreliable).
        const updated = { ...trackInfo };
        if (genre && (!trackInfo.genre || isJunkGenreMain(trackInfo.genre))) updated.genre = genre;
        // Year: do NOT inherit album year for compilations.
        if (updated.genre !== trackInfo.genre) {
          prefs.trackMeta[p] = updated;
          results[p] = {
            genre: updated.genre || null,
            year:  updated.year  || null,
            yearTrusted: false,           // compilation year is never trusted
            genreTrusted,
            rawByField: multi?.rawByField || null
          };
          totalUpdated++;
        }
      }
      if (totalUpdated > 0 && totalUpdated % 10 === 0) savePrefs(prefs);
      continue; // skip the regular per-track loop below
    }

   for (const p of paths) {
      const existing = prefs.trackMeta[p] || {};
      if (existing.userModified) continue;
      const updated = { ...existing };
      if (genre) updated.genre = genre;
      if (year)  updated.year  = year;
      // Push TOUJOURS si on a une donnée (genre OU year) à proposer — même si
      // identique à prefs.trackMeta. Raison : le renderer peut avoir un
      // t.genre/t.year vide alors que prefs.trackMeta a la donnée (désync
      // possible entre cache et état). Le renderer applique son propre filtre
      // anti-écrasement (curJunk + trusted) plus loin.
      if (genre || year) {
        if (updated.genre !== existing.genre || updated.year !== existing.year) {
          prefs.trackMeta[p] = updated;
        }
        results[p] = {
          genre: updated.genre || null,
          year:  updated.year  || null,
          yearTrusted,
          genreTrusted,
          rawByField: multi?.rawByField || null,
          _debug: multi?._debug
        };
        totalUpdated++;
      }
    }
    if (totalUpdated > 0 && totalUpdated % 10 === 0) savePrefs(prefs);
  }
 if (totalUpdated > 0) savePrefs(prefs);
  console.log(`[fetch-online-meta] TERMINÉ — ${totalUpdated} tracks updated from ${albumGroups.length} albums (${mbCallsSent} net, ${albumGroups.length - mbCallsSent} cached)`);
  return results;

  } catch (errGlobal) {
    console.error(`[fetch-online-meta] CRASH GLOBAL après ${totalUpdated} tracks, mbCallsSent=${mbCallsSent} :`, errGlobal);
    // Renvoie quand même ce qu'on a accumulé jusqu'au crash, avec marqueur d'erreur
    results.__error = String(errGlobal?.message || errGlobal);
    return results;
  }
});

// Renvoie le cache méta complet (artist||album → {genre, year, yearTrusted, ...}).
// Lecture seule, zéro réseau. Sert à comparer les années connues de MusicBrainz
// aux années locales sans relancer de fetch (le re-fetch ne réémet pas les
// verdicts déjà en cache).
ipcMain.handle('get-meta-cache', async () => {
  const out = {};
  for (const [k, v] of _metaCache.entries()) {
    out[k] = {
      genre: v.genre || null,
      year:  v.year  || null,
      yearTrusted:  !!v.yearTrusted,
      genreTrusted: !!v.genreTrusted
    };
  }
  return out;
});

ipcMain.handle('openCoverWindow', async (_, data) => {
  if (coverWin && !coverWin.isDestroyed()) {
    coverWin.focus();
    safeSend(coverWin.webContents, 'coverData', data);
    return;
  }
  coverWin = new BrowserWindow({
    width: 720, height: 820, minWidth: 560, minHeight: 640,
    title: 'Modifier la pochette', backgroundColor: '#1E1E1B',
    resizable: true, minimizable: false, fullscreenable: false, parent: win,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  coverWin.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': ["default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src * data: file: blob: https://*.mzstatic.com https://*.apple.com https://*.deezer.com https://*.dzcdn.net https://*.coverartarchive.org; connect-src https://itunes.apple.com https://api.deezer.com https://musicbrainz.org https://coverartarchive.org;"]
      }
    });
  });
  coverWin.loadFile(path.join(__dirname, '..', 'cover.html'));
  coverWin.webContents.on('did-finish-load', () => safeSend(coverWin.webContents, 'coverData', data));
  coverWin.on('closed', () => { coverWin = null; });
});

ipcMain.handle('applyCoverToMain', async (_, payload) => {
  if (win && !win.isDestroyed()) safeSend(win.webContents, 'coverApplied', payload);
});

ipcMain.handle('applyTrackMetaToMain', async (_, payload) => {
  if (win && !win.isDestroyed()) safeSend(win.webContents, 'trackMetaApplied', payload);
});

ipcMain.handle('compute-track-id', (_, filePath) => {
  if (!filePath) return null;
  return crypto.createHash('md5').update(filePath).digest('hex').slice(0, 12);
});

// Recherche sur le disque : un morceau du Sync dont le chemin a dérivé hors de
// allTracks (fichier déplacé/renommé) est retrouvé en parcourant le dossier
// Musique scanné. Score : nom de fichier exact (100) > titre dans le nom (40),
// + bonus si artiste/album apparaissent dans l'arborescence. Renvoie le chemin
// courant ou null. Permet au retry « intelligent » de rattacher le bon chemin.
ipcMain.handle('sync-find-file', async (_, meta) => {
  try {
    const root = _prefsCache && _prefsCache.folder;
    if (!root || !meta) return null;
    const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');
    const wantName  = String(meta.filename || '').toLowerCase();
    const wantTitleN = norm(meta.title);
    if (!wantName && !wantTitleN) return null;
    const wantArtist = norm(meta.artist);
    const wantAlbum  = norm(meta.album);
    const dirs = [{ dir: root, depth: 0 }];
    let best = null, bestScore = -1;
    while (dirs.length) {
      const { dir, depth } = dirs.shift();
      if (depth > 8) continue;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.name[0] === '.') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { dirs.push({ dir: full, depth: depth + 1 }); continue; }
        const ext = path.extname(e.name).toLowerCase();
        if (!AUDIO.has(ext)) continue;
        const baseLower = e.name.toLowerCase();
        const baseNoExtN = norm(path.basename(e.name, ext));
        let score = 0;
        if (wantName && baseLower === wantName) score += 100;            // nom exact
        else if (wantTitleN && baseNoExtN.includes(wantTitleN)) score += 40;  // titre dans le nom
        else continue;                                                  // pas de base commune
        const fullN = norm(full);
        if (wantArtist && fullN.includes(wantArtist)) score += 10;
        if (wantAlbum  && fullN.includes(wantAlbum))  score += 10;
        if (score > bestScore) { bestScore = score; best = full; }
        if (bestScore >= 120) { dirs.length = 0; break; }               // quasi-parfait → stop
      }
    }
    if (best) console.log('[sync-find-file] retrouvé:', meta.title || meta.filename, '→', best, '(score', bestScore + ')');
    return best;
  } catch (e) {
    console.warn('[sync-find-file]', e?.message || e);
    return null;
  }
});

// Patch M : persister le statut favori d'un morceau dans prefs.trackMeta
// Le renderer appelle ça quand l'user toggle une étoile sur un morceau.
ipcMain.handle('setTrackFavorite', async (_, payload) => {
  if (!payload || !payload.path) return { ok: false };
  prefs.trackMeta = prefs.trackMeta || {};
  prefs.trackMeta[payload.path] = prefs.trackMeta[payload.path] || {};
  prefs.trackMeta[payload.path].isFavorite = !!payload.isFavorite;
  await savePrefs();
  return { ok: true };
});

ipcMain.handle('pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, {
    title:'Où est ta musique ?', properties:['openDirectory'],
    buttonLabel:'Utiliser ce dossier', message:'Wave Tune lit les fichiers sur place — rien n\'est copié'
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const folder = r.filePaths[0];
  const prefs = loadPrefs(); prefs.folder = folder; savePrefs(prefs);
  const tracks = await scanAsync(folder);
  saveScanCache({ fingerprint: folderFingerprint(folder), tracks, ts: Date.now() });
  return { tracks, folder };
});

ipcMain.handle('connectItunes', async (_, manual) => {
  let xmlPath = null;
  if (!manual) {
    const cands = [
      path.join(os.homedir(),'Music','Music','Library.xml'),
      path.join(os.homedir(),'Music','iTunes','iTunes Music Library.xml'),
      path.join(os.homedir(),'Music','iTunes','iTunes Library.xml')
    ];
    xmlPath = cands.find(c => fs.existsSync(c)) || null;
  } else {
    const r = await dialog.showOpenDialog(win, {
      title:'Sélectionner Library.xml iTunes / Music',
      filters:[{name:'XML',extensions:['xml']}], properties:['openFile']
    });
    if (!r.canceled) xmlPath = r.filePaths[0];
  }
  if (!xmlPath) return null;
  const prefs = loadPrefs();
  prefs.itunesXml = xmlPath;
  prefs.itunesImportedOnce = false;
  savePrefs(prefs);
  return { lists: parseItunes(xmlPath) };
});

ipcMain.handle('openPath', (_, p) => shell.openPath(p));
// AcoustID fingerprinting IPCs
ipcMain.handle('fingerprint-file', async (_, audioPath) => {
  return await fingerprintFile(audioPath);
});
ipcMain.handle('acoustid-available', () => !!getFpcalcPath());
ipcMain.handle('getIP', () => {
  for (const ifaces of Object.values(os.networkInterfaces()))
    for (const i of ifaces)
      if (i.family === 'IPv4' && !i.internal) return i.address;
  return 'localhost';
});
ipcMain.handle('revealInFinder', (_, p) => { shell.showItemInFolder(p); return true; });
ipcMain.handle('getPort', () => SYNC_PORT);
ipcMain.handle('sync-set-tracks', (_, tracks) => {
  _syncTracks = Array.isArray(tracks) ? tracks.filter(t => t && t.path) : [];
  _refreshPathMap();
  return _syncTracks.length;
});
ipcMain.handle('clearScanCache', () => { try { fs.unlinkSync(SCAN_CACHE); } catch {} return true; });
ipcMain.handle('resync-itunes', () => {
  const prefs = loadPrefs();
  if (!prefs.itunesXml || !fs.existsSync(prefs.itunesXml)) return { lists:[] };
  prefs.itunesImportedOnce = false;
  savePrefs(prefs);
  const lists = parseItunes(prefs.itunesXml);
  prefs.itunesImportedOnce = true;
  savePrefs(prefs);
  return { lists };
});
ipcMain.handle('set-onboarding-done', () => { const prefs = loadPrefs(); prefs.onboardingDone = true; savePrefs(prefs); return true; });
ipcMain.handle('fileExists', async (_, filePath) => { try { return fs.existsSync(filePath); } catch { return false; } });
ipcMain.handle('getMusicFolder', async () => { const prefs = loadPrefs(); return prefs.folder || null; });

// ============================================================
// 11. GET-LIBRARY (PRINCIPAL)
// ============================================================

ipcMain.handle('get-library', async () => {
  const prefs = loadPrefs();
  const hasFolder = prefs.folder && fs.existsSync(prefs.folder);
  const hasItunes = prefs.itunesXml && fs.existsSync(prefs.itunesXml);
  if (!hasFolder && !hasItunes) return { tracks:[], lists:[], folder:null, onboardingDone: prefs.onboardingDone||false };

  let tracks = [];
  if (hasFolder) {
    const fp = folderFingerprint(prefs.folder);
    const cache = loadScanCache();
    if(cache && cache.fingerprint === fp && Array.isArray(cache.tracks) && cache.tracks.length > 0) {
      tracks = cache.tracks;
    } else {
      tracks = await scanAsync(prefs.folder);
      saveScanCache({ fingerprint: fp, tracks, ts: Date.now() });
    }
  }

  const trackMeta = prefs.trackMeta || {};
  if (Object.keys(trackMeta).length > 0) {
    tracks.forEach(t => {
      const m = trackMeta[t.path];
      if (!m) return;
      if (m.genre) t.genre = mapToGenre15(m.genre) || m.genre;
      if (m.genreChild) t.genreChild = m.genreChild;
      if (m.year) t.year = m.year;
      if (m.artist) t.artist = m.artist;
      if (m.title) t.title = m.title;
      if (m.album) t.album = m.album;
      if (m.userModified) t._userModified = true;
      // Patch M : favori — l'override manuel (trackMeta) gagne sur l'import iTunes
      if (typeof m.isFavorite === 'boolean') t.isFavorite = m.isFavorite;
      // « Ne plus me le proposer » : restauré ICI (le bloc renderer dépendait de
      // window.wt.getTrackMeta, non exposé dans preload → il ne tournait jamais).
      if (m.ignored === true) t._ignored = true;
      // Patch : play stats (smart playlists "Jamais écouté" / "Écouté il y a")
      if (typeof m.playCount === 'number') t.playCount = m.playCount;
      if (typeof m.lastPlayed === 'number') t.lastPlayed = m.lastPlayed;
    });
  }

  setTimeout(() => { if (win && !win.isDestroyed()) safeSend(win.webContents, 'startAutoEnrich'); }, 2500);

  let itunesLists = [];
  if (prefs.itunesXml && fs.existsSync(prefs.itunesXml)) {
    try {
      const xmlStat = fs.statSync(prefs.itunesXml);
      const itunesCacheKey = `itunes:${prefs.itunesXml}:${xmlStat.mtimeMs}`;
      const itunesCachePath = path.join(os.homedir(), '.wavetune', 'itunes-cache.json');
      let itunesCached = null;
      try { const raw = fs.readFileSync(itunesCachePath, 'utf8'); const parsed = JSON.parse(raw); if (parsed.key === itunesCacheKey) itunesCached = parsed.lists; } catch {}
      if (itunesCached) itunesLists = itunesCached;
      else { itunesLists = parseItunes(prefs.itunesXml); setImmediate(() => { try { fs.writeFileSync(itunesCachePath, JSON.stringify({key: itunesCacheKey, lists: itunesLists})); } catch(e) {} }); }
    } catch(e) { console.warn('[itunes]', e.message); }
  }

  const byPath = new Map(tracks.map(t => [t.path, t]));
  const byKey = new Map(tracks.map(t => [(t.title+'|'+(t.artist||'')).toLowerCase(), t]));
  itunesLists.forEach(il => il.tracks.forEach(t => { if(!byPath.has(t.path)) byPath.set(t.path, t); const k=(t.title+'|'+(t.artist||'')).toLowerCase(); if(!byKey.has(k)) byKey.set(k, t); }));

  function resolveTrack(ref) {
    if(!ref) return null;
    const p = typeof ref === 'string' ? ref : ref.path;
    if(p && byPath.has(p)) return byPath.get(p);
    if(ref.title) { const k=(ref.title+'|'+(ref.artist||'')).toLowerCase(); if(byKey.has(k)) return byKey.get(k); }
    if(p) { const base=path.basename(p).toLowerCase(); for(const [fp,t] of byPath) { if(path.basename(fp).toLowerCase()===base) return t; } }
    return null;
  }

  const customLists = (prefs.customLists || []).map(pl => {
    const refs = pl.trackRefs || (pl.trackPaths||[]).map(p=>({path:p}));
    const hydrated = refs.map(resolveTrack).filter(Boolean);
    return { ...pl, tracks: hydrated, count: hydrated.length };
  });

  const customNames = new Set(customLists.map(l => l.name));
  const mergedLists = [...customLists, ...itunesLists.filter(l => !customNames.has(l.name))];

  return { tracks, lists: mergedLists, folder: prefs.folder, onboardingDone: prefs.onboardingDone||false, customCovers: prefs.customCovers || {} };
});

ipcMain.handle('save-custom-lists', (_, lists, covers) => {
  const prefs = loadPrefs();
  prefs.customLists = lists.filter(pl => pl.custom || pl.smart || pl.merged).map(pl => ({
    name: pl.name,
    custom: pl.custom||false,
    smart: pl.smart||false,
    merged: pl.merged||false,
    rules: pl.rules||null,
    // Patch : persister l'état de sync Firestore pour éviter les duplicatas au rename/reload
    _sync: pl._sync||false,
    _syncFirestoreId: pl._syncFirestoreId||null,
    trackRefs: (pl.tracks||[]).map(t => ({ path: t.path, title: t.title, artist: t.artist||'' }))
  }));
  if (covers && typeof covers === 'object') prefs.customCovers = Object.fromEntries(Object.entries(covers).slice(0, 200));
  savePrefs(prefs);
  return true;
});

ipcMain.handle('save-track-meta', (_, metaMap) => {
  if (!metaMap || typeof metaMap !== 'object') return false;
  const prefs = loadPrefs();
  prefs.trackMeta = prefs.trackMeta || {};
  Object.entries(metaMap).forEach(([path, meta]) => { const existing = prefs.trackMeta[path] || {}; prefs.trackMeta[path] = Object.assign({}, existing, meta); if (meta.userModified) prefs.trackMeta[path].userModified = true; });
  Object.keys(prefs.trackMeta).forEach(k => { const entry = prefs.trackMeta[k]; if (!entry.genre && !entry.year && !entry.album && !entry.artist && !entry.userModified && !entry.ignored && !entry.isFavorite && !entry.syncExcluded) delete prefs.trackMeta[k]; });
  savePrefs(prefs);
  return true;
});

// ============================================================
// 12. SYNC SERVER
// ============================================================

const SYNC_PORT = 3000;
const http = require('http');
const crypto = require('crypto');

let _syncTracks = [];
const _pathById = new Map();

function _refreshPathMap(){
  _pathById.clear();
  _syncTracks.forEach(t => {
    if(!t.path) return;
    const md5id = crypto.createHash('md5').update(t.path).digest('hex').slice(0,12);
    _pathById.set(md5id, t.path);          // legacy : md5(chemin) → chemin
    t._id = md5id;                          // utilisé par la page HTML /
    if(t.id) _pathById.set(t.id, t.path);   // Phase 2 : trackId stable → chemin courant
  });
}

function _escHtml(s){ return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c])); }

const _syncServer = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    if(p === '/' || p === '/index.html'){
      const rows = _syncTracks.map(t => `<li><div class="t"><div class="ti">${_escHtml(t.title||'–')}</div><div class="ar">${_escHtml(t.artist||'')}${t.album?' · '+_escHtml(t.album):''}</div></div><a class="dl" href="/f/${t._id}" download>↓</a></li>`).join('');
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
      return res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wave Tune · Sync</title><style>body{font-family:-apple-system,system-ui,sans-serif;background:#1E1E1B;color:#F8F6F3;margin:0;padding:14px 16px 40px}h1{font-size:17px;margin:0 0 4px}.sub{color:#AEACA6;font-size:12px;margin-bottom:18px}ul{list-style:none;padding:0;margin:0}li{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:.5px solid rgba(255,255,255,.07)}.ti{font-weight:600;font-size:14px}.ar{font-size:11px;color:#C85A45;margin-top:2px}.dl{color:#C85A45;font-size:20px;text-decoration:none;padding:6px 14px;border:1px solid rgba(200,90,69,.4);border-radius:8px}.dl:active{background:rgba(200,90,69,.2)}</style></head><body><h1>Wave Tune · ${_syncTracks.length} morceaux</h1><div class="sub">Appuie sur ↓ pour télécharger.</div><ul>${rows}</ul></body></html>`);
    }
    if(p === '/tracks'){
      res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
      return res.end(JSON.stringify(_syncTracks.map(t => ({ id:t._id, title:t.title||'', artist:t.artist||'', album:t.album||'', year:t.year||null }))));
    }
    const m = p.match(/^\/f\/([A-Za-z0-9_-]+)$/);
    if(m){
      const id = m[1];
      const filePath = _pathById.get(id);
      if(!filePath || !fs.existsSync(filePath)){ res.writeHead(404); return res.end('Not found'); }
      const stat = fs.statSync(filePath);
      const range = req.headers.range;
      const ext = path.extname(filePath).toLowerCase();
      const mime = ext === '.mp3' ? 'audio/mpeg' : ext === '.m4a' ? 'audio/mp4' : ext === '.flac' ? 'audio/flac' : ext === '.wav' ? 'audio/wav' : ext === '.ogg' ? 'audio/ogg' : 'application/octet-stream';
      const fname = path.basename(filePath);
      // Encode le filename en RFC 5987 pour supporter les caractères non-ASCII
      // (accents espagnols/français, kanji, etc.). Sans ça, Node.js refuse
      // d'écrire le header → 500 silencieux pour le mobile.
      // - filename="..." : fallback ASCII (caractères non-ASCII remplacés)
      // - filename*=UTF-8''... : nom Unicode (lu par les clients modernes)
      const fnameAscii = fname.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
      const fnameUtf8  = encodeURIComponent(fname);
      const disposition = `attachment; filename="${fnameAscii}"; filename*=UTF-8''${fnameUtf8}`;
      if(range){
        const parts = range.replace(/bytes=/,'').split('-');
        const start = parseInt(parts[0],10);
        const end = parts[1] ? parseInt(parts[1],10) : stat.size-1;
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges':'bytes', 'Content-Length': end-start+1, 'Content-Type': mime, 'Content-Disposition': disposition });
        return fs.createReadStream(filePath, {start,end}).pipe(res);
      }
      res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': mime, 'Accept-Ranges':'bytes', 'Content-Disposition': disposition });
      return fs.createReadStream(filePath).pipe(res);
    }
    res.writeHead(404); res.end('Not found');
  } catch(e){ 
    console.error('[sync-server] ERREUR sur', req.url, ':', e?.message || e, e?.stack);
    try { res.writeHead(500); res.end('Server error: ' + (e?.message || 'unknown')); } catch(_){}
  }
});

_syncServer.on('error', err => { if(err.code === 'EADDRINUSE') console.warn(`[sync-server] Port ${SYNC_PORT} déjà utilisé`); else console.error('[sync-server]', err); });
_syncServer.listen(SYNC_PORT, () => console.log(`[sync-server] écoute sur :${SYNC_PORT}`));

// ============================================================
// SHAZAM IDENTIFICATION DEPUIS FICHIER (sans micro)
// ============================================================



ipcMain.handle('shazam-recognize', async (event, audioBuffer) => {
  console.log('[AudD] Received request, size:', audioBuffer?.length);
  
  let tempPath = null;
  
  try {
    if (!audioBuffer || audioBuffer.length === 0) {
      return { success: false, error: 'Aucune donnée audio' };
    }
    
    // Créer un fichier temporaire
    const tempDir = app.getPath('temp');
    tempPath = path.join(tempDir, `audd-${Date.now()}.mp3`);
    fs.writeFileSync(tempPath, Buffer.from(audioBuffer));
    
    // Préparer l'API AudD
    const formData = new FormData();
    formData.append('file', fs.createReadStream(tempPath));
    formData.append('return', 'timecode,apple_music,spotify');
    
    const response = await axios.post('https://api.audd.io/', formData, {
      headers: { ...formData.getHeaders() },
      timeout: 15000
    });
    
    // Nettoyer
    if (tempPath && fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch(e) {}
    }
    
    if (!response.data || !response.data.result) {
      return { success: false, error: 'Aucun morceau identifié' };
    }
    
    const result = response.data.result;
    
    // Extraire l'année
    let year = null;
    if (result.release_date) {
      const yearMatch = result.release_date.match(/^(\d{4})/);
      if (yearMatch) year = parseInt(yearMatch[1]);
    }
    
    // Extraire la pochette
    let cover = null;
    if (result.album?.img) {
      cover = result.album.img;
    } else if (result.spotify?.album?.images?.[0]?.url) {
      cover = result.spotify.album.images[0].url;
    } else if (result.apple_music?.artwork?.url) {
      cover = result.apple_music.artwork.url.replace('{w}', '600').replace('{h}', '600');
    }
    
    return {
      success: true,
      title: result.title || '',
      artist: result.artist || '',
      album: result.album || result.title || '',
      year: year,
      genre: result.genre || result.spotify?.track?.album?.genres?.[0] || null,
      cover: cover
    };
    
  } catch (error) {
    console.error('[AudD] Error:', error.message);
    
    if (tempPath && fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch(e) {}
    }
    
    return { success: false, error: error.message };
  }
});
// Dans main.js, vers la fin, avant app.whenReady(), ajoutez :

// ============================================================
// LECTURE DE FICHIER AUDIO POUR SHAZAM
// ============================================================

ipcMain.handle('read-audio-file', async (event, filePath) => {
  console.log('[read-audio-file] Reading:', filePath);
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error('Fichier non trouvé: ' + filePath);
    }
    
    // Lire le fichier
    const fileBuffer = fs.readFileSync(filePath);
    
    // Convertir Buffer en Array pour l'IPC
    const audioArray = Array.from(new Uint8Array(fileBuffer));
    
    console.log('[read-audio-file] Size:', audioArray.length);
    return audioArray;
  } catch (error) {
    console.error('[read-audio-file] Error:', error);
    throw error;
  }
});

// ============================================================
// 13. BOOT
// ============================================================

app.whenReady().then(() => {
  setupCoverCache();
  createWin();
  app.on('activate', () => { if (!win) createWin(); });
  setupAutoUpdater();
  // Touches MÉDIA du clavier (⏯ ⏭ ⏮) : pilotage universel, même app en
  // arrière-plan — relayées au renderer via le canal 'media-key'.
  try {
    globalShortcut.register('MediaPlayPause',     () => { if (win) win.webContents.send('media-key', 'play'); });
    globalShortcut.register('MediaNextTrack',     () => { if (win) win.webContents.send('media-key', 'next'); });
    globalShortcut.register('MediaPreviousTrack', () => { if (win) win.webContents.send('media-key', 'prev'); });
  } catch (e) { console.warn('[media-keys] enregistrement impossible:', e && e.message); }
});
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (e) {} });

// Notification native « lecture en cours » (façon iTunes)
ipcMain.handle('notify-track', (_e, info) => {
  try {
    if (!Notification.isSupported() || !info) return false;
    new Notification({ title: String(info.title || 'Wave Tune'), body: String(info.body || ''), silent: true }).show();
    return true;
  } catch (e) { return false; }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });