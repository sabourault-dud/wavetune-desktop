// main.js — Wave Tune Desktop v7 — Multi-source universel
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { execFile } = require('child_process');

const AUDIO = new Set(['.mp3','.m4a','.aac','.flac','.wav','.ogg','.opus','.wma','.aiff','.alac']);
const VIDEO = new Set(['.mp4','.m4v','.mov','.avi','.mkv','.wmv','.mpg','.mpeg','.webm']);

let win = null;
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

    tm[trackId] = { title, artist: finalArtist||'', album: album||'', genre: genre||'', year: yearRaw ? parseInt(yearRaw,10)||null : null, path: fp };
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
    width:1280, height:820, minWidth:960, minHeight:640,
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
          "script-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com;" +
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;" +
          "font-src 'self' data: https://fonts.gstatic.com;" +
          "media-src * file: blob:;" +
          "img-src * data: file: blob: https://*.mzstatic.com https://*.apple.com;" +
          "connect-src 'self' https://itunes.apple.com https://api.spotify.com https://musicbrainz.org https://api.discogs.com https://en.wikipedia.org https://api.deezer.com https://coverartarchive.org https://*.archive.org https://www.theaudiodb.com https://theaudiodb.com https://ws.audioscrobbler.com https://www.last.fm https://api.acoustid.org;"
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
  'Latin & Caribbean','Afrobeat, African & World','Classical, Opera & Score'
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

  // ── 13. Latin & Caribbean ──
  latin:'Latin & Caribbean', 'latin pop':'Latin & Caribbean', 'latin rock':'Latin & Caribbean',
  salsa:'Latin & Caribbean', reggaeton:'Latin & Caribbean', bachata:'Latin & Caribbean',
  merengue:'Latin & Caribbean', cumbia:'Latin & Caribbean', 'latin jazz':'Latin & Caribbean',
  'latin trap':'Latin & Caribbean', 'latin alternative':'Latin & Caribbean',
  tango:'Latin & Caribbean', bolero:'Latin & Caribbean', mariachi:'Latin & Caribbean',
  ranchera:'Latin & Caribbean', banda:'Latin & Caribbean', corridos:'Latin & Caribbean',
  samba:'Latin & Caribbean', 'bossa nova':'Latin & Caribbean', bossa:'Latin & Caribbean',
  mpb:'Latin & Caribbean', tropicalia:'Latin & Caribbean', 'tropicália':'Latin & Caribbean',
  forro:'Latin & Caribbean', 'forró':'Latin & Caribbean',
  calypso:'Latin & Caribbean', soca:'Latin & Caribbean', zouk:'Latin & Caribbean',
  kizomba:'Latin & Caribbean', compas:'Latin & Caribbean',

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

  // ── 15. Classical, Opera & Score ──
  classical:'Classical, Opera & Score', 'classical music':'Classical, Opera & Score',
  'neo-classical':'Classical, Opera & Score', neoclassical:'Classical, Opera & Score',
  'modern classical':'Classical, Opera & Score', 'contemporary classical':'Classical, Opera & Score',
  'early music':'Classical, Opera & Score', medieval:'Classical, Opera & Score', renaissance:'Classical, Opera & Score',
  baroque:'Classical, Opera & Score', romantic:'Classical, Opera & Score',
  'chamber music':'Classical, Opera & Score', orchestral:'Classical, Opera & Score', symphony:'Classical, Opera & Score',
  symphonic:'Classical, Opera & Score', concerto:'Classical, Opera & Score', sonata:'Classical, Opera & Score',
  opera:'Classical, Opera & Score', operetta:'Classical, Opera & Score',
  choral:'Classical, Opera & Score', piano:'Classical, Opera & Score',
  soundtrack:'Classical, Opera & Score', 'film score':'Classical, Opera & Score', score:'Classical, Opera & Score',
  cinematic:'Classical, Opera & Score', 'film music':'Classical, Opera & Score',
  'game music':'Classical, Opera & Score', 'video game music':'Classical, Opera & Score', vgm:'Classical, Opera & Score',
  instrumental:'Classical, Opera & Score'
};

function mapToGenre15(raw) {
  if (!raw) return null;
  const r = raw.toLowerCase().trim();
  if (GENRE_15_LIST.includes(raw)) return raw;
  if (GENRE_MAP_15[r]) return GENRE_MAP_15[r];
  
  const keys = Object.keys(GENRE_MAP_15).sort((a,b) => b.length - a.length);
  for (const key of keys) {
    if (key.length <= 3) continue;
    const rgx = new RegExp('(^|[^a-z])' + key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '([^a-z]|$)', 'i');
    if (rgx.test(r)) return GENRE_MAP_15[key];
  }
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
const META_CACHE_VERSION = 5;

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
        genreTrusted: !!v.genreTrusted
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
        if (!v || (!v.genre && !v.year)) continue;
        entries[k] = {
          genre: v.genre || null,
          year:  v.year  || null,
          yearTrusted:  !!v.yearTrusted,
          genreTrusted: !!v.genreTrusted,
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
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\([^)]*\)/g, ' ')        // "(remastered 2009)"
    .replace(/\[[^\]]*\]/g, ' ')       // "[disc 1]"
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
async function fetchFromDeezer(album, artist) {
  try {
    const q = encodeURIComponent(`${artist || ''} ${album || ''}`.trim());
    if (!q || q === '%20') return { genre: null, year: null, trusted: false };
    const data = await httpsGet(`https://api.deezer.com/search/album?q=${q}&limit=5`);
    const items = data.data || [];
    if (!items.length) return { genre: null, year: null, trusted: false };

    const top = (album ? items.find(it => titleMatches(it.title || '', album)) : items[0]) || items[0];
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
    // Deezer year = untrusted (voir commentaire ci-dessus)
    return { genre, year, trusted: false };
  } catch(e) { return { genre: null, year: null, trusted: false }; }
}

// 7d. Wikipedia (dernier recours pour le genre)
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

async function fetchFromMusicBrainzEnhanced(album, artist) {
  try {
    const parts = [];
    if (artist) parts.push(`artist:"${String(artist).replace(/"/g, '\\"')}"`);
    if (album)  parts.push(`release:"${String(album).replace(/"/g, '\\"')}"`);
    if (!parts.length) return { genre: null, year: null, trusted: false };
    const query = encodeURIComponent(parts.join(' AND '));

    const data = await httpsGet(`https://musicbrainz.org/ws/2/release/?query=${query}&fmt=json&limit=10&inc=release-groups+genres+tags`);
    const releases = data.releases || [];
    if (!releases.length) return { genre: null, year: null, trusted: false };

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

    return { genre, year, trusted };
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
        else if (al.includes('latin') || al.includes('salsa')) fallbackGenre = 'Latin & Caribbean';
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
    const year = _parseYearStrict(best.year);

    let genre = null;
    for (const it of useList.slice(0, 3)) {
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
      else if (al.includes('latin') || al.includes('salsa')) genre = 'Latin & Caribbean';
      else if (al.includes('punk') || al.includes('grunge')) genre = 'Punk, Grunge & Alternative';
      else if (al.includes('metal')) genre = 'Heavy Metal & Loud';
      else if (al.includes('electronic') || al.includes('techno')) genre = 'Electronic, House & Techno';
    }
    const trusted = usedMasters && matching.length > 0;
    return { genre, year, trusted };
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
    for (const it of useList) {
      if (!genre && it.primaryGenreName) {
        const mapped = mapToGenre15(it.primaryGenreName);
        if (mapped) genre = mapped;
      }
      const y = _parseYearStrict(it.releaseDate);
      if (y && (year === null || y < year)) year = y;
    }
    // iTunes year = untrusted
    return { genre, year, trusted: false };
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
      'latin':'Latin & Caribbean','salsa':'Latin & Caribbean',
      'afrobeat':'Afrobeat, African & World','african':'Afrobeat, African & World',
      'classical':'Classical, Opera & Score','opera':'Classical, Opera & Score','soundtrack':'Classical, Opera & Score'
    };
    for (const [keyword, genre] of Object.entries(genreKeywords)) {
      if (text.includes(keyword)) return genre;
    }
    return null;
  } catch(e) { return null; }
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
function normalizeAlbumName(name){
  if(!name) return '';
  let s = String(name);
  // Strip parenthesized re-issue / live / version annotations
  s = s.replace(/\s*[\(\[]\s*(remaster(ed|isation)?(\s*\d{4})?|deluxe(\s*edition)?|special(\s*edition)?|expanded(\s*edition)?|anniversary(\s*edition)?|bonus(\s*track(\s*version)?)?|live(\s+(in|at|from|on)\s+[^\)\]]+)?|extended(\s+(version|cut|mix))?|director'?s\s*cut|original(\s+(motion\s+picture\s+)?soundtrack|\s+score)?)\s*[\)\]]/gi, '');
  // Strip trailing weird punctuation that came from filenames (e.g. "Brasileiro_")
  s = s.replace(/[\s_\-?!.]+$/, '');
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
  // Trailing connectors
  s = s.replace(/\s*[,&]\s*$/, '');
  return s.trim();
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
  const firstPass = await Promise.allSettled([
    fetchFromMusicBrainzEnhanced(albumQ, artistQ),
    fetchFromDiscogsPublic(artistQ, albumQ),
    fetchFromDeezer(albumQ, artistQ),
    fetchFromItunes(artistQ, albumQ)
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
      fetchFromItunes(artist, album)
    ]);
    results = secondPass.map(s => s.status === 'fulfilled' ? s.value : { genre: null, year: null, trusted: false });
  }

  const [mb, dg, dz, it] = results;

  // ── ANNÉE : PRIORITÉ ABSOLUE À L'ANNÉE ORIGINALE ──
  // MusicBrainz (first-release-date) et Discogs master sont les seules fiables
  // iTunes et Deezer donnent des dates de réédition digitale → IGNORÉES
  
  let year = null;
  let yearSource = null;
  
  // 1. MusicBrainz (très fiable pour les albums classiques)
  if (mb?.year && mb.trusted) {
    year = mb.year;
    yearSource = 'MusicBrainz';
  }
  
  // 2. Discogs master (fiable aussi)
  if (!year && dg?.year && dg.trusted) {
    year = dg.year;
    yearSource = 'Discogs';
  }
  
  // 3. MusicBrainz non-trusted (match imparfait mais mieux que rien)
  if (!year && mb?.year && !mb.trusted) {
    year = mb.year;
    yearSource = 'MusicBrainz (low trust)';
  }
  
  // 4. Discogs non-trusted
  if (!year && dg?.year && !dg.trusted) {
    year = dg.year;
    yearSource = 'Discogs (low trust)';
  }
  
  // ⚠️ iTunes et Deezer SONT IGNORÉS POUR L'ANNÉE
  // (ils donnent la date de mise en ligne sur le store, pas l'enregistrement)
  
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

  // Consensus signals — expose so renderer can decide whether to overwrite existing tags.
  // High-confidence flag: both trusted sources agreed, OR an artist override forced the value.
  const yearTrusted = !!(yearSource && yearSource.startsWith('MusicBrainz') && !yearSource.includes('low')) ||
                      !!(yearSource && yearSource.startsWith('Discogs') && !yearSource.includes('low'));
  const genreTrusted = !!((mb?.trusted && mb?.genre === genre) && (dg?.trusted && dg?.genre === genre)) ||
                       !!ctx.hasOverride;
  console.log(`[meta] ${artist} - ${album} → year: ${year || '?'} (${yearSource || 'none'}, trusted=${yearTrusted}), genre: ${genre || '?'} (trusted=${genreTrusted})`);
  return { genre, year, yearTrusted, genreTrusted };
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
  // Latin & Caribbean
  'silvio rodriguez': 'Latin & Caribbean', 'pablo milanes': 'Latin & Caribbean',
  'victor jara': 'Latin & Caribbean', 'violeta parra': 'Latin & Caribbean',
  'mercedes sosa': 'Latin & Caribbean', 'buena vista social club': 'Latin & Caribbean',
  'compay segundo': 'Latin & Caribbean', 'celia cruz': 'Latin & Caribbean',
  'caetano veloso': 'Latin & Caribbean', 'gilberto gil': 'Latin & Caribbean',
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

ipcMain.handle('fetch-online-meta', async (_, albumGroups) => {
  if (!Array.isArray(albumGroups) || !albumGroups.length) return {};
  const prefs = loadPrefs();
  prefs.trackMeta = prefs.trackMeta || {};
  const results = {};
  let totalUpdated = 0;
  let mbCallsSent = 0;

  for (let gi = 0; gi < albumGroups.length; gi++) {
    const group = albumGroups[gi];
    const { album, artist, paths } = group;
    if (!paths?.length) continue;

    const cacheKey = `${artist||''}||${album||''}`;
    const cached = _metaCache.has(cacheKey);

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
      multi = await fetchMetadataMultiSource(album, artist, { hasOverride });
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
            genreTrusted
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
      // Cache stores latest verdict; renderer applies overwrite policy.
      if (genre) updated.genre = genre;
      if (year)  updated.year  = year;
      if (updated.genre !== existing.genre || updated.year !== existing.year) {
        prefs.trackMeta[p] = updated;
        results[p] = {
          genre: updated.genre || null,
          year:  updated.year  || null,
          yearTrusted,
          genreTrusted
        };
        totalUpdated++;
      }
    }
    if (totalUpdated > 0 && totalUpdated % 10 === 0) savePrefs(prefs);
  }
  if (totalUpdated > 0) savePrefs(prefs);
  console.log(`[fetch-online-meta] ${totalUpdated} tracks updated from ${albumGroups.length} albums (${mbCallsSent} net, ${albumGroups.length - mbCallsSent} cached)`);
  return results;
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
      if (m.year) t.year = m.year;
      if (m.artist) t.artist = m.artist;
      if (m.album) t.album = m.album;
      if (m.userModified) t._userModified = true;
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
  prefs.customLists = lists.filter(pl => pl.custom || pl.smart || pl.merged).map(pl => ({ name: pl.name, custom: pl.custom||false, smart: pl.smart||false, merged: pl.merged||false, rules: pl.rules||null, trackRefs: (pl.tracks||[]).map(t => ({ path: t.path, title: t.title, artist: t.artist||'' })) }));
  if (covers && typeof covers === 'object') prefs.customCovers = Object.fromEntries(Object.entries(covers).slice(0, 200));
  savePrefs(prefs);
  return true;
});

ipcMain.handle('save-track-meta', (_, metaMap) => {
  if (!metaMap || typeof metaMap !== 'object') return false;
  const prefs = loadPrefs();
  prefs.trackMeta = prefs.trackMeta || {};
  Object.entries(metaMap).forEach(([path, meta]) => { const existing = prefs.trackMeta[path] || {}; prefs.trackMeta[path] = Object.assign({}, existing, meta); if (meta.userModified) prefs.trackMeta[path].userModified = true; });
  Object.keys(prefs.trackMeta).forEach(k => { const entry = prefs.trackMeta[k]; if (!entry.genre && !entry.year && !entry.userModified) delete prefs.trackMeta[k]; });
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
  _syncTracks.forEach(t => { if(t.path) { const id = crypto.createHash('md5').update(t.path).digest('hex').slice(0,12); _pathById.set(id, t.path); t._id = id; } });
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
    const m = p.match(/^\/f\/([a-f0-9]{12})$/);
    if(m){
      const id = m[1];
      const filePath = _pathById.get(id);
      if(!filePath || !fs.existsSync(filePath)){ res.writeHead(404); return res.end('Not found'); }
      const stat = fs.statSync(filePath);
      const range = req.headers.range;
      const ext = path.extname(filePath).toLowerCase();
      const mime = ext === '.mp3' ? 'audio/mpeg' : ext === '.m4a' ? 'audio/mp4' : ext === '.flac' ? 'audio/flac' : ext === '.wav' ? 'audio/wav' : ext === '.ogg' ? 'audio/ogg' : 'application/octet-stream';
      const fname = path.basename(filePath);
      if(range){
        const parts = range.replace(/bytes=/,'').split('-');
        const start = parseInt(parts[0],10);
        const end = parts[1] ? parseInt(parts[1],10) : stat.size-1;
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges':'bytes', 'Content-Length': end-start+1, 'Content-Type': mime, 'Content-Disposition': `attachment; filename="${fname}"` });
        return fs.createReadStream(filePath, {start,end}).pipe(res);
      }
      res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': mime, 'Accept-Ranges':'bytes', 'Content-Disposition': `attachment; filename="${fname}"` });
      return fs.createReadStream(filePath).pipe(res);
    }
    res.writeHead(404); res.end('Not found');
  } catch(e){ console.error('[sync-server]', e); try { res.writeHead(500); res.end('Server error'); } catch(_){} }
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

app.whenReady().then(() => { createWin(); app.on('activate', () => { if (!win) createWin(); }); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });