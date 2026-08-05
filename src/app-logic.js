// ── LOGIQUE DE L'APPLICATION ──

// Flag global de debug pour les fetches méta (unifiedSearch, fetchConsolidatedMeta).
// false = logs minimaux (seulement erreurs + bilan). true = verbose (chaque query, parse, match).
// Pour activer à la volée : window.WT_DEBUG_FETCH = true (dans la console DevTools).
let WT_DEBUG_FETCH = false;
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'WT_DEBUG_FETCH', {
    get: () => WT_DEBUG_FETCH,
    set: (v) => { WT_DEBUG_FETCH = !!v; console.log('[debug] WT_DEBUG_FETCH =', WT_DEBUG_FETCH); }
  });
}

// SOURCE DE VÉRITÉ UNIQUE pour le compteur "Infos à vérifier".
// Une seule définition utilisée partout : un track est "à vérifier" s'il est
// _incomplete (manquant ou conflit cache détecté) et non _userModified.
// Le flag _unidentified n'est PLUS utilisé pour exclure du compteur — un
// track tenté sans succès reste à vérifier (honnêteté envers l'user).
function countTracksToReview() {
  if (!Array.isArray(allTracks)) return 0;
  return allTracks.filter(t =>
    (t._incomplete || t._reviewPending) && !t._userModified && !t._ignored
  ).length;
}

function refreshReviewBadge() {
  if (typeof updateMetaSplitCount === 'function') {
    updateMetaSplitCount({ douteux: countTracksToReview(), manquants: 0 });
  }
}

// Détail du compteur, dérivé du MÊME set _incomplete (pas de second flag).
// Manquants = genre ou année absent/junk. Incertains = le reste des _incomplete
// (conflit cache vs tag détecté par buildMetaDiffs : genre+année présents mais
// contradictoires). Le total = countTracksToReview().
function _trackIsMissing(t) {
  const noG = !t.genre || (typeof isJunkGenre === 'function' && isJunkGenre(t.genre));
  const noY = !t.year  || (typeof isJunkYear  === 'function' && isJunkYear(t.year));
  return noG || noY;
}
function countManquants() {
  if (!Array.isArray(allTracks)) return 0;
  return allTracks.filter(t => t._incomplete && !t._userModified && !t._ignored && _trackIsMissing(t)).length;
}
function countIncertains() {
  if (!Array.isArray(allTracks)) return 0;
  return allTracks.filter(t => t._incomplete && !t._userModified && !t._ignored && !_trackIsMissing(t)).length;
}

// Reconstruit la liste filtrée courante selon le bucket actif (utilisé par
// saveOmni pour retirer un morceau édité sans quitter la vue). On déduit le
// bucket du contenu de `filtered` : si tous _autoProcessed → fichiers traités,
// sinon → à compléter (_incomplete non ignorés).
function _rebuildCurrentBucket(){
  if(!Array.isArray(allTracks)) return [];
  const cur = Array.isArray(filtered) ? filtered : [];
  const looksProcessed = cur.length && cur.every(t => t && t._autoProcessed);
  if(looksProcessed) return allTracks.filter(t => t._autoProcessed && !t._ignored);
  return allTracks.filter(t => t._incomplete && !t._userModified && !t._ignored);
}

// Marque/démarque une sélection comme "ignorée" pour les infos manquantes.
// Un morceau ignoré sort des compteurs et des vues de revue, mais on ne touche
// pas à ses tags : c'est purement un "ne plus me le proposer".
function setIgnoredForReview(tracks, ignored){
  let n=0;
 (tracks||[]).forEach(t=>{ if(!t) return; if(ignored){ t._ignored=true; delete t._reviewPending; } else { delete t._ignored; } n++; });
  if(typeof refreshReviewBadge==='function') refreshReviewBadge();
  if(typeof scheduleMetaSave==='function') scheduleMetaSave();
  if(typeof _inCompleteBucket!=='undefined' && _inCompleteBucket && typeof _rebuildCurrentBucket==='function'){
    filtered=_rebuildCurrentBucket();
    if(typeof applySortToFiltered==='function') applySortToFiltered();
    if(typeof renderVirtual==='function') renderVirtual();
  }
  if(typeof toast==='function') toast(ignored?`${n} morceau${n!==1?'x':''} ignoré${n!==1?'s':''} pour les infos`:`${n} morceau${n!==1?'x':''} réintégré${n!==1?'s':''}`);
}

// Handler clic-droit : opère sur la sélection multiple si le morceau cliqué en
// fait partie, sinon sur le seul morceau cliqué.
function tctxToggleIgnore(){
  const t=_tctxTrack;
  let targets;
  if(t && selectedPaths.has(t.path) && selectedPaths.size>1){
    targets=allTracks.filter(x=>selectedPaths.has(x.path));
  } else {
    targets=t?[t]:[];
  }
  const anyNotIgnored=targets.some(x=>!x._ignored);
  setIgnoredForReview(targets, anyNotIgnored);
  if(typeof hideTrackCtxMenu==='function') hideTrackCtxMenu();
}

// Journal de session des corrections appliquées AUTOMATIQUEMENT par l'enrichQueue.
// L'user doit pouvoir contrôler ce que l'outil a changé en silence (genre/année).
const _autoFixLog = [];
if (typeof window !== 'undefined') window._autoFixLog = _autoFixLog;
function recordAutoFix(track, fix) {
  _autoFixLog.push({
    path:   track.path,
    title:  track.title || (track.path ? track.path.split('/').pop() : ''),
    artist: track.artist || '',
    genre:  fix.genre || null,
    year:   fix.year  || null,
    source: fix.source || 'lazy-auto',
    ts:     fix.ts || Date.now(),
  });
}
// Corrections auto pas encore validées : un morceau édité à la main (_userModified)
// sort de la liste (l'user l'a vu et traité).
function countAutoFixes() {
  if (!Array.isArray(allTracks)) return 0;
  return allTracks.filter(t => t._autoFixed).length;
}
// Tous les morceaux que la queue a TENTÉ de traiter (corrigés OU rien trouvé).
function countAutoProcessed() {
  if (!Array.isArray(allTracks)) return 0;
  return allTracks.filter(t => t._autoProcessed).length;
}
function countAutoProposed() {
  if (!Array.isArray(allTracks)) return 0;
  return allTracks.filter(t => t._autoOutcome === 'proposed').length;
}

// Circuit-breaker MusicBrainz : après N erreurs réseau d'affilée pendant
// une session, on désactive MB le temps de la session pour ne pas
// l'enquiquiner (et accélérer les fetches qui le sautent).
let _mbConsecutiveErrors = 0;
let _mbDisabledForSession = false;
const _MB_ERROR_THRESHOLD = 5;
function mbReportError() {
  _mbConsecutiveErrors++;
  if (_mbConsecutiveErrors >= _MB_ERROR_THRESHOLD && !_mbDisabledForSession) {
    _mbDisabledForSession = true;
    console.warn(`[mb] désactivé pour la session après ${_MB_ERROR_THRESHOLD} erreurs consécutives`);
  }
}
function mbReportSuccess() { _mbConsecutiveErrors = 0; }
function mbIsDisabled() { return _mbDisabledForSession; }

function checkFsOverflow() {
  // Titre
  const titleWrap = document.querySelector('.fs-title-wrap');
  const title = document.getElementById('fsTitle');
  if (titleWrap && title) {
    titleWrap.classList.remove('overflow');
    setTimeout(() => {
      if (title.scrollWidth > titleWrap.clientWidth + 2) {
        titleWrap.classList.add('overflow');
      }
    }, 10);
  }
  
  // Artiste
  const artistWrap = document.querySelector('.fs-artist-wrap');
  const artist = document.getElementById('fsArtist');
  if (artistWrap && artist) {
    artistWrap.classList.remove('overflow');
    setTimeout(() => {
      if (artist.scrollWidth > artistWrap.clientWidth + 2) {
        artistWrap.classList.add('overflow');
      }
    }, 10);
  }
}




// ============================================================
// CONFIGURATION
// ============================================================

const LAST_FM_KEY = "";  // Optionnel : s'inscrire sur https://www.last.fm/api (gratuit)
const _metadataCache = new Map();

// ============================================================
// FETCH HELPER : timeout 8s + 1 retry après 2s sur erreur réseau ou 5xx
// Utilisé par tous les fetchers d'identification UI pour ne pas bloquer
// l'utilisateur quand une seule source est lente ou down.
// ============================================================
async function fetchWithTimeout(url, opts = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
async function fetchWithRetry(url, opts = {}, timeoutMs = 8000) {
  try {
    const r = await fetchWithTimeout(url, opts, timeoutMs);
    if (r.status >= 500 && r.status < 600) {
      await new Promise(res => setTimeout(res, 2000));
      return await fetchWithTimeout(url, opts, timeoutMs);
    }
    return r;
  } catch (e) {
    if (e.name === 'AbortError' || e.message?.includes('network') || e.message?.includes('fetch')) {
      try {
        await new Promise(res => setTimeout(res, 2000));
        return await fetchWithTimeout(url, opts, timeoutMs);
      } catch (e2) { throw e2; }
    }
    throw e;
  }
}

// ============================================================
// FONCTION PRINCIPALE UNIFIED SEARCH
// ============================================================

// Cache mémoire de unifiedSearch : déduplique les requêtes identiques pendant
// une session (l'enrichQueue traite souvent N tracks d'un même artiste/album,
// on évite les requêtes redondantes). TTL = lifetime de l'app, invalidé si
// l'user clique manuellement Rechercher.
const _unifiedSearchCache = new Map();
function _unifiedSearchCacheKey(query) {
  if (!query) return null;
  if (typeof query === 'string') return `str|${query.toLowerCase().trim()}`;
  const a = (query.artist || '').toLowerCase().trim();
  const al = (query.album || '').toLowerCase().trim();
  return `q|${a}||${al}`;
}

async function unifiedSearch(query) {
  // Cache hit ?
  const _cacheKey = _unifiedSearchCacheKey(query);
  if (_cacheKey && !query._force && _unifiedSearchCache.has(_cacheKey)) {
    if (WT_DEBUG_FETCH) console.debug('[unifiedSearch] cache HIT', _cacheKey);
    return _unifiedSearchCache.get(_cacheKey);
  }

  const results = {
    covers: [],
    bestMatch: {
      artist: null,
      album: null,
      year: null,
      yearSource: null,
      genre: null,
      cover: null
    }
  };

  if (WT_DEBUG_FETCH) console.debug('[unifiedSearch] Searching for:', query);

  try {
    // Accept either:
    //   - a structured query: { artist: "...", album: "..." } — preferred, no guessing
    //   - a free-text string: heuristically split (legacy / user-typed)
    let artist = '';
    let album = '';
    let cleanText = '';
    // C209 : artist/album issus d'un DÉCOUPAGE HEURISTIQUE du texte libre (et non
    // de tags ni d'une source) → interdit de les présenter comme un résultat.
    let _guessed = false;

    if (query && typeof query === 'object' && (query.artist || query.album)) {
      artist = (query.artist || '').trim();
      album  = (query.album  || '').trim();
      cleanText = (artist + ' ' + album).trim();
    } else {
      let cleanQuery = String(query || '');
      cleanQuery = cleanQuery.replace(/\[(?:Disc|CD|Disk|Live)\s*\d*\]/gi, '');
      cleanQuery = cleanQuery.replace(/\((?:Deluxe|Remaster|Edition|Remastered)\)/gi, '');
      cleanQuery = cleanQuery.replace(/\s{2,}/g, ' ').trim();
      cleanText = cleanQuery;
      album = cleanQuery;
      if (cleanQuery.includes(' - ')) {
        const parts = cleanQuery.split(' - ');
        artist = parts[0].trim();
        album  = parts.slice(1).join(' - ').trim();
      } else {
        const words = cleanQuery.split(/\s+/).filter(Boolean);
        if (words.length >= 2) {
          const albumWords = Math.min(3, Math.floor(words.length / 2));
          artist = words.slice(0, -albumWords).join(' ');
          album  = words.slice(-albumWords).join(' ');
          _guessed = true;   // C209 : « Gong Under Ground Modern » → « Gong Under » = artefact
        }
      }
      // B.O. tapée à la main ("Snatch soundtrack") : ne PAS découper en artiste
      // (sinon artiste="Snatch" → faux match "Jedi - Snatch"). On cherche l'album
      // par son nom de film, artiste vide → le main fait une recherche par terme.
      const _ostKw = /(soundtrack|original motion picture|motion picture|bande originale|\bb\.?\s?o\.?\b|\bost\b|trame sonore)/i;
      if (_ostKw.test(cleanQuery)) { artist = ''; album = cleanQuery; _guessed = false; }
    }

    const lowerQuery = cleanText.toLowerCase();
    const isLive = lowerQuery.includes('live') || lowerQuery.includes('bbc sessions') || lowerQuery.includes('concert');
    const isCompilation = lowerQuery.includes('best of') || lowerQuery.includes('greatest hits') || 
                          lowerQuery.includes('complete') || lowerQuery.includes('collection');
    
   if (WT_DEBUG_FETCH) console.debug('[unifiedSearch] Parsed:', { artist, album, isLive });

    // ── NETTOYAGE POUR WIKIPEDIA (work-centric) ────────────────────────────
    // Wikipedia matche sur l'ŒUVRE (Mozart Don Giovanni K.527, Bach BWV 1046,
    // Sing Sing Sing 1936, etc.). Les tags fichiers contiennent souvent :
    //   - numéro de piste : "14 Don Giovanni..."  → on retire
    //   - mouvement/scène : "Act I Scene 2", "1. Allegro"  → on coupe
    //   - rôle/interprète : "(Leporello)", "(Live)"  → on retire
    //   - faux artiste = interprète au lieu du compositeur (ex. "Xaver Meyer")
    //     → on garde l'artiste original mais on DÉDUIT le compositeur depuis
    //     les marqueurs K./BWV/Op. dans le titre (Phase Étape 2 — TODO)
    // Le résultat (wikiArtist/wikiAlbum) sert UNIQUEMENT à Wikipedia. Les autres
    // sources reçoivent l'original (elles préfèrent les requêtes complètes).
    function _normalizeForWiki(a, t) {
      let _a = (a || '').trim();
      let _t = (t || '').trim();

      // 1. Retire numéro de piste en tête : "14 ", "01 - ", "Track 5: ", "CD1-03 "
      _t = _t.replace(/^(?:cd\s*\d+\s*[-.\s]+)?(?:track\s*)?\d{1,3}\s*[-.\s]+/i, '');

      // 2. Retire les suffixes parenthésés non-essentiels : (Live), (2007 Remaster),
      //    (Leporello), [Bonus Track], (feat. ...), (Acoustic Version)...
      _t = _t.replace(/\s*[\(\[][^)\]]*[\)\]]/g, '').trim();

      // 3. Coupe les indicateurs de mouvement/scène/numéro après une virgule ou ":".
      //    "Don Giovanni, Opera, K.527, Act I Scene 2. Madamina..." → on cherche le
      //    1er marqueur opus/Köchel/BWV et on coupe APRÈS lui (l'œuvre se termine là).
      //    Sinon, on coupe à "Act ", "Scene ", "Movement ", "Mvt." quand présents.
      const _opusMatch = _t.match(/\b(k\.?\s*\d{2,}|op\.?\s*\d{1,3}|bwv\s*\d{1,4}|hob\.?[\s\w]*\d+|d\.?\s*\d{3,})/i);
      if (_opusMatch) {
        const _idx = _opusMatch.index + _opusMatch[0].length;
        _t = _t.slice(0, _idx).replace(/[,;:\s]+$/, '').trim();
      } else {
        _t = _t.replace(/\s*[,:;]\s*(act\s+[ivx\d]+|scene\s+\d|mvt\.?\s|movement\s+\d|part\s+[ivx\d]).*$/i, '').trim();
        // Coupe aussi sur ": " général si le segment d'après ressemble à un sous-titre
        // de mouvement (ex. "Symphony No. 9: II. Molto vivace")
        _t = _t.replace(/\s*:\s+[ivx]+\.\s.*$/i, '').trim();
      }

      // 4. Retire les guillemets/tirets/virgules en fin de chaîne (résidus)
      _t = _t.replace(/^[\s"',\-.:]+|[\s"',\-.:]+$/g, '').trim();

      // 5. Si l'artiste contient une virgule (ex. "Mozart, Wolfgang" tag classique inverse),
      //    on inverse → "Wolfgang Mozart"
      if (/^[^,]+,\s*[^,]+$/.test(_a)) {
        const _parts = _a.split(',').map(p => p.trim());
        _a = _parts[1] + ' ' + _parts[0];
      }

      return { a: _a, t: _t };
    }
    const { a: _wikiArtist, t: _wikiAlbum } = _normalizeForWiki(artist, album);
    if (_wikiArtist !== artist || _wikiAlbum !== album) {
      if (WT_DEBUG_FETCH) console.debug('[unifiedSearch] Wiki-normalized:', { artist: _wikiArtist, album: _wikiAlbum });
    }

    // === 3. SOURCE UNIQUE : le MAIN PROCESS (throttlé, sans 503) ===
    // OPTION A : plus aucun fetch réseau depuis le renderer. On délègue toutes
    // les sources (MusicBrainz, Discogs, Deezer, iTunes, Wikipedia, Last.fm) au
    // main via window.wt.fetchOnlineMeta, qui respecte User-Agent + throttle
    // 1 req/s + back-off. Le main renvoie rawByField (valeurs brutes par source,
    // avec le tag brut pour les sous-genres). La consolidation/trust reste ici.
    let mainRes = null;
    try {
      if (window.wt?.fetchOnlineMeta) {
        const _path = 'usq::' + (artist||'') + '||' + (album||'');
        const _groups = [{ artist, album, title: query.title || '', _force: !!query._force, paths: [_path] }];
        const _out = await window.wt.fetchOnlineMeta(_groups);
        mainRes = _out && _out[_path] ? _out[_path] : null;
      } else if (WT_DEBUG_FETCH) {
        console.warn('[unifiedSearch] window.wt.fetchOnlineMeta indisponible (Electron pas redémarré ?)');
      }
    } catch(e) {
      console.warn('[unifiedSearch] fetchOnlineMeta a échoué:', e?.message || e);
    }

    // rawByField principal : ce que le main a calculé par source.
    const rawByField = { year: [], genre: [], artist: [], album: [], cover: [] };
    const mainRBF = mainRes?.rawByField || null;
    if (mainRBF) {
      // C215 : `q` = qualité du match de la source (C214). Sans ce report, elle
      // était perdue au mapping et le score de confiance n'aurait rien à pondérer.
      for (const e of (mainRBF.year   || [])) if (e?.value) rawByField.year.push({ value: parseInt(e.value), source: e.source || 'main', q: (typeof e.q === 'number' ? e.q : 0.5) });
      for (const e of (mainRBF.genre  || [])) {
        // value = parent mappé (peut être null), raw = tag brut (pour clientMapChild)
        if (e?.value)   rawByField.genre.push({ value: e.value, source: e.source || 'main', raw: e.raw || e.value, q: (typeof e.q === 'number' ? e.q : 0.5) });
        else if (e?.raw) rawByField.genre.push({ value: null, source: e.source || 'main', raw: e.raw, q: (typeof e.q === 'number' ? e.q : 0.5) });
      }
      for (const e of (mainRBF.artist || [])) if (e?.value) rawByField.artist.push({ value: e.value, source: e.source || 'main', q: (typeof e.q === 'number' ? e.q : 0.5) });
      for (const e of (mainRBF.album  || [])) if (e?.value) rawByField.album.push({  value: e.value, source: e.source || 'main' });
      for (const c of (mainRBF.cover  || [])) if (c?.url)   rawByField.cover.push(c);
    }
    // Fallback : si le main n'a pas renvoyé de rawByField mais a une valeur
    // consolidée (genre/year), on l'injecte pour ne pas perdre l'info.
    if (!rawByField.year.length && mainRes?.year)   rawByField.year.push({ value: parseInt(mainRes.year), source: mainRes.yearTrusted ? 'MusicBrainz' : 'main' });
    if (!rawByField.genre.length && mainRes?.genre) rawByField.genre.push({ value: mainRes.genre, source: mainRes.genreTrusted ? 'MusicBrainz' : 'main', raw: mainRes.genre });

    // bestMatch (compat consommateurs existants : pickers, covers UI)
    const _by = rawByField.year[0]?.value || null;
    const _bg = rawByField.genre.find(g => g.value)?.value || null;
    // C209 : ne JAMAIS présenter une DEVINETTE de découpage comme un résultat.
    // Si aucune source ne corrobore, on renvoie null plutôt qu'un artefact de
    // parsing — sinon « Gong Under » atterrissait dans le champ ARTISTE de
    // l'éditeur (ligne omniArtist.value) et partait dans le fichier au Save.
    // Requête structurée : artist/album SONT les tags du fichier → on les garde.
    results.bestMatch = {
      artist: rawByField.artist[0]?.value || (_guessed ? null : artist),
      album:  rawByField.album[0]?.value  || (_guessed ? null : album),
      year:   _by,
      yearSource: rawByField.year[0]?.source || null,
      genre:  _bg,
      cover:  null
    };
    results.rawByField = rawByField;
    results.covers = rawByField.cover;

    if (WT_DEBUG_FETCH) console.debug('[unifiedSearch] (main) best match:', results.bestMatch);
    const _hasUsefulData = !!(results.bestMatch?.year || results.bestMatch?.genre);
    if (_cacheKey && _hasUsefulData) _unifiedSearchCache.set(_cacheKey, results);
    return results;
    return results;
    
  } catch (err) {
    console.error('[unifiedSearch] Error:', err);
    return results;
  }
}

// ============================================================
// (Spotify retiré — nécessite OAuth Bearer token qu'on n'a pas)
// ============================================================

// ════════════════════════════════════════════════════════════════════════
// fetchConsolidatedMeta(track) — architecture par champ (chat 6, étape A)
// ────────────────────────────────────────────────────────────────────────
// Wrapper au-dessus de unifiedSearch. Lance plusieurs queries (artist+album,
// artist+title, +repli si l'artiste tag est pourri), agrège les `rawByField`
// de chaque, puis applique des règles de trust DIFFÉRENCIÉES par champ pour
// produire le modèle cible :
//   { cover, year, artist, album, genre, title }
// où chaque champ = { value, source, trusted, candidates: [...] }.
//
// Trust :
//   year   : Wikipedia (work-source) OU convergence ≥3 sources ±1 an.
//   genre  : MusicBrainz (éditorial) OU convergence ≥2 sources sur même bucket.
//   artist : tag local match top consensus (lowercase + inclusion) ET ≥2 votes.
//   album  : convergence ≥2 sources ET match _albumMatches avec le tag local.
//   cover  : album du candidat match le tag local ET quality ≥ 500.
//   title  : tag local (toujours trusted en P1 ; pas de réécriture auto).
//
// PASSE 2 : si artist non-trusted ET marqueur d'œuvre (Köchel/BWV/D./Hob.)
// dans le titre → on déduit le compositeur, on relance unifiedSearch avec le
// bon artiste, on re-agrège. Une seule passe 2 max (pas de récursion).
//
// REPLI ALBUM-SEUL : si aucun candidat cover ne matche l'album du tag, on
// relance avec {artist:'', album: track.album}. Réinjecte dans le pool.
//
// USAGE :
//   await window.testConsolidated(allTracks[42])
// Le retour est PURE DATA : aucun side-effect, aucune écriture sur le track,
// aucun changement DOM. C'est l'orchestrateur UI (patch 4) qui consommera.
// ════════════════════════════════════════════════════════════════════════

async function fetchConsolidatedMeta(track) {
  if (!track) return null;

  // ── 1. Construction des queries (mêmes principes que searchCrossReference,
  //    mais STRUCTURÉES uniquement, jamais de chaîne libre).
  const queries = [];
  if (track.artist && track.album) queries.push({ artist: track.artist, album: track.album });
  if (track.artist && track.title) queries.push({ artist: track.artist, album: track.title });
  if (queries.length === 0) {
    if (track.album)      queries.push({ artist: '', album: track.album });
    else if (track.title) queries.push({ artist: '', album: track.title });
  }
  if (queries.length === 0) {
    console.warn('[fetchConsolidatedMeta] track sans artist/album/title — abort');
    return null;
  }

  if (WT_DEBUG_FETCH) console.debug('[fetchConsolidatedMeta] queries:', queries);

 // ── 2. PASSE 1 — résolution naïve avec les tags tels quels.
  let allResults = await Promise.all(queries.map(q => unifiedSearch(q)));
  let pool = _aggregateRawByField(allResults);

  // ── 2bis. PAS D'ALBUM FIABLE → recherche par ENREGISTREMENT (titre).
  // Sans vrai album, chercher le titre COMME un album (PASSE 1) tombe sur des
  // compils récentes : ex. 4 Non Blondes "What's Up" → 2013 + R&B au lieu de
  // 1992 + rock. La recherche par enregistrement donne l'année d'ORIGINE (1re
  // sortie MB) + le genre du vrai artiste. On REMPLACE année/genre/artiste (le
  // bruit "titre comme album"), en gardant les covers de la passe 1.
  const _albReliable = track.album && track.album.trim() &&
    !/^\[?\s*(unknown|inconnu|untitled|sans titre|various|va)(\s+album)?\s*\]?$/i.test(track.album.trim());
  if (!_albReliable && track.title && typeof _searchByTrack === 'function') {
    try {
      const _tr = await _searchByTrack(track, track.year ? parseInt(track.year) : null, false);
      const _bm = _tr && _tr[0] && _tr[0].bestMatch;
      if (_bm && (_bm.year || _bm.artist)) {
        pool.year   = _bm.year   ? [{ value: parseInt(_bm.year), source: _bm.source || 'recherche par titre' }] : [];
        pool.artist = _bm.artist ? [{ value: _bm.artist, source: _bm.source || 'recherche par titre' }] : [];
        if (_bm.genre) {
          const _gp = (typeof clientMapGenre === 'function') ? clientMapGenre(_bm.genre) : _bm.genre;
          pool.genre = _gp ? [{ value: _gp, source: _bm.source || 'recherche par titre', raw: _bm.genre }] : [];
        } else {
          pool.genre = [];
        }
        console.log('[fetchConsolidatedMeta] sans album → enregistrement:', _bm.artist, '/', _bm.year, '/', _bm.genre);
      }
    } catch (e) { /* silent */ }
  }

  // Pour les COMPILS / BEST-OF / B.O. / LIVE, l'année renvoyée par l'album est
  // celle de la compilation (fausse) → on la REMPLACE par l'année d'ORIGINE via
  // la recherche par enregistrement (le moteur du clic). Album normal sans année :
  // on la COMPLÈTE pareil. Une recherche en plus, en fond (enrichQueue throttle)
  // → c'est ce qui résout tes "Aucune info" (compils/best-of) tout seul.
  const _haveYear = pool.year.some(y => y && y.value);
  const _isComp = isCompilationTrack(track);   // C207 : détecteur unique
  // C219 : si AUCUNE source en ligne n'a identifié l'album (pool artiste ET album
  // vides), la recherche par ENREGISTREMENT est la dernière chance d'identifier
  // le morceau. C'est elle qui sauve les albums absents de toutes les bases —
  // tango confidentiel, folk andin, live obscurs. Sans elle, le garde-fou refuse
  // TOUT, genre plausible compris.
  // (Régression introduite par C218 : l'album live n'étant plus une « compil »,
  // et une année traînant dans le pool, la condition (_isComp || !_haveYear)
  // devenait fausse → les 10 titres d'« Alfredo Marcucci » passaient de
  // « à vérifier » à REFUS pur et simple.)
  const _albIdentified = (pool.artist && pool.artist.length > 0)
                      || (pool.album  && pool.album.length  > 0);
  if (_albReliable && track.title && (_isComp || !_haveYear || !_albIdentified) && typeof _searchByTrack === 'function') {
    try {
      const _try = await _searchByTrack(track, _isComp ? null : (track.year ? parseInt(track.year) : null));
      const _bmy = _try && _try[0] && _try[0].bestMatch;
      if (_bmy) {
        // C216 : Corroboration — l'artiste trouvé par titre recoupe-t-il le tag ?
        // La comparaison se faisait sur les chaînes BRUTES : « los líderes » ne
        // contenait pas « los lideres » (accent), la corroboration échouait, et
        // le garde-fou aval REFUSAIT tout — année comprise, alors qu'elle était
        // trouvée. Tout le catalogue hispanophone/andin était touché.
        // _normArtistKey fait déjà du NFD ; ici il faut garder les espaces pour
        // le test mot-à-mot, d'où cette normalisation dédiée.
        const _deacc = s => String(s || '').toLowerCase().normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, ' ')
          .replace(/\s+/g, ' ').trim();
        const _aLoc = _deacc(track.artist);
        const _aFnd = _deacc(_bmy.artist);
        const _corrob = !!_aLoc && !!_aFnd && (_aLoc.includes(_aFnd) || _aFnd.includes(_aLoc) ||
          _aLoc.split(/\s+/).some(w => w.length > 3 && _aFnd.includes(w)));
        // C217 : qualité de match de CETTE source. La corroboration prouve que
        // l'artiste trouvé est bien celui du tag → q élevé. Sans corroboration,
        // c'est une piste incertaine → q faible. Sans ça, elle héritait du 0.5
        // « neutre » par défaut et pesait pareil dans les deux cas.
        const _corrQ = _corrob ? 0.95 : 0.45;
        // FIX RACINE : l'artiste CORROBORÉ entre dans le pool avec sa source en
        // ligne. Sans ça, l'artiste consolidé restait source 'local-tag' même
        // quand la recherche trouvait EXACTEMENT le tag (« Grupo Aymara »), et le
        // garde-fou aval refusait TOUT (année comprise) en croyant qu'aucune
        // source ne connaissait le morceau.
        // MAIS on pousse la valeur du TAG LOCAL (confirmée), jamais la variante
        // en ligne : sinon « The Blues Brothers & Aretha Franklin » (version
        // Blues Brothers 2000) pouvait supplanter le tag « Aretha Franklin ».
        // La corroboration prouve que le tag est bon — elle ne le remplace pas.
        if (_corrob) pool.artist.push({ value: track.artist, source: (_bmy.source || 'recherche par titre') + ' [confirme le tag]', q: _corrQ });
        if (_bmy.year) {
          if (_isComp) pool.year = [{ value: parseInt(_bmy.year), source: (_bmy.source || 'recherche par titre') + (_corrob ? ' [corroboré]' : ''), q: _corrQ }];
          else pool.year.push({ value: parseInt(_bmy.year),
            source: (_bmy.source || 'recherche par titre') + (_corrob ? ' [corroboré]' : ''), q: _corrQ });
          console.log('[fetchConsolidatedMeta] annee ' + (_isComp ? '(compil->origine)' : '(completee)') + ':', _bmy.year + (_corrob ? ' [artiste corroboré]' : ''));
        }
        // Genre du match : utilisable pour une compil OU quand l'artiste est
        // corroboré (c'est le bon morceau) et que le pool n'a rien d'autre.
        if (_bmy.genre && (_isComp || _corrob) && !(pool.genre && pool.genre.length)) {
          pool.genre = [{ value: _bmy.genre, source: _bmy.source || 'recherche par titre', raw: _bmy.genre, q: _corrQ }];
        }
      }
    } catch (e) { /* silent */ }
  }


  // ── 3. PASSE 2 — correction artiste si tag pourri détecté.
  // Signal : marqueur d'œuvre (K./BWV/D./Hob.) dans title ou album, ET
  // l'artiste tag n'apparaît dans aucun candidat artist du pool.
  const tagArtist = (track.artist || '').trim();
  const composer  = _detectComposerFromMarkers(track.title || '', track.album || '');
  let pass2Done = false;
 if (composer && _tagArtistAbsentFromPool(tagArtist, pool, composer)) {
    console.log('[fetchConsolidatedMeta] PASSE 2 — compositeur déduit:', composer, '(tag pourri:', tagArtist || '∅', ')');
    const titleHasMarker = !!_detectComposerFromMarkers(track.title || '', '');
    const albumHasMarker = !!_detectComposerFromMarkers('', track.album || '');
    const pass2Queries = [];
    if (albumHasMarker && track.album) pass2Queries.push({ artist: composer, album: track.album });
    if (titleHasMarker && track.title) pass2Queries.push({ artist: composer, album: track.title });
    if (pass2Queries.length === 0) {
      const work = track.album || track.title || '';
      pass2Queries.push({ artist: composer, album: work });
    }
    const pass2Results = await Promise.all(pass2Queries.map(q => unifiedSearch(q)));
    allResults = allResults.concat(pass2Results);
    pool = _aggregateRawByField(allResults);
    pass2Done = true;
  }

 // ── 4. REPLI album-seul si aucun cover pertinent pour l'album du tag.
  //    Skip si Wikipedia work-source déjà identifiée comme œuvre classique
  //    (le repli ne trouvera pas de pochette commerciale pour une œuvre).
  const wantedAlbum = track.album || '';
  if (wantedAlbum) {
    const relevantCovers = pool.cover.filter(c => _albumMatches(wantedAlbum, c.album));
    const hasWikiYear = pool.year.some(y => /Wikipedia/i.test(y.source || ''));
    // OPTION A : le repli album-seul (artiste vide) ne sert qu'à récupérer une
    // POCHETTE en bonus. Depuis que tout passe par le main (qui cherche sur
    // artiste+album), une requête sans artiste ne ramène quasi jamais rien et
    // gaspille un appel throttlé (+ timeouts/429). On ne le déclenche donc QUE
    // si on a déjà identifié genre OU année (= morceau reconnu, on complète juste
    // la cover). Pour un morceau totalement vide (obscur), chercher sans artiste
    // n'aiderait pas → on saute, c'est plus optimal et plus discret.
    const _hasGenre = pool.genre.some(g => g && g.value);
    const _hasYear  = pool.year.some(y => y && y.value);
    const _worthFallback = (_hasGenre || _hasYear);
    if (relevantCovers.length === 0 && !hasWikiYear && _worthFallback) {
      // ALBUM GÉNÉRIQUE : une requête SANS artiste sur « Greatest Hits Disc 1 »
      // ramène la pochette du plus vendu (Queen…) pour un album d'Elvis. Si on
      // a un artiste local, il entre dans la requête de repli ; sans artiste,
      // on ne tente le repli que si le nom d'album est distinctif.
      const _genericAlb = /\b(greatest\s*hits|best\s*of|gold|anthology|collection|essential|the\s*hits|hits|live|vol(ume)?\.?\s*\d*|disc\s*\d+|cd\s*\d+)\b/i.test(wantedAlbum);
      const _fbArtist = (track.artist || '').trim();
      let fallback = null;
      if (_genericAlb && _fbArtist) {
        console.log('[fetchConsolidatedMeta] repli cover (artiste+album, album générique):', _fbArtist, '/', wantedAlbum);
        fallback = await unifiedSearch({ artist: _fbArtist, album: wantedAlbum });
      } else if (!_genericAlb) {
        console.log('[fetchConsolidatedMeta] repli cover (album seul):', wantedAlbum);
        fallback = await unifiedSearch({ artist: '', album: wantedAlbum });
      } else {
        console.log('[fetchConsolidatedMeta] repli cover SKIP (album générique sans artiste):', wantedAlbum);
      }
      if (fallback) {
        allResults.push(fallback);
        // FIX RACINE (bis) : le repli ne sert qu'aux COVERS. La reconstruction du
        // pool écrasait l'artiste corroboré et l'année d'origine posés en amont
        // (2bis / compil→origine) → la consolidation retombait sur 'local-tag' et
        // le garde-fou refusait des morceaux pourtant reconnus (cf. Verve Remixed).
        // On reconstruit pour récupérer les covers, puis on RESTAURE les champs
        // identité déjà résolus.
        const _poolPrev = pool;
        pool = _aggregateRawByField(allResults);
        pool.year   = _poolPrev.year;
        pool.artist = _poolPrev.artist;
        pool.genre  = _poolPrev.genre;
      }
    } else if (relevantCovers.length === 0 && !_worthFallback) {
      // Rien trouvé du tout : on n'insiste pas avec une requête sans artiste.
      console.log('[fetchConsolidatedMeta] SKIP repli (rien trouvé, requête sans artiste inutile):', wantedAlbum);
    } else if (relevantCovers.length === 0 && hasWikiYear) {
      console.log('[fetchConsolidatedMeta] SKIP repli (œuvre classique, Wikipedia work-source détectée)');
    }
  }

  // ── 5. Consolidation par champ ──────────────────────────────────────
  const consolidated = {
    year:   _consolidateYear  (pool.year,   track.year),
    genre:  _consolidateGenre (pool.genre,  track.genre),
    artist: _consolidateArtist(pool.artist, tagArtist, pass2Done ? composer : null),
    album:  _consolidateAlbum (pool.album,  wantedAlbum),
    cover:  _consolidateCover (pool.cover,  wantedAlbum),
    title:  _consolidateTitle (track.title || ''),
  };

  // Métadonnées de diagnostic (non-bloquantes, pour debug UI)
  consolidated._meta = {
    queriesRun: queries.length + (pass2Done ? 2 : 0) + (pool.cover.length === 0 && wantedAlbum ? 1 : 0),
    pass2Done,
    composerDeduced: pass2Done ? composer : null,
  };

  if (WT_DEBUG_FETCH) console.debug('[fetchConsolidatedMeta] result:', consolidated);
  return consolidated;
}

// ── Helpers fetchConsolidatedMeta ───────────────────────────────────────

function _aggregateRawByField(results) {
  const pool = { year: [], genre: [], artist: [], album: [], cover: [] };
  for (const r of results) {
    if (!r || !r.rawByField) continue;
    for (const k of Object.keys(pool)) {
      if (Array.isArray(r.rawByField[k])) pool[k].push(...r.rawByField[k]);
    }
  }
  return pool;
}

// Compositeurs connus (nom de famille -> nom canonique complet). Sert à mettre
// le COMPOSITEUR dans le champ artiste pour le classique (et non l'interprète).
const _COMPOSERS = {
  beethoven:'Ludwig van Beethoven', mozart:'Wolfgang Amadeus Mozart', bach:'Johann Sebastian Bach',
  chopin:'Frédéric Chopin', brahms:'Johannes Brahms', tchaikovsky:'Pyotr Ilyich Tchaikovsky',
  schubert:'Franz Schubert', vivaldi:'Antonio Vivaldi', handel:'George Frideric Handel',
  haydn:'Joseph Haydn', wagner:'Richard Wagner', verdi:'Giuseppe Verdi', debussy:'Claude Debussy',
  ravel:'Maurice Ravel', liszt:'Franz Liszt', schumann:'Robert Schumann', mahler:'Gustav Mahler',
  dvorak:'Antonín Dvořák', grieg:'Edvard Grieg', rachmaninoff:'Sergei Rachmaninoff', rachmaninov:'Sergei Rachmaninoff',
  prokofiev:'Sergei Prokofiev', stravinsky:'Igor Stravinsky', sibelius:'Jean Sibelius',
  puccini:'Giacomo Puccini', rossini:'Gioachino Rossini', mendelssohn:'Felix Mendelssohn',
  elgar:'Edward Elgar', holst:'Gustav Holst', satie:'Erik Satie', faure:'Gabriel Fauré',
  bizet:'Georges Bizet', shostakovich:'Dmitri Shostakovich', bartok:'Béla Bartók',
  scarlatti:'Domenico Scarlatti', purcell:'Henry Purcell', monteverdi:'Claudio Monteverdi'
};
function _composerCanonical(name) {
  if (!name) return null;
  const key = String(name).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().split(/\s+/).pop();
  return _COMPOSERS[key] || null;
}
// Déduit le compositeur depuis le tag "Compositeur - Œuvre" / "Compositeur: Œuvre",
// ou depuis l'artiste/album s'il s'agit d'un compositeur connu. Renvoie le nom
// canonique ou null. N'est utilisé que pour le classique (pas de faux positif pop).
function _composerFromTags(album, artist, title) {
  const m = String(album || '').match(/^([^-:_]{2,40})\s*[-:_]\s*.+/);
  if (m) { const c = _composerCanonical(m[1]); if (c) return c; }
  // Premier mot du TITRE ou de l'album = compositeur connu ? (tags « Grieg Sigurd … »,
  // où le compositeur est en tête sans séparateur, et l'artiste est l'orchestre).
  const _lead = (x) => { const f = String(x || '').trim().replace(/^\d+[\s.\-]*/, '').replace(/_/g, ' ').split(/\s+/)[0] || ''; return _composerCanonical(f); };
  const cl = _lead(title) || _lead(album); if (cl) return cl;
  const ca = _composerCanonical(artist); if (ca) return ca;
  const cal = _composerCanonical(album);  if (cal) return cal;
  return null;
}

// Détection compositeur depuis marqueurs d'opus dans le titre ou l'album.
// Limité aux compositeurs avec marqueurs UNIVOQUES (K./BWV/D./Hob.).
// Op. est volontairement exclu : trop ambigu (Beethoven, Chopin, Brahms...).
function _detectComposerFromMarkers(title, album) {
  const text = ((title || '') + ' ' + (album || '')).toLowerCase();
  if (/\bk\.?\s*\d{2,4}\b/.test(text))         return 'Mozart';
  if (/\bbwv\s*\d{1,4}\b/.test(text))          return 'Bach';
  if (/\bhob\.?[\s\w]*\d+\b/.test(text))       return 'Haydn';
  if (/\bd\.?\s*\d{3,4}\b/.test(text) && /\bschubert\b/i.test(text)) return 'Schubert';
  return null;
}

// L'artiste tag est-il absent du pool de candidats ?
// True si tag vide OU si aucun candidat artist du pool ne contient le tag
// (et inversement). On considère qu'un tag présent dans 1 source minimum
// signale un tag "viable" — donc pas besoin de passe 2.
function _tagArtistAbsentFromPool(tagArtist, pool, composer) {
  const tag = (tagArtist || '').toLowerCase().trim();
  if (!tag) return true;
  // Le tag matche déjà le compositeur attendu → pas de passe 2 nécessaire.
  if (tag === composer.toLowerCase() || tag.includes(composer.toLowerCase())) return false;
  for (const a of pool.artist) {
    const v = (a.value || '').toLowerCase().trim();
    if (!v) continue;
    if (v === tag || v.includes(tag) || tag.includes(v)) return false;
  }
  return true;
}

function _consolidateYear(candidates, localYear) {
  const localY = localYear ? parseInt(localYear) : null;
  const out = { value: localY, source: localY ? 'local-tag' : null, trusted: false, candidates: [...candidates] };
  if (!candidates.length) return out;

 // 1. Wikipedia work-source : priorité absolue (composition/premiere/recorded).
  //    Si plusieurs hits Wikipedia, la plus ancienne gagne (philosophie
  //    composition > réédition, et protège du faux match — ex. Bach BWV 1007
  //    trouve 1717 ET 1997 Fallout → 1717 gagne).
  const wikis = candidates.filter(c => /Wikipedia/i.test(c.source || '') && parseInt(c.value) >= 1400);
  if (wikis.length) {
    const oldestWiki = wikis.sort((a, b) => parseInt(a.value) - parseInt(b.value))[0];
    out.value = parseInt(oldestWiki.value);
    out.source = wikis.length > 1 ? `${oldestWiki.source} (oldest of ${wikis.length} wiki)` : oldestWiki.source;
    out.trusted = true;
    return out;
  }

  // 2. Cluster ±1 an le plus dense ; trusted si ≥3 membres.
  const cluster = _findYearCluster(candidates);
  if (cluster && cluster.members.length >= 3) {
    // Année du cluster = plus ancienne (philosophie : composition > réédition).
    const oldest = Math.min(...cluster.members.map(m => parseInt(m.value)));
    out.value = oldest;
    out.source = `convergence (${cluster.members.length} sources ±1 an, plus ancienne)`;
    out.trusted = true;
    return out;
  }

  // 3. Aucune autorité → plus ancienne année cohérente (≥1400), non-trusted.
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

function _findYearCluster(candidates) {
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

function _consolidateGenre(candidates, localGenre) {
  // out.raw = tag brut de la source retenue (sert à clientMapChild pour le
  // sous-genre). On le porte systématiquement quand la source l'expose.
  const out = { value: localGenre || null, source: localGenre ? 'local-tag' : null, trusted: false, raw: null, candidates: [...candidates] };
  // Premier brut disponible (Last.fm surtout) — sert même si aucun parent mappé.
  const firstRaw = candidates.find(c => c && c.raw)?.raw || null;
  out.raw = firstRaw;
  // On ne raisonne le parent que sur les candidats qui ont une value (parent mappé).
  const valued = candidates.filter(c => c && c.value);
  if (!valued.length) return out; // aucun parent, mais out.raw peut exister

  // 1. MusicBrainz (éditorial) — trusted direct.
  const mb = valued.find(c => c.source === 'MusicBrainz' || c.source === 'MusicBrainz-RG');
  if (mb) {
    out.value = mb.value;
    out.source = 'MusicBrainz';
    out.trusted = true;
    out.raw = mb.raw || firstRaw;
    return out;
  }

  // 2. Convergence ≥2 sources sur le même bucket → trusted.
  const counts = new Map();
  for (const c of valued) counts.set(c.value, (counts.get(c.value) || 0) + 1);
  let best = null, bestCount = 0;
  for (const [g, n] of counts) { if (n > bestCount) { best = g; bestCount = n; } }
  if (best && bestCount >= 2) {
    out.value = best;
    out.source = `convergence (${bestCount} sources)`;
    out.trusted = true;
    out.raw = valued.find(c => c.value === best)?.raw || firstRaw;
    return out;
  }

  // 3. Une seule source → non-trusted, mais on garde value + raw.
  out.value = valued[0].value;
  out.source = valued[0].source;
  out.trusted = false;
  out.raw = valued[0].raw || firstRaw;
  return out;
}

// ══════════════════════════════════════════════════════════════════════
// C215 — SCORE DE CONFIANCE PONDÉRÉ  (pour l'instant : OBSERVATION SEULE)
// ══════════════════════════════════════════════════════════════════════
// Le système actuel est binaire (trusted / pas trusted) + une règle rigide
// (≥ 3 sources à ±1 an). Un score continu est plus juste : chaque voix est
// pondérée par (1) la fiabilité de la SOURCE sur CE champ et (2) la QUALITÉ
// de son match (C214). Une source hors sujet ne vote pas.
//
// Poids : iTunes et Deezer datent à l'INGESTION NUMÉRIQUE (une réédition 2015
// d'un disque de 1973) → poids faible sur l'année, fort sur la pochette.
// MusicBrainz et Discogs portent la date d'ORIGINE → poids fort. Last.fm est
// un excellent indicateur de genre (tags communautaires), mauvais sur l'année.
const SOURCE_WEIGHTS = {
  'MusicBrainz-RG':    { year: 1.00, genre: 0.70, cover: 0.60 },
  'MusicBrainz':       { year: 0.95, genre: 0.70, cover: 0.60 },
  'Discogs':           { year: 0.90, genre: 1.00, cover: 0.80 },
  'iTunes':            { year: 0.35, genre: 0.50, cover: 1.00 },
  'Deezer':            { year: 0.35, genre: 0.50, cover: 0.90 },
  'Last.fm':           { year: 0.30, genre: 0.80, cover: 0.40 },
  'Cover Art Archive': { year: 0.00, genre: 0.00, cover: 1.00 },
};
function _sourceWeight(source, field) {
  const s = String(source || '');
  // Wikipédia/Wikidata font autorité sur l'année de COMPOSITION — philosophie n°1.
  if (/wikipedia|wikidata/i.test(s)) return field === 'year' ? 1.00 : (field === 'genre' ? 0.60 : 0.30);
  // Recherche par enregistrement (titre) : c'est elle qui donne l'année d'origine
  // des compilations. Elle mérite presque le poids de MusicBrainz.
  if (/corrobor|recherche par titre/i.test(s)) return field === 'year' ? 0.95 : 0.70;
  for (const k of Object.keys(SOURCE_WEIGHTS)) {
    if (s.indexOf(k) === 0) return SOURCE_WEIGHTS[k][field] ?? 0.40;
  }
  return 0.40;   // source inconnue → poids prudent
}

// Sources FORTES : celles qui portent la date d'ORIGINE avec une identité
// vérifiée. Trois plateformes de streaming d'accord entre elles ne valent PAS
// une source forte — elles se copient et répètent la même erreur de réédition.
const _STRONG_SRC = /^(MusicBrainz|Discogs)|wikipedia|wikidata|corrobor/i;

// C217 — UN VOTE PAR SOURCE. Le pool agrège PLUSIEURS requêtes (album, titre,
// repli…) : sans dédoublonnage, « Discogs 0.50 + Discogs 0.50 » comptait DEUX
// FOIS le même avis, et « Last.fm + Deezer + Last.fm » trois voix pour deux
// sources. C'est la non-indépendance des preuves dans sa forme la plus grossière.
function _oneVotePerSource(candidates, field, keyOf) {
  const bySrc = new Map();
  for (const c of candidates || []) {
    if (!c || c.value === null || c.value === undefined) continue;
    const src = String(c.source || '?');
    const w = _sourceWeight(src, field) * (typeof c.q === 'number' ? c.q : 0.5);
    if (w <= 0) continue;
    const cur = bySrc.get(src);
    // Source qui se contredit d'une requête à l'autre → on garde son avis le
    // mieux apparié (q le plus élevé), pas ses deux avis.
    if (!cur || w > cur.w) {
      bySrc.set(src, { source: src, value: c.value, key: keyOf ? keyOf(c.value) : String(c.value), w });
    }
  }
  return [...bySrc.values()];
}

// C217 — VERDICT. Le consensus NE SUFFIT PAS : une voix isolée à 100 % n'est pas
// une certitude, c'est une absence de contradiction. Ce n'est pas la même chose.
// Preuve dans les logs : « Preparense » (1 source, masse 0.47) et « Like You Used
// To » (5 sources, masse 3.55) obtenaient le MÊME score de 100 %.
// L'écriture auto exige donc QUATRE conditions :
//   consensus  — les sources ne se contredisent pas
//   masse      — il y a assez de preuve (une voix seule ne suffit jamais)
//   marge      — le second candidat est loin derrière (métrique n°1 du risque)
//   source forte — au moins une base de référence parmi les soutiens
const SCORE_GATE = { consensus: 0.85, mass: 1.40, margin: 0.30 };
function _scoreVerdict(r) {
  if (!r) return 'aucune donnée';
  if (r.confidence >= SCORE_GATE.consensus && r.mass >= SCORE_GATE.mass
      && r.margin >= SCORE_GATE.margin && r.strong) return 'ÉCRIRAIT';
  if (r.confidence >= 0.45) return 'à vérifier';
  return 'rejetterait';
}

function _rank(buckets, total) {
  const ranked = [...buckets.values()].sort((a, b) => b.score - a.score);
  const best = ranked[0], second = ranked[1];
  if (!best) return null;
  return {
    value: best.value,
    confidence: best.score / total,                                   // proportion de consensus
    mass: best.score,                                                 // QUANTITÉ de preuve
    margin: (best.score - (second ? second.score : 0)) / total,       // écart au dauphin
    strong: best.strong,
    sources: best.sources,
    n: best.sources.length
  };
}

function _confidenceScore(candidates, field, keyOf) {
  const votes = _oneVotePerSource(candidates, field, keyOf);
  if (!votes.length) return null;
  const buckets = new Map();
  let total = 0;
  for (const v of votes) {
    total += v.w;
    const e = buckets.get(v.key) || { value: v.value, score: 0, sources: [], strong: false };
    e.score += v.w;
    e.sources.push(`${v.source} ${v.w.toFixed(2)}`);
    if (_STRONG_SRC.test(v.source)) e.strong = true;
    buckets.set(v.key, e);
  }
  return total ? _rank(buckets, total) : null;
}

// ANNÉE : les bases divergent d'un an sur les sorties de fin d'année → on
// regroupe à ±1 an, on score les CLUSTERS, et on retient la PLUS ANCIENNE du
// cluster gagnant (l'œuvre d'origine prime — philosophie n°1).
function _confidenceYear(candidates) {
  const votes = _oneVotePerSource((candidates || []).filter(c => c && parseInt(c.value) >= 1400), 'year');
  if (!votes.length) return null;
  const clusters = new Map();
  let total = 0, ci = 0;
  const list = [];
  for (const v of votes) {
    const y = parseInt(v.value);
    let cl = list.find(k => Math.abs(k.center - y) <= 1);
    if (!cl) { cl = { center: y, years: [], score: 0, sources: [], strong: false, id: ci++ }; list.push(cl); }
    cl.years.push(y);
    cl.score += v.w;
    cl.sources.push(`${v.source} ${v.w.toFixed(2)}`);
    if (_STRONG_SRC.test(v.source)) cl.strong = true;
    total += v.w;
  }
  for (const cl of list) clusters.set(cl.id, { value: Math.min(...cl.years), score: cl.score, sources: cl.sources, strong: cl.strong });
  return total ? _rank(clusters, total) : null;
}

function _consolidateArtist(candidates, tagArtist, composerFromPass2) {
  const out = { value: tagArtist || null, source: tagArtist ? 'local-tag' : null, trusted: false, candidates: [...candidates] };
  if (!candidates.length) return out;

  // Comptage des votes (clé = lowercase trim)
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

  // Trust : tag local match consensus ET ≥2 votes.
  if (tagMatches && top.count >= 2) {
    out.value = top.original;
    out.source = `consensus ×${top.count}`;
    out.trusted = true;
    return out;
  }

  // Passe 2 active ET tag local pourri : le compositeur déduit l'emporte
  // (même si peu de votes — Wikipedia œuvre confirme indirectement via year).
  if (composerFromPass2) {
    out.value = top.original;
    out.source = `compositeur déduit (×${top.count}) — tag local ignoré`;
    out.trusted = false; // revue humaine pour confirmer
    return out;
  }

  // Tag local absent du consensus : on propose le top mais non-trusted.
  out.value = top.original;
  out.source = `consensus ×${top.count} (tag local mismatch)`;
  out.trusted = false;
  return out;
}

function _consolidateAlbum(candidates, wantedAlbum) {
  const out = { value: wantedAlbum || null, source: wantedAlbum ? 'local-tag' : null, trusted: false, candidates: [...candidates] };
  if (!candidates.length) return out;

  const counts = new Map();
  for (const c of candidates) {
    const k = (c.value || '').toLowerCase().trim();
    if (!k) continue;
    if (!counts.has(k)) counts.set(k, { count: 0, original: c.value, source: c.source });
    counts.get(k).count++;
  }
  let top = null;
  for (const [, v] of counts) {
    if (!top || v.count > top.count) top = v;
  }
  if (!top) return out;

  const matchesLocal = wantedAlbum ? _albumMatches(wantedAlbum, top.original) : false;
  if (top.count >= 2 && matchesLocal) {
    out.value = top.original;
    out.source = `convergence ×${top.count}`;
    out.trusted = true;
    return out;
  }
  out.value = top.original;
  out.source = `${top.source} ×${top.count}`;
  out.trusted = false;
  return out;
}

function _consolidateCover(candidates, wantedAlbum) {
  const out = { value: null, source: null, trusted: false, candidates: [] };
  if (!candidates.length) return out;

  // Filtre par album si on en a un (sinon on garde tout).
  let pool = candidates;
  if (wantedAlbum) {
    const relevant = candidates.filter(c => _albumMatches(wantedAlbum, c.album));
    if (relevant.length > 0) pool = relevant;
  }

  // Dédup par URL
  const seen = new Set();
  pool = pool.filter(c => {
    if (!c.value || seen.has(c.value)) return false;
    seen.add(c.value);
    return true;
  });

  // Qualité RÉELLE depuis l'URL (iTunes .../1200x1200bb.jpg, Deezer .../1000x1000-…).
  // Le champ quality des fetchers est parfois périmé (iTunes codé 600 alors que
  // l'URL sert 1200) → on le recalcule pour que le tri choisisse la + nette. On lit
  // la résolution DEMANDÉE (proxy fiable : l'art iTunes est ~1400+ natif).
  const _qFromUrl = u => {
    const m = String(u || '').match(/\/(\d{2,4})x(\d{2,4})(?:bb|cc|sr)?[-.]/i);
    return m ? Math.max(parseInt(m[1], 10), parseInt(m[2], 10)) : null;
  };
  pool.forEach(c => { const q = _qFromUrl(c.value); if (q && q > (c.quality || 0)) c.quality = q; });

  // Tri : quality desc, puis source préférée (Deezer > iTunes > AudioDB)
  const sourceRank = { Deezer: 3, iTunes: 2, TheAudioDB: 1 };
  pool.sort((a, b) => {
    const qd = (b.quality || 0) - (a.quality || 0);
    if (qd !== 0) return qd;
    return (sourceRank[b.source] || 0) - (sourceRank[a.source] || 0);
  });

  out.candidates = pool;
  if (pool.length === 0) return out;
  const top = pool[0];
  out.value = top.value;
  out.source = top.source;
  // Trust : album match (si on a un wantedAlbum) ET quality ≥ 500.
  out.trusted = (wantedAlbum ? _albumMatches(wantedAlbum, top.album) : true) && ((top.quality || 0) >= 500);
  return out;
}

function _consolidateTitle(localTitle) {
  // P1 : on garde le tag local tel quel. La réécriture auto du titre
  // depuis Wikipedia est différée (impose des choix d'identité d'œuvre
  // — ex. "Bona nox" vs "K. 561" vs "Bona nox, ihr seid a rechta Ox" —
  // qui méritent une revue humaine dédiée).
  return { value: localTitle || null, source: localTitle ? 'local-tag' : null, trusted: true, candidates: [] };
}

// Hook console pour tests manuels (chat 6 étape A, validation avant câblage UI).
// Usage : window.testConsolidated(allTracks[i])
if (typeof window !== 'undefined') {
  window.testConsolidated = fetchConsolidatedMeta;
}

// ════════════════════════════════════════════════════════════════════════
// PICKERS CONSOLIDÉS PAR CHAMP — câblage UI modale Édition (chat 6 étape B)
// ────────────────────────────────────────────────────────────────────────
// Pour chaque champ texte (title/artist/album/year/genre/cover), on injecte
// un petit "chip" d'état (couleur = trust) à côté de l'input. Click sur
// le chip → popover ancré listant les candidats. Click candidat → pré-
// remplit l'input (l'utilisateur valide ensuite avec Enregistrer).
//
// Philosophie : on N'ÉCRIT JAMAIS automatiquement sur le track. Le picker
// ne fait que pré-remplir le DOM input. _userModified reste sacré : si
// le track est déjà _userModified, le chip s'affiche en gris "édité".
// ════════════════════════════════════════════════════════════════════════

// Map champ → id input DOM dans la modale Édition (omni*)
const _CM_FIELD_TO_INPUT = {
  title:  'omniTitle',
  artist: 'omniArtist',
  album:  'omniAlbum',
  year:   'omniYear',
  genre:  'omniGenre',   // <select>, traité spécial
  // cover : pas d'input texte, chip pilote omniResults (grille pochettes)
};

// CSS injecté une seule fois (évite de modifier app.html)
function _ensureConsolidatedPickerCss() {
  if (document.getElementById('wt-cm-picker-style')) return;
 const css = `
.wt-cm-chip {
  display: inline-flex; align-items: center; gap: 5px;
  margin-left: 2px; padding: 3px 9px; border-radius: 11px;
  font-size: 11px; line-height: 1.25; cursor: pointer;
  border: 1px solid transparent; user-select: none;
  background: rgba(28,28,30,0.92); color: #e6e6e6;
  transition: background 0.15s, border-color 0.15s, transform 0.1s;
  vertical-align: middle; white-space: nowrap;
  max-width: 360px; overflow: hidden; text-overflow: ellipsis;
  font-weight: 500; letter-spacing: 0.1px;
  backdrop-filter: blur(4px);
}
.wt-cm-chip:hover { background: rgba(40,40,44,0.96); transform: translateY(-1px); }
.wt-cm-chip.trusted  { background: rgba(28,82,38,0.92); color: #C8F0CC; border-color: rgba(93,187,99,0.65); }
.wt-cm-chip.trusted:hover  { background: rgba(36,100,48,0.96); }
.wt-cm-chip.review   { background: rgba(95,72,18,0.92); color: #FFE89B; border-color: rgba(255,217,61,0.55); }
.wt-cm-chip.review:hover   { background: rgba(115,88,24,0.96); }
.wt-cm-chip.empty    { background: rgba(50,50,52,0.85); color: #999; border-color: rgba(255,255,255,0.08); }
.wt-cm-chip.locked   { background: rgba(50,50,52,0.85); color: #888; cursor: not-allowed; border-color: rgba(255,255,255,0.08); opacity: 0.75; }
.wt-cm-chip-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: 0 0 7px; box-shadow: 0 0 4px currentColor; }
.wt-cm-chip-label { overflow: hidden; text-overflow: ellipsis; }
.wt-cm-chip-wrap {
  display: block; position: relative;
  flex-basis: 100%; grid-column: 1 / -1;
  width: 100%; margin: 6px 0 0 0;
  align-self: start; justify-self: start;
  z-index: 1;
}
.wt-cm-pop {
  position: absolute; z-index: 9999;
  min-width: 240px; max-width: 360px;
  background: #1c1c1c; border: 1px solid #444; border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  padding: 4px; font-size: 12px;
}
.wt-cm-pop-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 8px; padding: 6px 10px; border-radius: 5px; cursor: pointer;
  color: #eee;
}
.wt-cm-pop-row:hover { background: rgba(255,255,255,0.08); }
.wt-cm-pop-row .val { font-weight: 500; color: #fff; }
.wt-cm-pop-row .src { font-size: 10px; color: #999; }
.wt-cm-pop-empty { padding: 10px; color: #888; font-style: italic; text-align: center; }
.wt-cm-pop-header { padding: 6px 10px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: #888; border-bottom: 1px solid #333; margin-bottom: 4px; }
.wt-cm-loading {
  display: inline-block; margin-left: 8px; font-size: 11px; color: #888;
  vertical-align: middle;
}
`;
  const style = document.createElement('style');
  style.id = 'wt-cm-picker-style';
  style.textContent = css;
  document.head.appendChild(style);
}

// Retire tous les chips, wrappers, popovers et indicateurs loading
function _clearConsolidatedPickers() {
  document.querySelectorAll('.wt-cm-chip-wrap, .wt-cm-chip, .wt-cm-pop, .wt-cm-loading').forEach(n => n.remove());
}

// Construit le label du chip selon l'état d'un champ consolidé.
// Le chip n'affiche QUE la valeur ; la source passe en tooltip (chip.title).
function _chipLabel(fieldName, fieldData) {
  if (!fieldData) return { cls: 'empty', text: '—', dot: false };
  const { value, trusted } = fieldData;
  if (value == null || value === '') return { cls: 'empty', text: 'pas de match', dot: false };
  return { cls: trusted ? 'trusted' : 'review', text: String(value), dot: true };
}

// Détermine si un chip apporte une info utile (filtre AGRESSIF).
// Affiche SI :
//   (a) la valeur consolidée diffère du tag courant dans l'input, OU
//   (b) la valeur matche le tag MAIS la source est Wikipedia work-source
//       (confirmation forte d'une œuvre identifiée — utile à voir), OU
//   (c) ≥2 candidats alternatifs distincts (l'user pourrait vouloir corriger).
// Sinon : silence total (cas U2 où tout converge sur le tag local).
function _isInfoUseful(fieldName, fieldData, inputEl) {
  if (!fieldData) return false;
  const candidates = fieldData.candidates || [];
  const v = fieldData.value;
  // Rien trouvé du tout
  if ((v === null || v === undefined || v === '') && candidates.length === 0) return false;
  // Toujours afficher le chip s'il y a plus d'un candidat distinct
  const uniqueCands = new Set(
    candidates.map(c => String(c.value || '').toLowerCase().trim()).filter(Boolean)
  );
  if (uniqueCands.size >= 2) return true;
  // Sinon, afficher si la valeur proposée diffère de la valeur actuelle
  const inputVal = (inputEl?.value ?? '').toString().trim();
  const fieldVal = (v == null) ? '' : String(v).trim();
  let sameAsInput;
  if (fieldName === 'year') {
    sameAsInput = parseInt(fieldVal, 10) === parseInt(inputVal, 10);
  } else {
    sameAsInput = fieldVal.toLowerCase() === inputVal.toLowerCase();
  }
  if (!sameAsInput) return true;
  // Cas Wikipedia fiable
  if (/Wikipedia/i.test(fieldData.source || '')) return true;
  return false;
}

// Insère un chip d'état + popover candidats à côté d'un input
function _renderPickerChip(fieldName, fieldData, inputEl, opts = {}) {
  if (!inputEl) return;
  const lockedByUser = !!opts.lockedByUser;

  if (!lockedByUser && !_isInfoUseful(fieldName, fieldData, inputEl)) return;

  const lbl = _chipLabel(fieldName, fieldData);
  const chip = document.createElement('span');
  chip.className = 'wt-cm-chip ' + (lockedByUser ? 'locked' : lbl.cls);
  chip.dataset.cmField = fieldName;
  chip.title = lockedByUser
    ? 'Édité manuellement — pré-remplissage désactivé'
    : (fieldData?.source || 'pas de source');
  if (lbl.dot) {
    const dot = document.createElement('span');
    dot.className = 'wt-cm-chip-dot';
    chip.appendChild(dot);
  }
  const label = document.createElement('span');
  label.className = 'wt-cm-chip-label';
  label.textContent = lockedByUser ? 'édité' : lbl.text;
  chip.appendChild(label);

  const wrap = document.createElement('div');
  wrap.className = 'wt-cm-chip-wrap';
  wrap.appendChild(chip);
  inputEl.insertAdjacentElement('afterend', wrap);

  

  // 🟢 Événement click sur la pastille
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    const existing = document.querySelector(`.wt-cm-pop[data-cm-field="${fieldName}"]`);
    if (existing) { existing.remove(); return; }
    document.querySelectorAll('.wt-cm-pop').forEach(n => n.remove());
    _openPickerPopover(fieldName, fieldData, chip, inputEl);
  });
}

  function _openPickerPopover(fieldName, fieldData, anchorEl, inputEl) {
  const pop = document.createElement('div');
  pop.className = 'wt-cm-pop';
  pop.dataset.cmField = fieldName;

  const header = document.createElement('div');
  header.className = 'wt-cm-pop-header';
  header.textContent = `Candidats ${fieldName}`;
  pop.appendChild(header);

  let candidates = (fieldData?.candidates || []).slice(0, 12);

  // Pour le champ genre, ajouter les sous-genres prédéfinis
  if (fieldName === 'genre' && typeof CHILD_GENRES !== 'undefined') {
    const childNames = Object.keys(CHILD_GENRES);
    for (const child of childNames) {
      if (!candidates.some(c => c.value === child)) {
        candidates.push({ value: child, source: 'Sous-genre' });
      }
    }
  }

  if (candidates.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'wt-cm-pop-empty';
    empty.textContent = 'Aucun candidat retrouvé';
    pop.appendChild(empty);
  } else {
    const seen = new Set();
    for (const c of candidates) {
      const val = c.value;
      const key = String(val).toLowerCase().trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const row = document.createElement('div');
      row.className = 'wt-cm-pop-row';
      const valSpan = document.createElement('span');
      valSpan.className = 'val';
      valSpan.textContent = String(val).length > 40 ? String(val).slice(0, 38) + '…' : String(val);
      const srcSpan = document.createElement('span');
      srcSpan.className = 'src';
      srcSpan.textContent = c.source || '?';
      row.appendChild(valSpan);
      row.appendChild(srcSpan);
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        _applyCandidateToInput(fieldName, val, inputEl);
        pop.remove();
        const chipLabel = anchorEl.querySelector('.wt-cm-chip-label');
        if (chipLabel) chipLabel.textContent = val.length > 30 ? val.slice(0, 28) + '…' : val;
        anchorEl.classList.remove('empty', 'review');
        anchorEl.classList.add('trusted');
      });
      pop.appendChild(row);
    }
  }

  document.body.appendChild(pop);
  const rect = anchorEl.getBoundingClientRect();
  const popHeight = pop.offsetHeight;
  const viewportHeight = window.innerHeight;

  let left = Math.round(rect.left + window.scrollX);
  let top = Math.round(rect.bottom + window.scrollY + 4);

  // Si le popover dépasse en bas, le placer au-dessus du chip
  if (top + popHeight > viewportHeight + window.scrollY) {
    top = Math.round(rect.top + window.scrollY - popHeight - 4);
  }
  // Éviter de sortir à gauche/droite
  if (left + pop.offsetWidth > window.innerWidth + window.scrollX) {
    left = window.innerWidth + window.scrollX - pop.offsetWidth - 8;
  }
  if (left < 0) left = 8;

  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;

  const onDocClick = (ev) => {
    if (!pop.contains(ev.target) && ev.target !== anchorEl) {
      pop.remove();
      document.removeEventListener('mousedown', onDocClick);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', onDocClick), 0);
}

function _applyCandidateToInput(fieldName, value, inputEl) {
  if (!inputEl) return;
  if (fieldName === 'genre') {
    let found = false;
    const _gv = _genreToSelectOption(value);
    for (let i = 0; i < inputEl.options.length; i++) {
      if (inputEl.options[i].value === _gv) {
        inputEl.selectedIndex = i;
        found = true;
        break;
      }
    }
    if (!found) {
      const styleInput = document.getElementById('omniStyle');
      if (styleInput) styleInput.value = value;
    }
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    inputEl.value = value;
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Rafraîchir l'overlay si c'est le morceau courant
  const currentTrack = queue && queue[qi];
  if (currentTrack && _omniSpecificRef && _omniSpecificRef.path === currentTrack.path) {
    if (typeof _refreshPlayerOverlay === 'function') {
      _refreshPlayerOverlay(currentTrack);
    }
  }

  // Feedback visuel
  inputEl.style.backgroundColor = 'rgba(200,90,69,0.2)';
  setTimeout(() => { inputEl.style.backgroundColor = ''; }, 300);
}

// Orchestrateur : appelé à l'ouverture de la modale Édition.
// 1. Affiche un indicateur "chargement" à côté du titre
// 2. Lance fetchConsolidatedMeta
// 3. Injecte les chips + popovers
async function _runConsolidatedPickers(track) {
  if (!track) return;
  _ensureConsolidatedPickerCss();
  _clearConsolidatedPickers();

  const lockedByUser = !!track._userModified;

  // Indicateur loading attaché au titre
  const titleInput = document.getElementById('omniTitle');
  let loading = null;
  if (titleInput) {
    loading = document.createElement('span');
    loading.className = 'wt-cm-loading';
    loading.textContent = '⏳ recherche métadonnées…';
    titleInput.insertAdjacentElement('afterend', loading);
  }

  if (loading) loading.remove();

  // On réutilise les options de la recherche EN COURS (window._lastFieldOptions
  // + window._lastBestMatch) — MÊME moteur que le MEILLEUR MATCH, affichage
  // INSTANTANÉ. Fini le 2e fetch auto, lent et incohérent avec le match affiché.
  const _opts = window._lastFieldOptions || {};
  const _bm = window._lastBestMatch || {};
  const _mkField = (f) => {
    const cands = (_opts[f] || []).map(o => ({ value: o.value, source: o.source }));
    console.log(`[_mkField] ${f} candidates:`, cands); // debug
    const bmv = _bm[f];
    if (bmv != null && bmv !== '') {
      const exists = cands.some(c => String(c.value).toLowerCase().trim() === String(bmv).toLowerCase().trim());
      if (!exists) cands.unshift({ value: bmv, source: (f === 'year' ? (_bm.yearSource || 'recommandé') : 'recommandé') });
    }
    let val = (bmv != null && bmv !== '') ? bmv : (cands[0] ? cands[0].value : null);
    // Genre : canonise vers la taxonomie (« Hip-Hop/Rap » → « Hip-Hop&Rap »),
    // sinon la valeur brute ne correspond à aucune option du champ et le genre
    // « ne se change pas » à l'application du match.
    if (f === 'genre' && val && typeof clientMapGenre === 'function') {
      const _cg = clientMapGenre(val);
      if (_cg) val = _cg;
    }
    let src = (f === 'year') ? (_bm.yearSource || null) : null;
    if (!src && val != null) {
      const hit = cands.find(c => String(c.value).toLowerCase().trim() === String(val).toLowerCase().trim());
      src = hit ? hit.source : (cands[0] ? cands[0].source : null);
    }
    return { value: val, source: src, trusted: false, candidates: cands };
  };
  const consolidated = {
    title:  { value: _bm.title || null, source: null, trusted: false, candidates: [] },
    artist: _mkField('artist'),
    album:  _mkField('album'),
    year:   _mkField('year'),
    genre:  _mkField('genre'),
  };

  if (_omniSpecificRef !== track) return;

  window._lastConsolidatedMeta = consolidated;

  // Double cleanup juste avant l'injection : si deux fetch ont tourné en
  // parallèle (user a cliqué Rechercher 2x), le dernier à finir nettoie
  // tout d'abord et injecte ensuite — plus de doublons.
  _clearConsolidatedPickers();

  // Injection des chips pour chaque champ texte
  for (const [field, inputId] of Object.entries(_CM_FIELD_TO_INPUT)) {
    const inputEl = document.getElementById(inputId);
    if (!inputEl) continue;
    _renderPickerChip(field, consolidated[field], inputEl, { lockedByUser });
  }
}

// Hook console pour debug
if (typeof window !== 'undefined') {
  window._runConsolidatedPickers = _runConsolidatedPickers;
}

// ════════════════════════════════════════════════════════════════════════
// SPLIT-BUTTON HEADER "Infos à vérifier" — fusion enrich+review+force
// ────────────────────────────────────────────────────────────────────────
// 1 seul point d'entrée pour toute la gestion métadonnées du header.
// Click corps        → runMetaReview() (revue des cas douteux du cache)
// Click flèche ▾     → menu déroulant avec 3 actions :
//   - Vérifier les douteux  (= runMetaReview, identique au corps)
//   - Compléter les manquants (= onEnrichPillClick)
//   - Tout re-vérifier      (= forceRecheckAll)
// Badge compteur     → updateMetaSplitCount(n) : nb cas douteux à valider.
// ════════════════════════════════════════════════════════════════════════

// Préférence "vérification auto" persistée localement (default ON).
// Lecture synchrone via localStorage ; écriture aussi best-effort dans
// prefs.json via window.wt.savePref si l'API existe.
const WT_AUTO_META_KEY = 'wtAutoMetaCheck';
function wtIsAutoMetaCheckEnabled() {
  const v = localStorage.getItem(WT_AUTO_META_KEY);
  if (v === null || v === undefined) return true;
  return v === '1' || v === 'true';
}
function wtSetAutoMetaCheckEnabled(on) {
  localStorage.setItem(WT_AUTO_META_KEY, on ? '1' : '0');
  try {
    if (window.wt?.savePref) window.wt.savePref(WT_AUTO_META_KEY, !!on);
  } catch (e) { /* silent */ }
}

function _ensureMetaSplitCss() {
  if (document.getElementById('wt-meta-split-style')) return;
  const css = `
.wt-meta-split { transition: background 0.15s, border-color 0.15s; }
.wt-meta-split:hover { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.20); }
.wt-meta-main:hover, .wt-meta-caret:hover { background: rgba(255,255,255,0.08) !important; }
.wt-meta-split.has-issues { border-color: rgba(255,180,60,0.45); }
.wt-meta-split.has-issues .wt-meta-count { display: inline-flex !important; }
.wt-meta-split.is-running {
  border-color: rgba(120,180,255,0.55);
  background: rgba(120,180,255,0.08);
}
.wt-meta-split.is-running .wt-meta-main::after {
  content: '';
  display: inline-block;
  width: 7px; height: 7px;
  margin-left: 2px;
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: wtMetaSpin 0.8s linear infinite;
  vertical-align: middle;
}
@keyframes wtMetaSpin { to { transform: rotate(360deg); } }
.wt-meta-menu {
  position: absolute; z-index: 9999;
  min-width: 240px;
  background: #1c1c1c; border: 1px solid #444; border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  padding: 4px; font-size: 12px;
  margin-top: 4px;
}
.wt-meta-menu-item {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px; border-radius: 5px; cursor: pointer;
  color: #eee; line-height: 1.3;
}
.wt-meta-menu-item:hover { background: rgba(255,255,255,0.08); }
.wt-meta-menu-item .mi-icon { flex: 0 0 14px; opacity: 0.75; }
.wt-meta-menu-item .mi-label { flex: 1; }
.wt-meta-menu-item .mi-sub { font-size: 10px; color: #888; }
.wt-meta-menu-sep { height: 1px; background: rgba(255,255,255,0.08); margin: 4px 0; }
`;
  const style = document.createElement('style');
  style.id = 'wt-meta-split-style';
  style.textContent = css;
  document.head.appendChild(style);
}

function wtMetaSplitToggle(ev) {
  if (ev) ev.stopPropagation();
  _ensureMetaSplitCss();
  const existing = document.getElementById('wtMetaMenu');
  if (existing) { existing.remove(); return; }

  const caret = document.getElementById('wtMetaCaret');
  if (!caret) return;
  caret.setAttribute('aria-expanded', 'true');

  const menu = document.createElement('div');
  menu.id = 'wtMetaMenu';
  menu.className = 'wt-meta-menu';
  menu.setAttribute('role', 'menu');

  const items = [
    {
      label: 'Réviser les métadonnées',
      sub: `${countTracksToReview()} à examiner — propositions, corrigés auto, sans info`,
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
      action: () => { if (typeof runMetaReview === 'function') runMetaReview(); }
    },
    { sep: true },
    {
      label: 'Tout re-vérifier',
      sub: '⚠ Analyse complète, peut prendre des heures',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`,
      action: () => { if (typeof forceRecheckAll === 'function') forceRecheckAll(); }
    },
  ];

  for (const it of items) {
    if (it.sep) {
      const sep = document.createElement('div');
      sep.className = 'wt-meta-menu-sep';
      menu.appendChild(sep);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'wt-meta-menu-item';
    row.setAttribute('role', 'menuitem');
    row.innerHTML = `
      <span class="mi-icon">${it.icon}</span>
      <span class="mi-label">${it.label}<div class="mi-sub">${it.sub}</div></span>
    `;
    row.addEventListener('click', () => {
      menu.remove();
      caret.setAttribute('aria-expanded', 'false');
      try { it.action(); } catch (e) { console.warn('[wtMetaSplit] action error:', e); }
    });
    menu.appendChild(row);
  }

  document.body.appendChild(menu);
  // Positionnement sous le split-button
  const splitEl = document.getElementById('wtMetaSplit');
  if (splitEl) {
    const r = splitEl.getBoundingClientRect();
    menu.style.left = `${Math.round(r.right - menu.offsetWidth + window.scrollX)}px`;
    menu.style.top  = `${Math.round(r.bottom + window.scrollY + 4)}px`;
    // Recadrage si déborde à gauche
    const finalRect = menu.getBoundingClientRect();
    if (finalRect.left < 8) menu.style.left = '8px';
  }

  // Fermeture au prochain clic extérieur
  setTimeout(() => {
    const onDocClick = (e) => {
      if (!menu.contains(e.target) && e.target !== caret) {
        menu.remove();
        caret.setAttribute('aria-expanded', 'false');
        document.removeEventListener('mousedown', onDocClick);
      }
    };
    document.addEventListener('mousedown', onDocClick);
  }, 0);
}

// API publique : appelée par le code existant qui maintient les compteurs.
// Signature étendue : si on passe un objet { douteux, manquants }, on affiche
// le total + tooltip détaillé. Si on passe juste un number, c'est legacy
// (= nb de douteux uniquement).
function updateMetaSplitCount(n) {
  const split = document.getElementById('wtMetaSplit');
  const badge = document.getElementById('wtMetaCount');
  const mainBtn = document.getElementById('btnMetaReview');
  if (!split || !badge) return;
  let douteux = 0, manquants = 0;
  if (typeof n === 'object' && n !== null) {
    douteux = parseInt(n.douteux, 10) || 0;
    manquants = parseInt(n.manquants, 10) || 0;
  } else {
    douteux = parseInt(n, 10) || 0;
  }
  const total = douteux + manquants;
  badge.textContent = String(total);
  if (total > 0) split.classList.add('has-issues');
  else split.classList.remove('has-issues');
  // Étage 2 : des PROPOSITIONS concrètes attendent une décision → le badge
  // pulse doucement. Simple compteur de manquants (rien trouvé) → statique.
  const _hasProps = (typeof allTracks !== 'undefined' && Array.isArray(allTracks))
    ? allTracks.some(t => t._autoOutcome === 'proposed' && !t._userModified && !t._ignored)
    : douteux > 0;
  split.classList.toggle('has-proposals', !!_hasProps && total > 0);
  // Tooltip détaillé sur le bouton principal
  if (mainBtn) {
    if (douteux > 0 && manquants > 0) {
      mainBtn.title = `${douteux} douteux + ${manquants} manquants à vérifier`;
    } else if (douteux > 0) {
      mainBtn.title = `${douteux} douteux à revoir`;
    } else if (manquants > 0) {
      mainBtn.title = `${manquants} manquants à compléter`;
    } else {
      mainBtn.title = 'Toutes les infos sont à jour';
    }
  }
}

// Indique visuellement que l'auto-vérif tourne en arrière-plan.
// Petite pulsation bleue + spinner discret. Appelé au boot et après scan.
function setMetaSplitRunning(running) {
  const split = document.getElementById('wtMetaSplit');
  if (!split) return;
  if (running) {
    split.classList.add('is-running');
    split.title = 'Vérification automatique en cours…';
  } else {
    split.classList.remove('is-running');
    split.title = '';
  }
}

if (typeof window !== 'undefined') {
  window.wtMetaSplitToggle = wtMetaSplitToggle;
  window.updateMetaSplitCount = updateMetaSplitCount;
  document.addEventListener('DOMContentLoaded', _ensureMetaSplitCss);
  _ensureMetaSplitCss();

  // Pont rétrocompat : le code legacy met à jour #enrichStatus avec un texte
  // qui contient parfois un nombre (ex. "12 à compléter"). On observe ce
  // node et on extrait le nombre pour alimenter le badge du split-button.
  function _wtBridgeEnrichStatus() {
    // Au lieu de forcer 0 (qui masquait le badge), on appelle le VRAI calcul global
    // (refreshReviewBadge -> countTracksToReview), source fiable et stable.
    if (typeof refreshReviewBadge === 'function') refreshReviewBadge();
  }  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wtBridgeEnrichStatus);
  } else {
    _wtBridgeEnrichStatus();
  }
}

// ============================================================

// ============================================================
// SOURCE 1: MUSICBRAINZ (année originale + genres)
// ============================================================

async function fetchMusicBrainzMetadata(artist, album) {
  // Circuit-breaker : si MB a échoué N fois d'affilée cette session, on skip
  if (typeof mbIsDisabled === 'function' && mbIsDisabled()) return null;
  try {
    const searchTerm = artist ? `${artist} ${album}` : album;
    const url = `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(searchTerm)}&fmt=json&limit=5&inc=release-groups+genres`;
    
    const response = await fetchWithRetry(url, {
      headers: { 'User-Agent': 'WaveTune/3.0 (https://wavetune.app)' }
    });
    if (!response.ok) {
      if (response.status === 503 || response.status === 429) {
        if (typeof mbReportError === 'function') mbReportError();
      }
      return null;
    }
    if (typeof mbReportSuccess === 'function') mbReportSuccess();
    const data = await response.json();
    
    if (!data.releases?.length) return null;
    
    let earliestYear = null;
    let genreVotes = new Map();
    
    for (const release of data.releases) {
      // Année originale du release-group
      const firstRelease = release['release-group']?.['first-release-date'];
      if (firstRelease) {
        const yearMatch = firstRelease.match(/^(\d{4})/);
        if (yearMatch) {
          const year = parseInt(yearMatch[1]);
          if (!earliestYear || year < earliestYear) {
            earliestYear = year;
          }
        }
      }
      
      // Genres
      const tags = [...(release['release-group']?.genres || []), ...(release.genres || [])];
      for (const tag of tags) {
        if (tag.count >= 1) {
          const mapped = clientMapGenre(tag.name);
          if (mapped) {
            genreVotes.set(mapped, (genreVotes.get(mapped) || 0) + tag.count);
          }
        }
      }
    }
    
    let bestGenre = null;
    let maxVotes = 0;
    for (const [genre, votes] of genreVotes) {
      if (votes > maxVotes) {
        maxVotes = votes;
        bestGenre = genre;
      }
    }
    
    return {
      year: earliestYear,
      genre: bestGenre
    };
  } catch(e) {
    if (typeof mbReportError === 'function') mbReportError();
    console.warn('[MusicBrainz] error:', e?.message || e);
    return null;
  }
}

// ============================================================
// SOURCE 3: DEEZER
// ============================================================

async function fetchDeezerAlbums(artist, album) {
  try {
    const searchTerm = artist ? `${artist} ${album}` : album;
    const url = `https://api.deezer.com/search/album?q=${encodeURIComponent(searchTerm)}&limit=10`;
    const response = await fetchWithRetry(url);
    if (!response.ok) return { covers: [], bestMatch: null };
    const data = await response.json();
    
    if (!data.data?.length) return { covers: [], bestMatch: null };
    
    const covers = [];
    let bestMatch = null;
    let bestScore = 0;
    
    for (const item of data.data) {
      const year = item.release_date?.split('-')[0] || null;
      const score = calculateItemScore(item.title, item.artist.name, album, artist);
      
      covers.push({
        url: item.cover_xl || item.cover_big,
        album: item.title,
        artist: item.artist.name,
        year: year,
        source: 'Deezer',
        quality: item.cover_xl ? 1200 : 500,
        score: score
      });
      
      if (score > bestScore) {
        bestScore = score;
        bestMatch = covers[covers.length - 1];
      }
    }
    
    return { covers, bestMatch };
  } catch(e) {
    console.warn('[Deezer] error:', e);
    return { covers: [], bestMatch: null };
  }
}

// ============================================================
// SOURCE 4: ITUNES
// ============================================================

async function fetchItunesAlbums(artist, album) {
  try {
    const searchTerm = artist ? `${artist} ${album}` : album;
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(searchTerm)}&media=music&entity=album&limit=10`;
    const response = await fetchWithRetry(url);
    if (!response.ok) return { covers: [], bestMatch: null };
    const data = await response.json();
    
    if (!data.results?.length) return { covers: [], bestMatch: null };
    
    const covers = [];
    let bestMatch = null;
    let bestScore = 0;
    
    for (const item of data.results) {
      const year = item.releaseDate?.split('-')[0] || null;
      const score = calculateItemScore(item.collectionName, item.artistName, album, artist);
      
      covers.push({
        url: item.artworkUrl100?.replace('100x100bb', '600x600bb'),
        album: item.collectionName,
        artist: item.artistName,
        year: year,
        genre: item.primaryGenreName,
        source: 'iTunes',
        quality: 600,
        score: score
      });
      
      if (score > bestScore) {
        bestScore = score;
        bestMatch = covers[covers.length - 1];
      }
    }
    
    return { covers, bestMatch };
  } catch(e) {
    console.warn('[iTunes] error:', e);
    return { covers: [], bestMatch: null };
  }
}

// ============================================================
// SOURCE 5: THE AUDIO DB (gratuit, sans clé)
// ============================================================

async function fetchTheAudioDb(artist, album) {
  try {
    if (!artist) return null;
    
    const url = `https://www.theaudiodb.com/api/v1/json/2/searchalbum.php?s=${encodeURIComponent(artist)}&a=${encodeURIComponent(album)}`;
    const response = await fetchWithRetry(url);
    if (!response.ok) return null;
    const data = await response.json();
    
    if (data.album?.length) {
      const albumInfo = data.album[0];
      return {
        year: albumInfo.intYearReleased ? parseInt(albumInfo.intYearReleased) : null,
        genre: albumInfo.strGenre ? clientMapGenre(albumInfo.strGenre) : null,
        cover: albumInfo.strAlbumThumb ? { url: albumInfo.strAlbumThumb, source: 'TheAudioDB', quality: 300 } : null
      };
    }
    return null;
  } catch(e) {
    console.warn('[TheAudioDB] error:', e);
    return null;
  }
}

// ============================================================
// SOURCE 6: LAST.FM TAGS (optionnel, nécessite une clé gratuite)
// ============================================================

async function fetchLastFmTags(artist, album) {
  if (!LAST_FM_KEY || LAST_FM_KEY === "") return null;
  
  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=album.getinfo&api_key=${LAST_FM_KEY}&artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}&format=json`;
    const response = await fetchWithRetry(url);
    if (!response.ok) return null;
    const data = await response.json();
    
    if (data.album?.tags?.tag?.length) {
      const topTag = data.album.tags.tag[0];
      return { genre: clientMapGenre(topTag.name) };
    }
    return null;
  } catch(e) {
    console.warn('[Last.fm] error:', e);
    return null;
  }
}

// ============================================================
// SOURCE 7: WIKIPEDIA (pour la date RECORDED)
// ============================================================

async function fetchWikipediaRecordingDate(artist, album) {
  try {
    if (!artist && !album) return null;

   // ── Détection « classique » et construction de la requête œuvre ──
    // Pour le classique, on veut l'article de l'ŒUVRE sur Wikipedia, pas la bio
    // du compositeur ni l'article générique du genre. Tests empiriques :
    //  • "Wolfgang Amadeus Mozart Requiem" → tombe sur la BIO (mauvais)
    //  • "Mozart Requiem"                  → "Requiem (Mozart)" ✓
    //  • "... Requiem composition"         → "Requiem (Mozart)" ✓
    // Donc : compositeur réduit au NOM DE FAMILLE + œuvre + mot "composition".
    // Le compositeur vient de l'album (avant « : ») ou, à défaut, de l'artiste.
   // Détection œuvre ÉLARGIE (Phase 2 session 5). 3 signaux acceptés :
    //  - marqueur fort dans le titre : "Symphony No. 9", "Op. 37", "BWV 1046",
    //    "Requiem", "Oratorio", "Te Deum"...
    //  - nom d'œuvre lyrique/orchestrale connue (Don Giovanni, Carmen, Boléro,
    //    Brandenburg, Four Seasons, etc.)
    //  - nom d'artiste de 3+ mots tous capitalisés (heuristique compositeur :
    //    "Wolfgang Amadeus Mozart", "Pyotr Ilyich Tchaikovsky"...)
    const _al = album || '';
    let _looksClassical = false;
    if (/\b(symphony|sinfonia|concerto|sonata|quartet|quintet|prelude|nocturne|fugue|cantata)\b[\s.]*(no\.?\s*\d|n\.?\s*\d|in\s+[a-g]\b|\d)/i.test(_al)) _looksClassical = true;
    else if (/\b(op\.?\s*\d|k\.?\s*\d{2,}|bwv\s*\d|hob\b)/i.test(_al)) _looksClassical = true;
    else if (/\b(requiem|vigil|oratorio|mass\s+in|te\s+deum|magnificat)\b/i.test(_al)) _looksClassical = true;
    else if (/\b(don giovanni|le nozze di figaro|cosi fan tutte|die zauberflote|the magic flute|la traviata|rigoletto|il trovatore|nabucco|aida|otello|carmen|faust|la boheme|la bohème|tosca|madama butterfly|turandot|the barber of seville|il barbiere|the marriage of figaro|fidelio|tannhauser|tannhäuser|lohengrin|parsifal|tristan und isolde|the ring|der ring|orfeo|peter grimes|the rake's progress|wozzeck|porgy and bess|messiah|st\.? matthew passion|st\.? john passion|the well-tempered clavier|goldberg variations|brandenburg|water music|music for the royal fireworks|the four seasons|le quattro stagioni|stabat mater|missa solemnis|carmina burana|bolero|boléro|peer gynt|pictures at an exhibition|swan lake|the nutcracker|sleeping beauty|romeo and juliet|firebird|petrushka|the rite of spring|la mer|clair de lune|nocturnes|preludes|etudes|nuages gris|gymnopedies|gymnopédies|gnossiennes)\b/i.test(_al)) _looksClassical = true;
    else if (artist) {
      const _parts = artist.trim().split(/\s+/);
      if (_parts.length >= 3 && _parts.every(p => /^[A-ZÀ-Ý]/.test(p))) _looksClassical = true;
    }
    let searchQuery;
    if (_looksClassical) {
      let composerRaw = '', work = album || '';
      const colon = (album || '').indexOf(':');
      if (colon > 0) {
        composerRaw = album.slice(0, colon).trim();
        work = album.slice(colon + 1).trim();
      } else {
        // Pas de compositeur dans l'album → on prend l'artiste (souvent le compositeur en classique)
        composerRaw = artist || '';
      }
      // Nom de famille = dernier mot du nom (évite que "Wolfgang Amadeus Mozart" pointe vers la bio)
      const composerLast = (composerRaw.split(/\s+/).pop() || '').trim();
      work = work.replace(/\bvespers\b/ig, '').replace(/\s+-\s+/g, ' ').replace(/\s+/g, ' ').trim();
      searchQuery = `${composerLast} ${work} composition`.trim();
    } else {
      searchQuery = `${artist} ${album} song`;
    }

    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(searchQuery)}&format=json&origin=*`;
    const searchRes = await fetchWithRetry(searchUrl);
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    
    if (!searchData.query?.search?.length) return null;
    
  // Toujours prendre le résultat #0. Wikipedia trie par pertinence et son
    // classement bat n'importe quelle heuristique wordcount.
    // Cas vérifiés :
    //   - "Mozart Don Giovanni composition" → #0 "Don Giovanni" (opéra) ✓
    //   - "Mozart K. 561 composition" → #0 "Bona nox" (wc=431) ✓ (un précédent
    //     patch dégageait à tort cette page au profit de "List of compositions
    //     by Franz Schubert" wc=2150, hors-sujet)
    //   - Un article niche court (wc<500) est BIEN l'article de l'œuvre, alors
    //     qu'un article long #2/#3 est presque toujours une liste-catalogue
    //     hors-sujet (pas d'infobox œuvre, pas d'intro avec date).
    // Le wordcount n'est plus utilisé pour la sélection.
    const bestPage = searchData.query.search[0];
    
    const pageTitle = bestPage.title;
    // Récupérer le contenu HTML de la page
    const pageUrl = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(pageTitle)}&prop=text&format=json&origin=*`;
    const pageRes = await fetchWithRetry(pageUrl);
    if (!pageRes.ok) return null;
    const pageData = await pageRes.json();
    
    const html = pageData.parse?.text?.['*'] || '';
    
    // Helper : extrait l'année d'un champ d'infobox donné (ex. "Composed", "Performed").
    // Gère les entités HTML (&#160;) et les plages d'années ("1808–1810").
   // Extrait l'année d'un champ infobox Wikipedia.
    // Wikipedia structure réelle (vue sur Don Giovanni) :
    //   <th scope="row" class="infobox-label">Premiere</th>
    //   <td class="infobox-data">29 October 1787 ...</td>
    // Tolérant : <th> ou <tr> peuvent avoir n'importe quels attrs, et le
    // libellé peut être au singulier "Premiere" ou avec un suffixe (ex.
    // "Premiered on"). Capture aussi les plages d'années (1808-1810 → prend
    // la première). 1400+ pour couvrir Bach/Handel et antérieurs.
    const _extractInfoboxYear = (fieldName) => {
      // Pattern principal : <th ...>fieldName...</th><td ...>...</td>
      let m = html.match(new RegExp(`<th[^>]*>\\s*${fieldName}[^<]*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`, 'i'));
      // Fallback : Wikipedia met parfois le label dans un <div> ou autre structure
      if (!m) m = html.match(new RegExp(`>\\s*${fieldName}\\s*<\\/[^>]+>\\s*<[^>]+>([\\s\\S]{0,500}?)<\\/`, 'i'));
      if (!m) return null;
      const txt = m[1].replace(/<[^>]*>/g, ' ').replace(/&#?\w+;/g, ' ').trim();
      const yrs = txt.match(/\b(1[4-9][0-9]{2}|20[0-9]{2})\b/g);
      if (!yrs || !yrs.length) return null;
      const year = parseInt(yrs[0]);
      const maxY = new Date().getFullYear();
      return (year >= 1400 && year <= maxY) ? year : null;
    };

    // ── CLASSIQUE D'ABORD ──
    // Pour les œuvres classiques, l'année pertinente est celle de composition /
    // création, pas l'enregistrement moderne. Ces champs priment sur Recorded.
   // Wikipedia n'est pas cohérent sur les libellés : selon l'article,
    // l'infobox utilise "Premiere" (Don Giovanni, La Traviata, Carmen...)
    // OU "Premiered" (Faust, Tosca...). On teste les deux. Idem singulier
    // "Composition" vs verbe "Composed". Ordre = priorité de pertinence.
    const _classicalFields = ['Composed', 'Composition', 'Written', 'Premiere', 'Premiered', 'Performed', 'First performance'];
    for (const field of _classicalFields) {
      const y = _extractInfoboxYear(field);
      if (y) {
        if (WT_DEBUG_FETCH) console.debug(`[Wikipedia] Found ${field.toUpperCase()}:`, y, 'for', pageTitle);
        return { year: y, source: `Wikipedia (${field.toLowerCase()})` };
      }
    }

    // ── POP / ROCK : Recorded ──
    const recordedYear = _extractInfoboxYear('Recorded');
    if (recordedYear) {
      if (WT_DEBUG_FETCH) console.debug('[Wikipedia] Found RECORDED:', recordedYear, 'for', pageTitle);
      return { year: recordedYear, source: 'Wikipedia (recorded date)' };
    }
    
    // Fallback: chercher RELEASED si Recorded n'est pas trouvé
    const releasedPatterns = [
      /<th[^>]*>Released<\/th>\s*<td[^>]*>([^<]+)<\/td>/i,
      /<th[^>]*>released<\/th>\s*<td[^>]*>([^<]+)<\/td>/i,
      /Released<\/th>\s*<td[^>]*>([^<]+)/i
    ];
    
   for (const pattern of releasedPatterns) {
      const match = html.match(pattern);
      if (match) {
        const releasedText = match[1].replace(/<[^>]*>/g, '').trim();
       const yearMatch = releasedText.match(/\b(1[4-9][0-9]{2}|20[0-9]{2})\b/);
        if (yearMatch) {
          const year = parseInt(yearMatch[0]);
          if (year >= 1400 && year <= new Date().getFullYear()) {
            if (WT_DEBUG_FETCH) console.debug('[Wikipedia] Found RELEASED:', year, 'for', pageTitle);
            return { year: year, source: 'Wikipedia (release date)' };
          }
        }
        break;
      }
    }

    // ── FALLBACK INTRO (Phase Étape 2 session 5) ────────────────────────
    // Beaucoup d'articles d'œuvres classiques niches n'ont PAS d'infobox
    // structurée (ex. "Bona nox K.561" → pas de <th>Composed</th>) mais
    // contiennent la date dans le premier paragraphe : "1788 canon in 4
    // voices by W. A. Mozart..." ou "composed in 1721..." ou "premiered
    // on 29 October 1787...". On extrait depuis l'intro.
    //
    // Stratégie en 2 temps :
    //   1. Si la première phrase commence par une année (1500-actuel) +
    //      un mot-clé d'œuvre (canon, song, sonata, opera, symphony, etc.) →
    //      c'est presque toujours la date de composition. Très haute confiance.
    //   2. Sinon, chercher dans les 3000 premiers chars un pattern verbal
    //      explicite : "composed in YYYY", "written in YYYY", "premiered on
    //      ... YYYY", etc. Confiance correcte.
    {
      const introHtml = html.slice(0, 8000);
      const introText = introHtml.replace(/<[^>]+>/g, ' ').replace(/&#?\w+;/g, ' ').replace(/\s+/g, ' ').trim();
      const maxY = new Date().getFullYear();

      // 1. "1788 canon in 4 voices by Mozart" — année en tête + type d'œuvre
      const leadingYearWork = introText.match(/^\s*(1[4-9][0-9]{2}|20[0-9]{2})\s+(?:[a-z-]+\s+)?(canon|song|aria|sonata|symphony|concerto|opera|oratorio|cantata|fugue|prelude|nocturne|mass|requiem|quartet|quintet|trio|suite|overture|march|waltz|etude|impromptu|rondo|variation|fantasy|fantasia|ballade|scherzo|romance|serenade|divertimento|minuet|composition|work)\b/i);
      if (leadingYearWork) {
        const y = parseInt(leadingYearWork[1]);
        if (y >= 1400 && y <= maxY) {
          console.log('[Wikipedia] Found INTRO-LEADING:', y, 'for', pageTitle);
          return { year: y, source: 'Wikipedia (composed)' };
        }
      }

      // 2. Patterns verbaux explicites "composed in 1788", "written 1721",
      //    "premiered on 29 October 1787", "first performed in 1808"...
      //    On essaie chaque pattern et on garde le PREMIER match dans l'intro
      //    (= le plus haut dans la page, donc le plus pertinent).
      const verbalPatterns = [
        { re: /\bcompos(?:ed|ition)\s+(?:in\s+|on\s+|during\s+)?(?:the\s+year\s+)?(1[4-9][0-9]{2}|20[0-9]{2})/i, source: 'composed' },
        { re: /\bwritten\s+(?:in\s+|on\s+|during\s+)?(?:the\s+year\s+)?(1[4-9][0-9]{2}|20[0-9]{2})/i, source: 'composed' },
        { re: /\bpremiered\s+(?:on\s+|in\s+)?(?:\d{1,2}\s+\w+\s+)?(1[4-9][0-9]{2}|20[0-9]{2})/i, source: 'premiere' },
        { re: /\bfirst\s+performed\s+(?:on\s+|in\s+)?(?:\d{1,2}\s+\w+\s+)?(1[4-9][0-9]{2}|20[0-9]{2})/i, source: 'premiere' },
        { re: /\bfirst\s+performance\s+(?:was\s+)?(?:on\s+|in\s+)?(?:\d{1,2}\s+\w+\s+)?(1[4-9][0-9]{2}|20[0-9]{2})/i, source: 'premiere' },
      ];
      let bestMatch = null;
      let bestIdx = Infinity;
      for (const p of verbalPatterns) {
        const m = introText.match(p.re);
        if (m) {
          const idx = introText.indexOf(m[0]);
          if (idx < bestIdx) {
            const y = parseInt(m[1]);
            if (y >= 1400 && y <= maxY) {
              bestMatch = { year: y, source: `Wikipedia (${p.source})` };
              bestIdx = idx;
            }
          }
        }
      }
      if (bestMatch) {
        console.log('[Wikipedia] Found INTRO-VERBAL:', bestMatch.year, '/', bestMatch.source, 'for', pageTitle);
        return bestMatch;
      }
    }

    return null;
  } catch(e) {
    console.warn('[Wikipedia] Error:', e);
    return null;
  }
}

// ============================================================
// FONCTION DE SCORE POUR LES RÉSULTATS
// ============================================================

function calculateItemScore(itemName, itemArtist, targetAlbum, targetArtist) {
  let score = 0;
  
  const itemNameLower = (itemName || '').toLowerCase();
  const itemArtistLower = (itemArtist || '').toLowerCase();
  const targetAlbumLower = (targetAlbum || '').toLowerCase();
  const targetArtistLower = (targetArtist || '').toLowerCase();
  
  // Match album (poids fort)
  if (itemNameLower === targetAlbumLower) score += 100;
  else if (itemNameLower.includes(targetAlbumLower)) score += 60;
  else if (targetAlbumLower.includes(itemNameLower)) score += 40;
  
  // Match artiste
  if (targetArtistLower && itemArtistLower === targetArtistLower) score += 50;
  else if (targetArtistLower && itemArtistLower.includes(targetArtistLower)) score += 30;
  else if (targetArtistLower && targetArtistLower.includes(itemArtistLower)) score += 20;
  
  return Math.min(score, 150);
}

// ============================================================
// FONCTION D'AFFICHAGE DES RÉSULTATS
// ============================================================



// AcoustID lookup from renderer — uses public 'demo' client key.
// Returns { artist, album, title, year, score } or null.
async function acoustidLookup(fingerprint, duration){
  if(!fingerprint || !duration) return null;
  // ── DISABLED ── See main.js fetchFromAcoustID. Community-share path coming.
  return null;
  try {
    const url = `https://api.acoustid.org/v2/lookup?client=8XaBELgH&format=json&duration=${duration}&fingerprint=${encodeURIComponent(fingerprint)}&meta=recordings+releasegroups+compress`;
    const res = await fetch(url);
    const data = await res.json();
    if(!data || data.status !== 'ok' || !data.results?.length) return null;
    const best = data.results.find(r => r.score >= 0.7);
    if(!best || !best.recordings?.length) return null;
    const rec = best.recordings[0];
    let year = null, album = null;
    for(const rg of (rec.releasegroups || [])){
      if(rg.firstreleasedate){
        const y = parseInt(String(rg.firstreleasedate).slice(0,4));
        if(y && (!year || y < year)){ year = y; album = rg.title || album; }
      }
    }
    if(!album && rec.releasegroups?.[0]) album = rec.releasegroups[0].title;
    return {
      artist: rec.artists?.[0]?.name || null,
      title:  rec.title || null,
      album:  album,
      year:   year,
      score:  best.score
    };
  } catch(e){
    console.log('[acoustidLookup] failed:', e?.message || e);
    return null;
  }
}

// ============================================================
// FONCTION POUR APPLIQUER LA COVER ET LES INFOS
// ============================================================

window.applyCoverWithDetails = function(coverUrl, albumName, artistName, year, genre, coverOnly, titleName) {
  console.log('[applyCoverWithDetails]', { coverUrl, albumName, artistName, year, genre, coverOnly, titleName });
  // coverOnly = true : on n'applique QUE l'image (clic sur une vignette).
  // Les métadonnées (titre/album/artiste/année/genre) viennent du « meilleur
  // match » fiable, jamais d'une vignette dont l'année est souvent une réédition.
  if (coverOnly) { albumName = artistName = year = genre = titleName = null; }

  // 0. Titre (titre canonique du match — corrige les typos type "Pretend")
  if (titleName && document.getElementById('omniTitle')) {
    document.getElementById('omniTitle').value = titleName;
  }
  
  // 1. Cover
  if (coverUrl && coverUrl.length > 20) {
    if (typeof _omniPendingCoverUrl !== 'undefined') {
      _omniPendingCoverUrl = coverUrl;
    }
    if (typeof updateOmniPreview === 'function') {
      updateOmniPreview(coverUrl);
    }
    
    const pArt = document.getElementById('pArt');
    if (pArt) {
      pArt.innerHTML = `<img src="${coverUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:8px">`;
    }
    
    toast('✓ Cover appliquée');
  }
  
  // 2. Album
  if (albumName && document.getElementById('omniAlbum')) {
    document.getElementById('omniAlbum').value = albumName;
  }
  
  // 3. Artiste
  if (artistName && document.getElementById('omniArtist')) {
    document.getElementById('omniArtist').value = artistName;
  }
  
  // 4. Année
  if (year && document.getElementById('omniYear')) {
    document.getElementById('omniYear').value = year;
  }
  
  // 5. Genre — must map raw API genre ("Rock", "Punk Rock") to your 15 buckets
  // ("Classic Rock & Hard Rock", "Punk, Grunge & Alternative", etc.) before setting dropdown.
  if (genre && document.getElementById('omniGenre')) {
    const genreSelect = document.getElementById('omniGenre');
    const styleInput  = document.getElementById('omniStyle');
    // Try exact match first (in case API already returned a bucket name)
    let bucket = null;
    for (let i = 0; i < genreSelect.options.length; i++) {
      if (genreSelect.options[i].value === _genreToSelectOption(genre)) { bucket = genreSelect.options[i].value; break; }
    }
    // Fallback: map via clientMapGenre to one of the 15 buckets
    if (!bucket && typeof clientMapGenre === 'function') {
      bucket = clientMapGenre(genre);
    }
    // Apply bucket to dropdown
    if (bucket) {
      for (let i = 0; i < genreSelect.options.length; i++) {
        if (genreSelect.options[i].value === bucket) {
          genreSelect.selectedIndex = i;
          // Trigger change so any wired listeners (live preview, validation) fire
          try { genreSelect.dispatchEvent(new Event('change', { bubbles: true })); } catch(_){}
          break;
        }
      }
    }
    // Always store raw genre in style field for granular tagging (preserves "Synthwave" vs bucket "Electronic, House & Techno")
    if (styleInput && genre !== bucket) styleInput.value = genre;
  }
  
  toast('✓ Infos appliquées');
};



// ============================================================
// MAIN IDENTIFY FUNCTION - Called by the button
// (Note : la définition active est plus bas dans le fichier ; cette 1re
//  version a été renommée pour éviter d'occuper le nom et faciliter la
//  lecture. Aucun call site ne pointe sur ce nom alternatif.)
// ============================================================

async function _identifyCurrentTrackFromEditor_unused_v1() {
  const t = queue[qi];
  if (!t) {
    toast('Aucun morceau en cours');
    return;
  }
  
  const btn = document.getElementById('identifyBtn');
  const btnText = document.getElementById('identifyBtnText');
  
  if (btn) {
    btn.classList.add('searching');
    btn.classList.remove('success', 'error');
    if (btnText) btnText.textContent = 'Recherche...';
  }
  toast('🔍 Recherche multi-sources...');
  
  try {
    // Build search query from current track
    let searchQuery = '';
    
    if (t.artist && t.artist !== 'Artiste inconnu' && t.album && t.album !== 'Album inconnu') {
      searchQuery = `${t.artist} ${t.album}`;
    } else if (t.artist && t.title) {
      searchQuery = `${t.artist} ${t.title}`;
    } else {
      const fileName = t.path.split(/[/\\]/).pop() || '';
      searchQuery = fileName.replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' ');
    }
    
    if (!searchQuery || searchQuery.length < 3) {
      throw new Error('Nom de fichier trop court');
    }
    
    console.log('[identify] Searching for:', searchQuery);
    
    // Use unified search
    const searchResults = await unifiedSearch(searchQuery);
    
    // Fill the editor fields
    if (searchResults.bestMatch.artist && document.getElementById('omniArtist')) {
      document.getElementById('omniArtist').value = searchResults.bestMatch.artist;
    }
    
    if (searchResults.bestMatch.album && document.getElementById('omniAlbum')) {
      document.getElementById('omniAlbum').value = searchResults.bestMatch.album;
    }
    
    if (searchResults.bestMatch.year && document.getElementById('omniYear')) {
      document.getElementById('omniYear').value = searchResults.bestMatch.year;
      if (searchResults.bestMatch.yearSource) {
        toast(`✓ Année: ${searchResults.bestMatch.year} (${searchResults.bestMatch.yearSource})`);
      }
    }
    
    if (searchResults.bestMatch.genre && document.getElementById('omniGenre')) {
      const genreSelect = document.getElementById('omniGenre');
      let found = false;
      for (let i = 0; i < genreSelect.options.length; i++) {
        if (genreSelect.options[i].value === _genreToSelectOption(searchResults.bestMatch.genre)) {
          genreSelect.selectedIndex = i;
          found = true;
          break;
        }
      }
      if (!found && document.getElementById('omniStyle')) {
        document.getElementById('omniStyle').value = searchResults.bestMatch.genre;
      }
    }
    
    if (searchResults.bestMatch.cover && typeof _omniPendingCoverUrl !== 'undefined') {
      _omniPendingCoverUrl = searchResults.bestMatch.cover;
      if (typeof updateOmniPreview === 'function') {
        updateOmniPreview(searchResults.bestMatch.cover);
      }
    }
    
    // Set title
    if (t.title && document.getElementById('omniTitle')) {
      document.getElementById('omniTitle').value = t.title;
    }
    
    // Update search field
    const searchInput = document.getElementById('omniSearchIn');
    if (searchInput) {
      if (searchResults.bestMatch.artist && searchResults.bestMatch.album) {
        searchInput.value = `${searchResults.bestMatch.artist} ${searchResults.bestMatch.album}`;
      } else {
        searchInput.value = searchQuery;
      }
    }
    
    // Show all covers found
    if (searchResults.covers && searchResults.covers.length > 0) {
      const container = document.getElementById('omniResults');
      const status = document.getElementById('omniStatus');
      
      if (container) {
        const sourcesSummary = [...new Set(searchResults.covers.map(c => c.source))].join(', ');
        if (status) status.textContent = `${searchResults.covers.length} POCHETTES (${sourcesSummary})`;
        
        container.innerHTML = searchResults.covers.slice(0, 12).map(item => `
          <div style="flex:0 0 90px; cursor:pointer; text-align:center; margin:4px;" 
               onclick="window.applyCoverFromSearch('${(item.url || '').replace(/'/g, "\\'")}', '${item.year || ''}', '${(item.album || '').replace(/'/g, "\\'")}')">
            <img src="${item.url}" style="width:80px; height:80px; border-radius:6px; object-fit:cover; background:#1E1E1B;" 
              onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Crect width=%22100%22 height=%22100%22 fill=%22%23333%22/%3E%3Ctext x=%2250%22 y=%2255%22 text-anchor=%22middle%22 fill=%22%23777%22%3E?%3C/text%3E%3C/svg%3E'">
            <div style="font-size:7px; margin-top:4px; color:var(--t3); max-width:80px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${item.source}</div>
            ${item.year ? `<div style="font-size:8px; color:${item.isReissue ? 'var(--acc)' : '#4CAF50'}; font-weight:600; margin-top:2px;">${item.year}${item.isReissue ? ' ⚠️' : ' ✓'}</div>` : ''}
          </div>
        `).join('');
        container.style.display = 'flex';
        container.style.flexWrap = 'wrap';
        container.style.gap = '6px';
        container.style.justifyContent = 'flex-start';
      }
    }
    
    if (btn) {
      btn.classList.remove('searching');
      btn.classList.add('success');
      if (btnText) btnText.textContent = '✓ OK';
    }
    
    toast(`✓ ${searchResults.bestMatch.artist || ''} - ${searchResults.bestMatch.album || searchQuery}`);
    
    setTimeout(() => {
      if (btn) {
        btn.classList.remove('success');
        if (btnText) btnText.textContent = 'Identifier le morceau';
      }
    }, 1500);
    
  } catch (err) {
    console.error('[identifyCurrentTrackFromEditor]', err);
    if (btn) {
      btn.classList.remove('searching');
      btn.classList.add('error');
      if (btnText) btnText.textContent = 'Échec';
    }
    toast(`❌ ${err.message}`);
    
    setTimeout(() => {
      if (btn) {
        btn.classList.remove('error');
        if (btnText) btnText.textContent = 'Identifier le morceau';
      }
    }, 1500);
  }
}

window.runOmniSearch = async function() {
  const q = document.getElementById('omniSearchIn')?.value;
  const status = document.getElementById('omniStatus');
  const container = document.getElementById('omniResults');
  
  if (!q) {
    if (status) status.textContent = "ENTREZ UN ARTISTE OU ALBUM";
    if (container) container.innerHTML = '';
    return;
  }

  if (status) status.textContent = "RECHERCHE EN COURS...";
  if (container) {
    container.innerHTML = '<div style="padding:12px; text-align:center; color:var(--t3)">🔍 Recherche...</div>';
    container.style.display = 'flex';
  }

  try {
    const results = await unifiedSearch(q);
    
    if (!results.covers || results.covers.length === 0) {
      if (status) status.textContent = "AUCUNE POCHETTE TROUVEE";
      if (container) {
        container.innerHTML = '<div style="padding:12px; text-align:center; color:var(--t3)">Aucune pochette trouvée</div>';
      }
      return;
    }
    
    if (status) status.textContent = `${results.covers.length} POCHETTE${results.covers.length > 1 ? 'S' : ''}`;
    
    // ✅ MODIFIED: onclick now calls a function that ONLY applies the cover
    // NOT the metadata (year/album)
    container.innerHTML = results.covers.slice(0, 12).map(item => `
      <div style="flex:0 0 90px; cursor:pointer; text-align:center; margin:4px;" 
           onclick="window.applyCoverOnly('${(item.url || '').replace(/'/g, "\\'")}')">
        <img src="${item.url}" style="width:80px; height:80px; border-radius:6px; object-fit:cover; background:#1E1E1B;" 
          onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Crect width=%22100%22 height=%22100%22 fill=%22%23333%22/%3E%3Ctext x=%2250%22 y=%2255%22 text-anchor=%22middle%22 fill=%22%23777%22%3E?%3C/text%3E%3C/svg%3E'">
        <div style="font-size:7px; margin-top:4px; color:var(--t3); max-width:80px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${item.source}</div>
        ${item.year ? `<div style="font-size:8px; color:${item.isReissue ? 'var(--acc)' : '#4CAF50'}; font-weight:600; margin-top:2px;">${item.year}${item.isReissue ? ' ⚠️' : ' ✓'}</div>` : ''}
      </div>
    `).join('');
    
    _omniResMode(container, 'row'); // repart d'un état propre (efface un éventuel mode colonne)
    container.style.flexWrap = 'wrap';
    container.style.gap = '6px';
    
  } catch (err) {
    console.error('[runOmniSearch]', err);
    if (status) status.textContent = "ERREUR: " + err.message;
  }
};

// ✅ NEW FUNCTION: Apply ONLY the cover, not year/album
// Appliquer la cover à l'éditeur ET au player
window.applyCoverToEditor = function(coverUrl) {
  if (coverUrl && coverUrl.length > 20) {
    // Mettre à jour l'éditeur
    if (typeof _omniPendingCoverUrl !== 'undefined') {
      _omniPendingCoverUrl = coverUrl;
    }
    if (typeof updateOmniPreview === 'function') {
      updateOmniPreview(coverUrl);
    }
    
    // Mettre à jour le player IMMÉDIATEMENT
    const pArt = document.getElementById('pArt');
    if (pArt) {
      pArt.innerHTML = `<img src="${coverUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:8px">`;
    }
    
    // Mettre à jour le fullscreen si actif
    if (typeof _fsActive !== 'undefined' && _fsActive) {
      const fsArt = document.getElementById('fsArtImg');
      if (fsArt) {
        fsArt.style.backgroundImage = `url("${coverUrl.replace(/"/g, '\\"')}")`;
        fsArt.classList.remove('no-art');
      }
    }
    
    // Mettre à jour la mini-queue
    const miniDisc = document.getElementById('miniDisc');
    if (miniDisc) {
      miniDisc.innerHTML = `<img src="${coverUrl}"><div style="position:absolute;width:16px;height:16px;border-radius:50%;background:var(--bg1);box-shadow:0 0 0 2px var(--bg3);z-index:2;top:50%;left:50%;transform:translate(-50%,-50%)"></div>`;
    }
    
    toast('✓ Pochette sélectionnée');
  }
};

// Normalise un titre pour comparaison : minuscules, sans accents, sans ponctuation,
// sans mentions parasites (live, unplugged, remaster, deluxe…).
function _normAlbumName(s){
  if(!s) return '';
  return String(s)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // retire les accents
    .replace(/\b(live|unplugged|remaster(ed)?|deluxe|edition|anniversary|mtv|bonus|reissue|version)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')                          // ponctuation → espace
    .replace(/\s+/g, ' ').trim();
}
// Mesure de chevauchement entre l'album cherché et l'album d'une cover.
// Retourne true si la cover correspond « assez » à l'album recherché.
// ── COMPILATION : DÉTECTEUR UNIQUE (C207) ───────────────────────────────
// Source de vérité unique pour _isComp (fetchConsolidatedMeta) + les pochettes
// + la propagation album. Vrai si le chemin traverse un dossier
// « Compilations », ou si album/artiste portent un marqueur de compil.
// NB : _albCompilFix (Étage 1, _processItem) reste VOLONTAIREMENT séparé — son
// jeu de mots-clés diffère (billboard / top N / éxitos, et surtout PAS « live »).
// L'y fusionner ferait passer les albums live sous l'Étage 1, qui écraserait
// leur année de concert par l'année studio d'origine. L'harmonisation des deux
// mérite sa passe dédiée (résiduel connu), pas un effet de bord ici.
function isCompilationTrack(t) {
  if (!t) return false;
  if (t.path && /\/Compilations\//i.test(t.path)) return true;
  // C218 : « live » RETIRÉ du détecteur. Un album live d'un artiste unique n'est
  // PAS une compilation : il a UN artiste, UNE année, UNE pochette. Le traiter
  // comme une compil déclenchait la recherche par enregistrement piste par piste,
  // qui tombait sur des enregistrements épars du même artiste — d'où les DIX
  // années différentes (1996, 1997, 1999…) sur les dix titres de « Prepárense
  // (Live in der Stadthalle Wuppertal) ». Il hérite désormais de la recherche par
  // album (une seule année) et de la propagation album.
  // Une compil live reste détectée par « various » / « compilation ».
  return /various|compilation|soundtrack|bande originale|\bost\b|greatest hits|best of|the very best|collection|anthology/i
    .test((t.album || '') + ' ' + (t.artist || ''));
}

// ── COMPILATION « ARTISTES VARIÉS » (C207) ──────────────────────────────
// À NE PAS confondre avec isCompilationTrack : un best-of solo (« Queen —
// Greatest Hits ») est une compilation, mais son artiste reste une contrainte
// de recherche INDISPENSABLE (sans elle, iTunes renvoie la pochette d'un
// homonyme → cross-contamination). Ici on ne détecte que les vraies compils
// multi-artistes, où l'artiste de la piste (« Aretha Franklin ») ne matchera
// jamais l'artiste de l'album (« Various Artists ») : c'est CE cas qui faisait
// rejeter toutes les pochettes de compilation.
// Signal décisif : ≥ 3 artistes distincts dans le même dossier d'album.
const _vaAlbumCache = new Map();
function isVariousArtistsAlbum(t) {
  if (!t) return false;
  if (/^(various\s*artists?|various|varios|va|divers|compilations?)$/i.test(String(t.artist || '').trim())) return true;
  const dir = String(t.path || '').replace(/\/[^/]*$/, '');
  const alb = String(t.album || '').trim();
  if (!dir || !alb) return false;
  const key = dir + '||' + alb.toLowerCase();
  if (_vaAlbumCache.has(key)) return _vaAlbumCache.get(key);
  let res = false;
  if (typeof allTracks !== 'undefined' && Array.isArray(allTracks)) {
    const sibs = allTracks.filter(x => String(x.path || '').replace(/\/[^/]*$/, '') === dir);
    if (sibs.length >= 4) {
      const keys = new Set();
      for (const x of sibs) {
        const k = (typeof _normArtistKey === 'function')
          ? _normArtistKey(x.artist || '')
          : String(x.artist || '').toLowerCase().trim();
        if (k) keys.add(k);
      }
      res = keys.size >= 3;
    }
  }
  _vaAlbumCache.set(key, res);
  return res;
}

// ── PROPAGATION ALBUM (C208) ────────────────────────────────────────────
// Un album a UNE année, UN genre et UNE pochette. Quand l'auto les trouve pour
// le morceau en lecture, les autres pistes du même album en héritent — plus
// besoin de jouer les 12 titres pour compléter le disque.
// Garde-fous : jamais sur une compilation ; ne remplit que le VIDE ; n'écrase
// jamais une valeur existante ; ne touche jamais un morceau _userModified.
function _albumSiblings(t) {
  if (!t || typeof allTracks === 'undefined' || !Array.isArray(allTracks)) return [];
  if (isCompilationTrack(t)) return [];
  const dir = String(t.path || '').replace(/\/[^/]*$/, '');
  const alb = String(t.album || '').trim().toLowerCase();
  if (!dir || !alb) return [];
  return allTracks.filter(x => x && x !== t && x.path
    && String(x.path).replace(/\/[^/]*$/, '') === dir
    && String(x.album || '').trim().toLowerCase() === alb
    && !isCompilationTrack(x));
}

function propagateAlbumMeta(src, opts = {}) {
  const sibs = _albumSiblings(src);
  if (!sibs.length) return 0;
  const yv = opts.year ? parseInt(opts.year) : null;
  const gv = opts.genre || null;
  const cv = opts.cover || null;
  if (!yv && !gv && !cv) return 0;
  let n = 0, metaTouched = false, coverTouched = false;
  for (const x of sibs) {
    let changed = false;
    if (!x._userModified) {
      if (yv && (!x.year || (typeof isJunkYear === 'function' && isJunkYear(x.year)))) {
        x.year = yv; changed = true; metaTouched = true;
      }
      if (gv && (!x.genre || (typeof isJunkGenre === 'function' && isJunkGenre(x.genre)))) {
        x.genre = gv; changed = true; metaTouched = true;
      }
      if (changed) {
        x._autoFixed = true;
        x._autoFix = { genre: gv ? { from: '', to: gv } : null,
                       year:  yv ? { from: '', to: yv } : null,
                       album: null, source: 'propagation album', ts: Date.now() };
        if (typeof recordAutoFix === 'function') recordAutoFix(x, x._autoFix);
        try {
          if (window.wt?.applyTrackMetaToMain) {
            window.wt.applyTrackMetaToMain({ path: x.path, genre: x.genre, year: x.year, album: x.album, source: 'propagation-album' });
          }
        } catch (e) { /* silent */ }
        const noG = !x.genre || (typeof isJunkGenre === 'function' && isJunkGenre(x.genre));
        const noY = !x.year  || (typeof isJunkYear  === 'function' && isJunkYear(x.year));
        if (noG || noY) x._incomplete = true; else delete x._incomplete;
      }
    }
    if (cv && typeof customCovers !== 'undefined' && !customCovers[x.path]) {
      customCovers[x.path] = cv; coverTouched = true; changed = true;
    }
    if (changed) {
      n++;
      if (typeof schedulePropagateTrackUpdate === 'function') schedulePropagateTrackUpdate(x);
    }
  }
  if (metaTouched  && typeof scheduleMetaSave === 'function') scheduleMetaSave();
  if (coverTouched && typeof scheduleSave === 'function') scheduleSave();
  if (n) {
    console.log(`[propagation album] « ${src.album} » : ${n} morceau(x) complété(s)`
      + (yv ? ` · année ${yv}` : '') + (gv ? ` · genre ${gv}` : '') + (cv ? ' · pochette' : ''));
    if (typeof refreshReviewBadge === 'function') refreshReviewBadge();
    if (typeof _scheduleEnrichUiRefresh === 'function') _scheduleEnrichUiRefresh();
  }
  return n;
}

function _albumMatches(wanted, candidate){
  const w = _normAlbumName(wanted);
  const c = _normAlbumName(candidate);
  if(!w || !c) return true;          // pas d'info → on ne rejette pas (bénéfice du doute)
  if(w === c) return true;
  if(c.includes(w) || w.includes(c)) return true;
  // Chevauchement de mots : combien de mots de l'album cherché sont dans le candidat ?
  const wWords = new Set(w.split(' ').filter(x => x.length > 2));
  if(wWords.size === 0) return true;
  const cWords = new Set(c.split(' '));
  let hits = 0;
  for(const word of wWords){ if(cWords.has(word)) hits++; }
  return (hits / wWords.size) >= 0.5;   // au moins la moitié des mots significatifs
}

// Version cross-référence : cherche le placeholder ET le morceau en parallèle
// Fonction unifiée simplifiée - cherche tout et affiche les résultats
// Version corrigée - cherche ET applique TOUTES les infos (cover, artiste, album, année, genre)
// Détective : extrait une année plausible (1900-2049) d'un nom d'album/titre/requête.
// Ex. "Billboard Top 100 1956" → 1956. Sert d'indice de désambiguïsation et de
// repli année (principe : l'année d'origine prime sur les rééditions).
function _extractYearClue(...texts) {
  for (const t of texts) {
    const m = String(t || '').match(/\b(19[0-9]{2}|20[0-4][0-9])\b/);
    if (m) return parseInt(m[1]);
  }
  return null;
}

// Année lue dans le TITRE = signal FORT (l'édition marque l'année d'origine,
// ex. "Completely Sweet (rock version 56)" → 1956). 4 chiffres, OU 2 chiffres
// 30-99 en contexte d'année (version/live/rec/mix/remaster/edit ou apostrophe
// '56) → 19xx. On évite les petits numéros de version (< 30) et les 20xx ambigus.
function _extractTitleYear(title) {
  const t = String(title || '');
  const m4 = t.match(/\b(19[0-9]{2}|20[0-4][0-9])\b/);
  if (m4) return parseInt(m4[1]);
  const m2 = t.match(/(?:version|live|rec(?:orded)?|mix|remaster(?:ed)?|edit|ver\.?|['’])\s*['’]?\b([3-9][0-9])\b/i);
  if (m2) return 1900 + parseInt(m2[1]);
  return null;
}

// Clé de comparaison d'artiste : minuscules, sans accents ni ponctuation.
// "AC/DC" -> "acdc", "ACDC" -> "acdc", "ACDC Back" -> "acdcback". Sert à valider
// un artiste trouvé contre le tag fichier (détecte les crédits parasites).
function _normArtistKey(s){
  return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
}

// Clé de REGROUPEMENT d'artiste : en plus de _normArtistKey (accents, casse,
// ponctuation), unifie « and »/« et »/« y » avec « & » — sinon « Bela Fleck &
// The Flecktones », « Béla Fleck & … » et « Bela Fleck And … » forment trois
// groupes distincts dans la bibliothèque.
function _artistGroupKey(s){
  return _normArtistKey(String(s||'').replace(/\s+(and|et|y)\s+/gi, ' '));
}
// Variante d'affichage canonique d'un artiste = la graphie MAJORITAIRE parmi
// les morceaux partageant la même clé de groupe. Cache invalidé quand la
// bibliothèque change de taille (resync).
let _agkCache = null;
function _artistDisplayGroup(raw){
  if(!raw) return '';
  if(typeof allTracks === 'undefined' || !allTracks.length) return raw;
  if(!_agkCache || _agkCache.n !== allTracks.length){
    const counts = new Map();
    for(const t of allTracks){
      const a = t.artist; if(!a) continue;
      const k = _artistGroupKey(a); if(!k) continue;
      let m = counts.get(k); if(!m){ m = new Map(); counts.set(k, m); }
      m.set(a, (m.get(a) || 0) + 1);
    }
    const best = new Map();
    for(const [k, m] of counts){
      let bn = '', bc = -1;
      for(const [v, c] of m){ if(c > bc){ bc = c; bn = v; } }
      best.set(k, bn);
    }
    _agkCache = { n: allTracks.length, best };
  }
  return _agkCache.best.get(_artistGroupKey(raw)) || raw;
}

// Sépare un artiste "principal feat. autres". Conservateur : ne coupe QUE sur des
// marqueurs explicites (feat/ft/featuring, ou "(with …)"), et jamais sur "X & the Y"
// (= nom de groupe). Les listes "A, B & C" SANS marqueur ne sont pas coupées ici
// (gérées contextuellement au regroupement, pour ne pas casser "Earth, Wind & Fire").
function _splitArtistFeat(str){
  const raw=String(str||'').trim();
  if(!raw) return { primary:'', others:[], display:'' };
  if(/\s(?:&|and)\s+the\s+/i.test(raw)) return { primary:raw, others:[], display:raw };
  const m=raw.match(/[\(\[]\s*(?:feat\.?|ft\.?|featuring|with)\s+|[\s,]+(?:feat\.?|ft\.?|featuring)\s+/i);
  if(m && m.index>0){
    const primary=raw.slice(0,m.index).replace(/[\s,&([]+$/,'').trim();
    const rest=raw.slice(m.index+m[0].length).replace(/[\s)\]]+$/,'').trim();
    const others=rest.split(/\s*(?:,|&|;|\bet\b|\band\b)\s*/i).map(s=>s.trim()).filter(Boolean);
    return { primary, others, display: others.length?`${primary} feat. ${others.join(', ')}`:primary };
  }
  return { primary:raw, others:[], display:raw };
}

// Clés des artistes présents "en solo" (sans séparateur) — sert à rattacher une
// collab "A, B & C" à A seulement si A existe par ailleurs seul dans la liste.
function _corrSoloKeys(list){
  const s=new Set();
  for(const t of (list||[])){
    const a=(t.artist||'').trim();
    if(a && !/[,&]/.test(a)){ const fs=_splitArtistFeat(a); if(!fs.others.length) s.add(_normArtistKey(fs.primary)); }
  }
  return s;
}

// Clé/nom de regroupement d'un morceau par artiste PRINCIPAL (+ note "feat").
function _corrGroupKey(t, soloKeys){
  const a=(t.artist||'').trim();
  if(!a) return { key:'', name:'Artiste inconnu', feat:'' };
  const fs=_splitArtistFeat(a);
  if(fs.others.length) return { key:_normArtistKey(fs.primary), name:fs.primary, feat:fs.others.join(', ') };
  const seg=a.split(/\s*[,&]\s*/); // PAS sur "/" (AC/DC)
  if(seg.length>1){
    const first=seg[0].trim(); const fk=_normArtistKey(first);
    if(fk && soloKeys && soloKeys.has(fk)) return { key:fk, name:first, feat:seg.slice(1).join(', ') };
  }
  return { key:_normArtistKey(a)||a.toLowerCase(), name:a, feat:'' };
}

// Sépare un artiste "principal feat. autres". Conservateur : ne coupe QUE sur des
// marqueurs explicites (feat/ft/featuring, ou "(with …)"), et jamais sur "X & the Y"
// (= nom de groupe). Les listes "A, B & C" SANS marqueur ne sont pas coupées ici
// (gérées contextuellement au regroupement, pour ne pas casser "Earth, Wind & Fire").
function _splitArtistFeat(str){
  const raw=String(str||'').trim();
  if(!raw) return { primary:'', others:[], display:'' };
  if(/\s(?:&|and)\s+the\s+/i.test(raw)) return { primary:raw, others:[], display:raw };
  const m=raw.match(/[\(\[]\s*(?:feat\.?|ft\.?|featuring|with)\s+|[\s,]+(?:feat\.?|ft\.?|featuring)\s+/i);
  if(m && m.index>0){
    const primary=raw.slice(0,m.index).replace(/[\s,&([]+$/,'').trim();
    const rest=raw.slice(m.index+m[0].length).replace(/[\s)\]]+$/,'').trim();
    const others=rest.split(/\s*(?:,|&|;|\bet\b|\band\b)\s*/i).map(s=>s.trim()).filter(Boolean);
    return { primary, others, display: others.length?`${primary} feat. ${others.join(', ')}`:primary };
  }
  return { primary:raw, others:[], display:raw };
}

// Clés des artistes présents "en solo" (sans séparateur) — sert à rattacher une
// collab "A, B & C" à A seulement si A existe par ailleurs seul dans la liste.
function _corrSoloKeys(list){
  const s=new Set();
  for(const t of (list||[])){
    const a=(t.artist||'').trim();
    if(a && !/[,&]/.test(a)){ const fs=_splitArtistFeat(a); if(!fs.others.length) s.add(_normArtistKey(fs.primary)); }
  }
  return s;
}

// Clé/nom de regroupement d'un morceau par artiste PRINCIPAL (+ note "feat").
function _corrGroupKey(t, soloKeys){
  const a=(t.artist||'').trim();
  if(!a) return { key:'', name:'Artiste inconnu', feat:'' };
  const fs=_splitArtistFeat(a);
  if(fs.others.length) return { key:_normArtistKey(fs.primary), name:fs.primary, feat:fs.others.join(', ') };
  const seg=a.split(/\s*[,&]\s*/); // PAS sur "/" (AC/DC)
  if(seg.length>1){
    const first=seg[0].trim(); const fk=_normArtistKey(first);
    if(fk && soloKeys && soloKeys.has(fk)) return { key:fk, name:first, feat:seg.slice(1).join(', ') };
  }
  return { key:_normArtistKey(a)||a.toLowerCase(), name:a, feat:'' };
}

// Recherche par PISTE iTunes (entity=song) : ramène l'artiste réel + année +
// genre + pochette d'un MORCEAU (pas d'un album). Crucial pour les compils/B.O.
// où l'album ne dit rien de la piste (ex. "The Great Pretender" → The Platters).
async function fetchItunesTracks(title, artist) {
  try {
    const term = [artist, title].filter(Boolean).join(' ');
    if (!term.trim()) return { covers: [], bestMatch: null };
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&limit=10`;
    const response = await fetchWithRetry(url);
    if (!response.ok) return { covers: [], bestMatch: null };
    const data = await response.json();
    if (!data.results?.length) return { covers: [], bestMatch: null };
    const covers = []; let bestMatch = null, bestScore = -1;
    for (const it of data.results) {
      const year = it.releaseDate ? it.releaseDate.split('-')[0] : null;
      const score = calculateItemScore(it.trackName, it.artistName, title, artist);
      const cand = {
        url: it.artworkUrl100 ? it.artworkUrl100.replace('100x100bb', '600x600bb') : null,
        album: it.collectionName || '', artist: it.artistName || '',
        year, genre: it.primaryGenreName || null,
        source: 'iTunes (titre)', quality: 600, score
      };
      if (cand.url) covers.push(cand);
      if (score > bestScore) { bestScore = score; bestMatch = cand; }
    }
    return { covers, bestMatch };
  } catch (e) { return { covers: [], bestMatch: null }; }
}

// Recherche par PISTE Deezer (/search/track) : artiste + album + pochette
// (pas d'année sur la recherche track Deezer, iTunes la fournit).
async function fetchDeezerTracks(title, artist) {
  try {
    const term = [artist, title].filter(Boolean).join(' ');
    if (!term.trim()) return { covers: [], bestMatch: null };
    const url = `https://api.deezer.com/search/track?q=${encodeURIComponent(term)}&limit=10`;
    const response = await fetchWithRetry(url);
    if (!response.ok) return { covers: [], bestMatch: null };
    const data = await response.json();
    if (!data.data?.length) return { covers: [], bestMatch: null };
    const covers = []; let bestMatch = null, bestScore = -1;
    for (const it of data.data) {
      const score = calculateItemScore(it.title, it.artist?.name, title, artist);
      const cand = {
        url: it.album?.cover_xl || it.album?.cover_big || null,
        album: it.album?.title || '', artist: it.artist?.name || '',
        year: null, genre: null,
        source: 'Deezer (titre)', quality: it.album?.cover_xl ? 1000 : 500, score
      };
      if (cand.url) covers.push(cand);
      if (score > bestScore) { bestScore = score; bestMatch = cand; }
    }
    return { covers, bestMatch };
  } catch (e) { return { covers: [], bestMatch: null }; }
}

// Nettoie un titre pour la recherche : retire l'extension fichier (.mp3…) et le
// numéro de piste en tête ("01. ", "05 - ", "13) "). Sans ça, "Monte Carlo
// Nights.MP3" pollue la requête iTunes/Deezer et ne matche rien.
function _cleanTrackTitle(title) {
  let t = String(title || '').trim();
  t = t.replace(/\.(mp3|m4a|aac|flac|wav|ogg|opus|wma|aiff|alac)$/i, '');
  t = t.replace(/^\s*\d{1,3}\s*[.\-_)]\s*/, '');
  t = t.replace(/^\s*\d{1,3}\s+(?=[A-Za-zÀ-ÿ])/, '');
  return t.trim();
}

// Recherche par PISTE via le MAIN (User-Agent correct → fini les 403 d'iTunes),
// sur MusicBrainz : renvoie l'artiste réel + l'année d'origine du morceau. On
// renvoie le même format que les autres résultats ({ bestMatch, covers }) pour
// que la consolidation détective le consomme tel quel.
async function _searchByTrack(track, yearHint, isComp) {
  if (!track || !track.title) return [];
  const cleanTitle = _cleanTrackTitle(track.title);
  if (!cleanTitle) return [];
  try {
    if (!window.wt?.fetchOnlineMeta) return [];
    const _path = 'trk::' + (track.artist || '') + '||' + cleanTitle;
    const _dur = (track.duration && track.duration > 0) ? Math.round(track.duration) : null;
    const _groups = [{ artist: track.artist || '', album: track.album || '', title: cleanTitle, paths: [_path], trackSearch: true, yearHint: yearHint || null, isComp: !!isComp, durationSec: _dur }];
    const _out = await window.wt.fetchOnlineMeta(_groups);
    const tl = (_out && _out[_path]) ? _out[_path].trackLevel : null;
    console.log(`[_searchByTrack] "${cleanTitle}" (indice ${yearHint || '∅'}) → ${tl ? (tl.artist || '?') + ' / ' + (tl.year || '?') : 'rien'}`);
    if (!tl || (!tl.artist && !tl.year)) return [];
    return [{
      bestMatch: {
        artist: tl.artist || null, year: tl.year || null, album: tl.album || null,
        title: tl.title || null, cover: tl.cover || null,
        genre: tl.genre || null, source: 'recherche par titre', score: tl.score || 80
      },
      covers: tl.cover ? [{ url: tl.cover, album: tl.album || '', artist: tl.artist || '', year: tl.year || null, source: 'iTunes (titre)', quality: 600 }] : []
    }];  } catch (e) { return []; }
}

// Nettoie une requête de recherche : retire le bruit qui fait rater pochette/match
// (underscores, [From …]/(Deluxe), « Disc N », plages d'années « 1969-1999 », mots
// consécutifs dupliqués « Haydn Haydn »). Pour la RECHERCHE seulement, pas l'affichage.
function _cleanMetaQuery(s) {
  if (!s) return '';
  let q = String(s)
    .replace(/_+/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(?:dis[ck]|disque|cd)\s*\.?\s*\d+\b/gi, ' ')
    .replace(/\b(?:19|20)\d{2}\s*[-\u2013]\s*(?:19|20)\d{2}\b/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  q = q.replace(/\b(\w+)(?:\s+\1\b)+/gi, '$1');
  return q;
}

// Mode d'affichage de #omniResults. Le CSS le définit en BANDE horizontale
// (flex-direction:row + overflow-x:auto) pour la grille de pochettes — mais les
// panneaux empilés (« aucune pochette fiable », MEILLEUR MATCH, tracklist,
// AcoustID) ont besoin d'une COLONNE. Sans bascule explicite, ils se mettaient
// côte à côte dans le scroll horizontal → chevauchement/débordement. En prime,
// runOmniSearch laissait traîner flexWrap/gap inline d'une recherche à l'autre.
function _omniResMode(el, mode) {
  if (!el) return;
  el.style.display = 'flex';
  if (mode === 'column') {
    el.style.flexDirection = 'column';
    el.style.overflowX = 'hidden';
    el.style.flexWrap = '';
    el.style.gap = '10px';
    el.style.justifyContent = '';
  } else { // 'row' : bande/grille de vignettes (comportement CSS d'origine)
    el.style.flexDirection = '';
    el.style.overflowX = '';
    el.style.flexWrap = '';
    el.style.gap = '';
    el.style.justifyContent = '';
  }
}

async function searchCrossReference() {
  const userQuery = document.getElementById('omniSearchIn')?.value.trim();
  // C223 : champ MORCEAU dédié. L'album et le morceau ne répondent pas à la même
  // question — « 30 Greatest Hits » (2001) vs « Respect » (1967). On ne devine
  // plus l'intention : chaque champ dit ce qu'il est.
  const trackQuery = document.getElementById('omniSearchTrack')?.value.trim();
  // Découpe « Artiste Titre » en s'ANCRANT sur le tag artiste (même technique que
  // C210 pour l'album) — jamais de découpage moitié-moitié à l'aveugle.
  const _splitOnArtist = (txt, tagArtist) => {
    const s = String(txt || '').trim();
    const a = String(tagArtist || '').trim();
    if (!s) return null;
    if (a && s.toLowerCase().startsWith(a.toLowerCase() + ' ')) {
      const rest = s.slice(a.length).trim();
      if (rest) return { artist: a, rest };
    }
    return { artist: a, rest: s };   // pas de préfixe artiste → tout le texte est le titre
  };
  // Track being identified: prefer the track open in the omni editor (most common case),
  // fall back to the playback queue if the editor isn't open.
  const currentTrack = (typeof _omniSpecificRef !== 'undefined' && _omniSpecificRef)
                         ? _omniSpecificRef
                         : queue[qi];

  // Détective : indice d'année lu dans album / titre / requête (ex. 1956).
  const _yearClue = _extractYearClue(currentTrack?.album, currentTrack?.title, userQuery);
  // Année lue dans le titre (prime sur album/ancrage qui peuvent donner la réédition).
  const _titleYear = _extractTitleYear(currentTrack?.title);

  // Recherche MANUELLE = l'utilisateur veut du FRAIS. On vide le cache de
  // recherche renderer pour ne pas resservir un vieux résultat (ex. "pas de
  // cover" resté collé). Le cache reste utile pour l'enrichissement auto.
  _unifiedSearchCache.clear();

  let searchQueries = [];
  
  // 1. User-typed input
  // C210 : le champ est PRÉREMPLI avec « artiste album » CONCATÉNÉS. Envoyé tel
  // quel, unifiedSearch le redécoupe moitié-moitié : « Gong Under Ground Modern »
  // → artiste « Gong Under » + album « Ground Modern ». Quand le texte commence
  // par l'artiste du tag, on reconstruit la requête STRUCTURÉE — celle
  // qu'unifiedSearch préfère explicitement (« preferred, no guessing »).
  if (userQuery && userQuery.length >= 3) {
    const _uqArtist = String(currentTrack?.artist || '').trim();
    const _uqRest = (_uqArtist && userQuery.toLowerCase().startsWith(_uqArtist.toLowerCase() + ' '))
      ? userQuery.slice(_uqArtist.length).trim()
      : '';
    if (_uqRest) {
      searchQueries.push({ artist: _uqArtist, album: _uqRest, title: currentTrack?.title || '', _force: true });
    } else {
      searchQueries.push(userQuery);
    }
  }
  
  // 2. Current track structured query (preferred — no parsing needed)
  if (currentTrack) {
    // Album taggé « Artiste - Album » (préfixe artiste redondant, ex.
    // « The Doors - Greatest Hits ») : on retire le préfixe POUR LA REQUÊTE
    // seulement (le tag affiché reste intact), sinon cover/année cherchent
    // « The Doors - Greatest Hits » au lieu de « Greatest Hits » → rien de bon.
    // Approche chaîne (pas de RegExp) → robuste aux noms à caractères spéciaux.
    let _albForQuery = currentTrack.album;
    if (currentTrack.artist && _albForQuery) {
      const _a = currentTrack.artist.trim().toLowerCase();
      const _alb = String(_albForQuery).trim(), _low = _alb.toLowerCase();
      for (const _sep of [' - ', ' – ', ' — ', ': ', ' : ']) {
        if (_low.startsWith(_a + _sep.toLowerCase())) { _albForQuery = _alb.slice((_a + _sep).length).trim(); break; }
      }
      if (!_albForQuery) _albForQuery = currentTrack.album;
    }
    _albForQuery = _cleanMetaQuery(_albForQuery) || _albForQuery;  // retire le bruit (Disc N, _, plages d'années) pour la recherche
    if (currentTrack.artist && _albForQuery) {
      searchQueries.push({ artist: currentTrack.artist, album: _albForQuery, title: currentTrack.title || '', _force: true });
    }
  }

  // 3. C223 — REQUÊTE MORCEAU, issue du champ dédié (édité ou prérempli).
  // Elle remplace l'ancienne requête « titre-comme-album » construite en douce
  // depuis le tag : si le titre du fichier est pourri (« 03 - track.mp3 »),
  // l'utilisateur peut enfin le corriger ICI et retrouver l'enregistrement,
  // sans toucher au tag ni au champ album.
  const _tq = _splitOnArtist(trackQuery, currentTrack?.artist);
  const _trkTitle  = _tq ? _tq.rest   : (currentTrack?.title  || '');
  const _trkArtist = _tq ? _tq.artist : (currentTrack?.artist || '');
  if (_trkArtist && _trkTitle) {
    searchQueries.push({ artist: _trkArtist, album: _trkTitle, _force: true });
  }
  
  // Dedup heterogeneous queries (strings + objects)
  const _seen = new Set();
  searchQueries = searchQueries.filter(q => {
    const key = typeof q === 'string' ? q : `${q.artist}||${q.album}`;
    if(_seen.has(key)) return false;
    _seen.add(key);
    return true;
  });
  
  if (searchQueries.length === 0) {
    toast('Entrez un artiste/album ou lancez un morceau');
    return;
  }
  
  const btn = document.getElementById('identifyBtn');
  const btnText = document.getElementById('identifyBtnText');
  const container = document.getElementById('omniResults');
  const status = document.getElementById('omniStatus');
  
  if (btn) {
    btn.classList.add('searching');
    if (btnText) btnText.textContent = 'Recherche...';
  }
  if (status) status.textContent = "RECHERCHE EN COURS...";
  if (container) {
    container.innerHTML = '<div style="padding:12px; text-align:center; color:var(--t3)">🔍 Recherche...</div>';
    container.style.display = 'flex';
  }
  
  try {
   // Run all searches in parallel. Agrège covers ET bestMatch (année + genre)
    // de chaque query — le 1er appel utilise (artist + album), le 2ème utilise
    // (artist + title) qui est crucial pour les compilations classiques où
    // l'œuvre est dans le TITRE (ex. "Turkish March" dans "Piano Masterpieces").
    const allResults = await Promise.all(
      searchQueries.map(async (query) => await unifiedSearch(query))
    );
    // Recherche par PISTE (titre) en complément de l'album — débloque compils/B.O.
    // Signal compil/B.O. AVANT l'appel (depuis le fichier seul : chemin + nom d'album)
    // → déclenche l'ancrage par tracklist. Inclut "best of" et le cas SANS artiste.
    const _isCompEarly = (currentTrack?.path && /\/Compilations\//i.test(currentTrack.path))
      || /various|compilation|soundtrack|bande originale|\bost\b|greatest hits|best of|the best of|billboard|top\s*\d{2,}|collection|anthology/i
           .test((currentTrack?.album || '') + ' ' + (currentTrack?.artist || ''));
    // C223 : la recherche par ENREGISTREMENT part du champ MORCEAU, pas du tag
    // brut. Corriger « 03 - track » en « Malena » dans le champ suffit désormais
    // à retrouver l'année d'origine, sans rien modifier dans le fichier.
    const _trackRef = (_trkTitle && (_trkTitle !== currentTrack?.title || _trkArtist !== currentTrack?.artist))
      ? Object.assign({}, currentTrack, { title: _trkTitle, artist: _trkArtist || currentTrack?.artist })
      : currentTrack;
    const _trackResults = await _searchByTrack(_trackRef, _titleYear || _yearClue, _isCompEarly);
    for (const tr of _trackResults) allResults.push(tr);
    let allCovers = allResults.flatMap(r => r.covers || []);

    // bestMatch consolidé : on prend le 1er qui a une année Wikipedia (autorité
    // de composition), sinon le 1er qui a une année non-iTunes/non-Deezer,
    // sinon le 1er tout court. Idem genre.
    function _pickBest(field, sourcePredicate) {
      for (const r of allResults) {
        const m = r.bestMatch;
        if (m && m[field] && (!sourcePredicate || sourcePredicate(m.yearSource || m.genreSource || ''))) return m;
      }
      return null;
    }
    const _matchYear =
        _pickBest('year', s => /Wikipedia/i.test(s))
     || _pickBest('year', s => !/iTunes|Deezer/i.test(s))
     || _pickBest('year', null);
    const _matchGenre = _pickBest('genre', null);
    const _matchArtist = _pickBest('artist', null) || _pickBest('album', null);

    // Meilleur candidat PISTE (recherche par titre) : on retient le score le plus
    // haut, avec bonus si l'année colle à l'indice (désambigue les reprises) ou si
    // l'artiste colle au tag. Utilisé seulement si le titre matche vraiment (≥60).
    let _trackBest = null, _tbScore = -1;
    for (const tr of _trackResults) {
      const m = tr?.bestMatch; if (!m) continue;
      let sc = m.score || 0;
      if (_yearClue && m.year && Math.abs(parseInt(m.year) - _yearClue) <= 2) sc += 40;
      if (currentTrack?.artist && m.artist &&
          m.artist.toLowerCase().includes(currentTrack.artist.toLowerCase())) sc += 30;
      if (sc > _tbScore) { _tbScore = sc; _trackBest = m; }
    }
    if (_trackBest && _tbScore < 60) _trackBest = null;

    // CLASSIQUE : la recherche par titre renvoie un INTERPRÈTE (ex. "Richard He")
    // et une date d'enregistrement récente, pas le compositeur ni la composition.
    // On ignore donc le résultat piste pour le classique → on garde l'artiste
    // album (= le compositeur pour les tags "Compositeur - Œuvre"). Détection :
    // genre classique, ou marqueur d'œuvre (Op./K./BWV/Hob) dans titre/album.
    const _isClassical = /classical|classique|opera|orchestral/i.test((_matchGenre?.genre || '') + ' ' + (_trackBest?.genre || ''))
                      || /\b(?:op\.?\s*\d|k\.?\s*\d{2,}|bwv\s*\d|hob)/i.test((currentTrack?.title || '') + ' ' + (currentTrack?.album || ''));
    const _trackUsable = _trackBest && !_isClassical;

    // Artiste : l'album d'abord, SAUF si c'est une COMPIL non-classique → la piste
    // prime alors (vrai artiste du morceau). Signal compil fiable : /Compilations/.
    const _albArtist = _matchArtist?.artist || '';
    // Classique : l'artiste doit être le COMPOSITEUR (pas l'interprète). Déduit du
    // tag "Compositeur - Œuvre" et canonisé (Beethoven -> Ludwig van Beethoven).
    const _composer = _isClassical ? _composerFromTags(currentTrack?.album || '', currentTrack?.artist || _albArtist, currentTrack?.title || '') : null;
    const _isComp = (currentTrack?.path && /\/Compilations\//i.test(currentTrack.path))
                 || /various|compilation|soundtrack|bande originale|\bost\b|greatest hits|best of|the very best|anniversary|billboard|top\s*\d{2,}|collection|anthology|\blive\b|en concert|en vivo/i
                      .test(_albArtist + ' ' + (_matchArtist?.album || '') + ' ' + (currentTrack?.album || ''));
    // Fiabilité du tag album (présent + pas "unknown/various/..."): sert à garder
    // l'album du fichier plutôt qu'un coffret/compil matché par la recherche.
    const _albTagReliable = !!(currentTrack?.album && currentTrack.album.trim()
      && !/^\[?\s*(unknown|inconnu|untitled|sans titre|various|va)(\s+(album|artists?))?\s*\]?$/i.test(currentTrack.album.trim()));
    // Validation artiste : si l'album-match donne un artiste qui DIVERGE du tag
    // fichier alors que la recherche par titre, elle, colle au tag → on préfère la
    // recherche par titre (évite "ACDC Back" d'une requête floue quand le tag dit
    // "ACDC" et que la piste trouve bien "AC/DC").
    const _akTag = _normArtistKey(currentTrack?.artist || '');
    const _akAlb = _normArtistKey(_albArtist);
    const _akTrk = _trackUsable ? _normArtistKey(_trackBest.artist || '') : '';
    const _preferTrackArtist = !!(_akTag && _akTrk && _akTrk === _akTag && _akAlb !== _akTag);
    let _finalArtist = (_isComp && _trackUsable) ? _trackBest.artist
                       : (_composer
                          || (_preferTrackArtist ? _trackBest.artist : null)
                          || _albArtist
                          || (_trackUsable ? _trackBest.artist : null)
                          || null);
    // B1 (soundtrack) : l'artiste résolu EST le nom de l'album/soundtrack
    // (« Kill Bill, » pour « Kill Bill, Vol. 1 ») → faux. On laisse vide (revue)
    // plutôt que d'écrire un faux. Hors classique (compositeur dans l'album, géré).
    if (!_isClassical && _finalArtist) {
      const _na = String(_finalArtist).toLowerCase().replace(/[^a-z0-9]/g,'');
      // Album sans « Vol. N / Disc N / CD N / Part N » ni « (…) » final.
      const _nl = String(currentTrack?.album||'')
        .replace(/[,:\-]?\s*(vol\.?|volume|disc|cd|part|pt)\.?\s*\d+.*$/i,'')
        .replace(/\s*[\(\[][^)\]]*[\)\]]\s*$/,'')
        .toLowerCase().replace(/[^a-z0-9]/g,'');
      // On ne vide QUE si l'artiste EST tout l'album (« Kill Bill, » = « Kill Bill, Vol. 1 »).
      // Jamais un préfixe « Artiste - Album » (sinon on effaçait « The Doors »).
      if (_na.length>=4 && _nl.length>=4 && _na===_nl) _finalArtist = null;
    }

    // Année, priorité décroissante (l'année d'ORIGINE prime sur les rééditions) :
    //   Wikipedia (composition) > enregistrement (1re sortie, hors classique) > indice > album.
    const _wikiYear  = /Wikipedia/i.test(_matchYear?.yearSource || '') ? _matchYear.year : null;
    const _trackYear = (_trackUsable && _trackBest.year) ? parseInt(_trackBest.year) : null;
    let _finalYear = _wikiYear || _titleYear || _trackYear || _yearClue || (_matchYear?.year || null);
    let _finalYearSrc = _wikiYear ? _matchYear.yearSource
                        : (_titleYear ? 'année du titre'
                        : (_trackYear ? 'recherche par titre'
                        : (_yearClue ? 'indice album' : (_matchYear?.yearSource || null))));
    // ANNÉE D'ORIGINE (philosophie : original > réédition) : un remaster iTunes
    // récent (« 36 Chambers » daté 2020) ne doit pas masquer la sortie d'origine.
    // Hors autorité Wikipedia/année-du-titre, on prend la plus ANCIENNE
    // plausible parmi les années remontées par les différents matchs (les
    // requêtes sont déjà cadrées artiste/album/titre du morceau courant).
    if (!_wikiYear && !_titleYear && _finalYear) {
      const _maxY = new Date().getFullYear() + 1;
      let _oldest = parseInt(_finalYear) || null;
      for (const r of allResults) {
        const y = r && r.bestMatch && r.bestMatch.year ? parseInt(r.bestMatch.year) : null;
        if (y && y >= 1900 && y <= _maxY && (!_oldest || y < _oldest)) _oldest = y;
      }
      if (_oldest && _oldest < (parseInt(_finalYear) || Infinity)) {
        console.log('[searchCrossReference] année affinée (origine) :', _finalYear, '→', _oldest);
        _finalYear = _oldest;
        _finalYearSrc = (_finalYearSrc || 'recherche') + ' (origine)';
      }
    }

    // Best match consolidé pour la suite de la fonction
    window._lastBestMatch = {
      // Titre : version canonique du match (corrige les typos "Pretend" →
      // "Pretender"). Classique/sans match : on garde le titre fichier.
      title:  (_trackUsable && _trackBest.title) ? _trackBest.title : (currentTrack?.title || null),
      artist: _finalArtist,
      // Album : on GARDE l'album tag du fichier s'il est fiable (c'est l'album où
      // se trouve le morceau — "Back In Black", pas le coffret "Bonfire" matché par
      // la recherche par titre). Tag junk/vide → album de la recherche en repli.
      // B3 : si le tag est un BEST-OF/anthologie (pas un soundtrack), on préfère
      // l'album d'ORIGINE trouvé par la recherche par titre (philosophie original >
      // compilation). La cover suit (wantedAlbum = album résolu).
      album:  ((_albTagReliable && !/greatest hits|best of|the very best|anthology|the essential|definitive|\bcollection\b/i.test(currentTrack?.album || '')) ? currentTrack.album
               : ((_trackUsable && _trackBest.album) ? _trackBest.album : (currentTrack?.album || _matchArtist?.album || null))),
      year:   _finalYear,
      yearSource: _finalYearSrc,
      // Genre : on préfère la PISTE (spécifique à CE morceau) quand le match titre
      // est confiant — comme titre/année/cover ci-dessus. Évite qu'un album homonyme
      // (« Snatch » electronic) ou une compil impose son genre. Album en repli.
      genre:  (_trackUsable && _trackBest?.genre) ? _trackBest.genre : (_matchGenre?.genre || null),
      // Cover d'ORIGINE (recherche par titre) hors classique.
      cover:  (_trackUsable && _trackBest.cover) ? _trackBest.cover : null,
    };
    console.log('[searchCrossReference] consolidated bestMatch:', window._lastBestMatch);

    // Options PAR SOURCE pour le sélecteur par champ — MÊMES données que le
    // MEILLEUR MATCH (moteur du clic), pas un 2e fetch auto. Dédup par valeur,
    // toutes les sources distinctes conservées pour que l'user choisisse.
    (function _buildFieldOptions(){
      const agg = { year:[], genre:[], artist:[], album:[] };
      for (const r of allResults) {
        const rbf = r && r.rawByField; if (!rbf) continue;
        for (const f of ['year','genre','artist','album']) {
          for (const e of (rbf[f] || [])) {
            const val = (f === 'year') ? (e.value ? parseInt(e.value) : null) : (e.value || e.raw || null);
            if (val == null || val === '') continue;
            agg[f].push({ value: val, source: e.source || '?' });
            // Sous-genre (enfant) : si le tag brut révèle un enfant précis
            // (ex. "shoegaze" → "Indie Rock / Dream Pop / Shoegaze"), on le
            // propose AUSSI comme option pour choisir le sous-genre direct.
            if (f === 'genre' && e.raw && typeof clientMapChild === 'function') {
              const _child = clientMapChild(e.raw);
              if (_child && String(_child).toLowerCase() !== String(val).toLowerCase()) {
                agg.genre.push({ value: _child, source: (e.source || '?') + ' · sous-genre' });
              }
            }
          }
        }
      }
      const dedup = (arr) => {
        const seen = new Set(); const out = [];
        for (const o of arr) { const k = String(o.value).toLowerCase().trim(); if (!k || seen.has(k)) continue; seen.add(k); out.push(o); }
        return out;
      };
      window._lastFieldOptions = { year:dedup(agg.year), genre:dedup(agg.genre), artist:dedup(agg.artist), album:dedup(agg.album) };
    })();

    // Dedup by URL
    const coverMap = new Map();
    for (const cover of allCovers) {
      if (!cover.url || cover.url.length < 30) continue;
      if (!coverMap.has(cover.url)) {
        coverMap.set(cover.url, cover);
      }
    }
    
    let uniqueCovers = Array.from(coverMap.values()).slice(0, 8);

    // ── CONTRÔLE DE PERTINENCE ──
    // Si on connaît l'album du morceau, on rejette les covers dont l'album ne
    // correspond pas (ex : recherche « Durazno Sangrado » mais une source rend
    // « MTV Unplugged » parce que l'artiste taggé ne matche pas les bases).
    // Album cible pour la pertinence des covers : si le tag fichier est junk
    // ("[Unknown Album]"), on prend l'album RÉSOLU (MEILLEUR MATCH) — sinon les
    // covers seraient cherchées/filtrées sur "Unknown Album" (→ hors-sujet, et le
    // repli "album seul" irait re-chercher "Unknown Album").
    const _fileAlbum = currentTrack?.album || '';
    const _resolvedAlbumC = (window._lastBestMatch && window._lastBestMatch.album) || '';
    const _albJunkCover = s => { const v = String(s || '').trim(); return !v || /^\[?\s*(unknown|inconnu|untitled|sans titre|various|va)(\s+(album|artists?))?\s*\]?$/i.test(v); };
    const wantedAlbum = (_albJunkCover(_fileAlbum) && _resolvedAlbumC) ? _resolvedAlbumC : _fileAlbum;
    if (wantedAlbum) {
      // B-cover : on a un artiste résolu fiable → on EXCLUT les covers créditées à un
      // AUTRE artiste (ex. « Greatest Hits » de CREED qui matche le titre générique de
      // « The Doors - Greatest Hits »). Hors classique (cover créditée à l'orchestre).
      const _resolvedArtistC = (window._lastBestMatch && window._lastBestMatch.artist) || '';
      const _artOk = (cArtist) => {
        if (_isClassical || !_resolvedArtistC) return true;
        const ra = _normArtistKey(_resolvedArtistC), ca = _normArtistKey(cArtist || '');
        if (!ra || !ca) return true;                 // info manquante → bénéfice du doute
        return ca.includes(ra) || ra.includes(ca);
      };
      // Les covers de la recherche par TITRE (= l'album d'origine du morceau) sont
      // gardées hors classique : leur album ne matche pas la compil, mais c'est
      // justement la BONNE cover d'origine (sinon on retombe sur "aucune cover").
      // CLASSIQUE : les œuvres vivent sur des compilations au nom différent
      // (« Grieg: Holberg Suite & Peer Gynt »…) → l'album strict ne matche jamais.
      // On accepte donc aussi les covers créditées au COMPOSITEUR (album/artiste
      // contient son nom), recherchées justement avec lui → bon compositeur garanti.
      const _composerSurnameC = (_isClassical && _composer) ? String(_composer).trim().split(/\s+/).pop().toLowerCase() : '';
      const _coverMentionsComposer = (c) => _composerSurnameC &&
        (String(c.album || '').toLowerCase().includes(_composerSurnameC) ||
         String(c.artist || '').toLowerCase().includes(_composerSurnameC));
      const relevant = uniqueCovers.filter(c => ((!_isClassical && /titre/i.test(c.source || '')) || _albumMatches(wantedAlbum, c.album) || _coverMentionsComposer(c)) && _artOk(c.artist));
      // On ne garde le filtrage que s'il reste quelque chose ; sinon on tentera
      // le repli par album seul ci-dessous plutôt que d'afficher du hors-sujet.
      if (relevant.length > 0) {
        uniqueCovers = relevant;
      } else {
        // ── REPLI : recherche par ALBUM SEUL (sans l'artiste qui trompe) ──
        // L'artiste taggé (ex. Spinetta) peut ne pas matcher l'artiste crédité
        // sur les bases (ex. Invisible). On retente avec juste l'album.
        console.log('[searchCrossReference] aucune cover pertinente → repli album seul:', wantedAlbum);
        if (status) status.textContent = "NOUVELLE TENTATIVE (ALBUM SEUL)...";
       try {
          // Repli amélioré : si on a un artiste résolu fiable, on cherche AVEC lui +
          // l'album nettoyé du préfixe « Artiste - » (au lieu d'un album seul générique
          // qui ramène les best-of d'autres artistes), et on filtre par artiste.
          let _replAlbum = wantedAlbum;
          if (_resolvedArtistC) {
            const _ra = _resolvedArtistC.trim().toLowerCase(), _w = String(wantedAlbum).trim(), _wl = _w.toLowerCase();
            for (const _sep of [' - ', ' – ', ' — ', ': ', ' : ']) {
              if (_wl.startsWith(_ra + _sep.toLowerCase())) { _replAlbum = _w.slice((_ra + _sep).length).trim() || wantedAlbum; break; }
            }
          }
          const albumOnly = await unifiedSearch({ artist: _resolvedArtistC || '', album: _replAlbum });
          const albCovers = (albumOnly.covers || [])
            .filter(c => c.url && c.url.length >= 30 && _albumMatches(_replAlbum, c.album) && _artOk(c.artist));
          if (albCovers.length > 0) {
            uniqueCovers = albCovers.slice(0, 8);
          } else {
            // Option 2 : pas la pochette exacte de la compil, mais on garde TOUTE
            // pochette du BON artiste déjà dans le pool (en préférant les albums qui
            // ressemblent à une compil) — une vraie pochette Doors vaut mieux que rien.
            const _isCompAlb = a => /greatest hits|best of|the very best|anthology|the essential|definitive|\bcollection\b|compilation|\bhits\b/i.test(String(a || ''));
            const _raKey = (!_isClassical && _resolvedArtistC) ? _normArtistKey(_resolvedArtistC) : '';
            const _poolArt = _raKey ? uniqueCovers.filter(c => { const ca = _normArtistKey(c.artist || ''); return c.url && ca && (ca.includes(_raKey) || _raKey.includes(ca)); }) : [];
            _poolArt.sort((x, y) => (_isCompAlb(y.album) ? 1 : 0) - (_isCompAlb(x.album) ? 1 : 0));
            uniqueCovers = _poolArt.slice(0, 8);
            // Option 3 : toujours aucune cover → Cover Art Archive via MusicBrainz
            // (main.js, bon User-Agent). Dernier recours, recherche manuelle uniquement.
            if (!uniqueCovers.length && _replAlbum && _resolvedArtistC && window.wt && window.wt.fetchCoverArt) {
              try {
                const _caa = await window.wt.fetchCoverArt(_replAlbum, _resolvedArtistC);
                if (_caa && _caa.url) {
                  uniqueCovers = [{ url: _caa.url, album: _caa.album || _replAlbum, artist: _caa.artist || _resolvedArtistC, year: _caa.year || null, source: 'Cover Art Archive', quality: _caa.quality || 500 }];
                  console.log('[searchCrossReference] Cover Art Archive →', _caa.url);
                }
              } catch (e) { console.log('[searchCrossReference] CAA échec:', e && e.message || e); }
            }
          }

          // ── Réinjection du bestMatch du repli dans le consolidé ──────────
          // Le repli découvre souvent l'année que les queries précédentes ont
          // ratée (ex. Bona nox K.561 trouvée seulement avec album seul, sans
          // l'artiste tag bruité). On merge donc le bestMatch du repli dans
          // _lastBestMatch SI il apporte une info que le consolidé n'avait pas,
          // en PRIORISANT Wikipedia (autorité de composition).
          const _r = albumOnly?.bestMatch;
          const _existing = window._lastBestMatch || {};
          if (_r) {
            const _replyHasWikiYear = _r.year && /Wikipedia/i.test(_r.yearSource || '');
            const _existingHasWikiYear = _existing.year && /Wikipedia/i.test(_existing.yearSource || '');
            // Année : remplace si manquante OU si le repli a Wikipedia et pas l'existant.
            if (_r.year && (!_existing.year || (_replyHasWikiYear && !_existingHasWikiYear))) {
              _existing.year = _r.year;
              _existing.yearSource = _r.yearSource || null;
            }
            // Genre : remplace si manquant.
            if (_r.genre && !_existing.genre) _existing.genre = _r.genre;
            // Artist/album : remplace si manquant.
            if (_r.artist && !_existing.artist) _existing.artist = _r.artist;
            if (_r.album  && !_existing.album)  _existing.album  = _r.album;
            window._lastBestMatch = _existing;
            console.log('[searchCrossReference] consolidated bestMatch (post-repli):', window._lastBestMatch);
          }
        } catch (e) {
          console.log('[searchCrossReference] repli album seul échoué:', e);
          uniqueCovers = [];
        }
      }
    }
    
    // ── ACOUSTID FALLBACK ──
    // Trigger when no covers OR when covers came back without usable metadata.
    const _hasUsableMeta = uniqueCovers.some(c => c.year || c.genre);
    if (uniqueCovers.length === 0 || !_hasUsableMeta) {
      let acoustidMatch = null;
      console.log('[searchCrossReference] AcoustID gate:', {
        hasTrack: !!currentTrack,
        hasPath: !!currentTrack?.path,
        hasFP: !!window.wt?.fingerprintFile,
        hasAvail: !!window.wt?.acoustidAvailable
      });
      // AcoustID disabled (no client key) — skip the fingerprint UX entirely.
      // Re-enable when community-share path is live or AcoustID key is registered.
      const ACOUSTID_ENABLED = false;
      if (ACOUSTID_ENABLED && currentTrack && currentTrack.path && window.wt?.fingerprintFile && window.wt?.acoustidAvailable) {
        const acoustidOk = await window.wt.acoustidAvailable();
        console.log('[searchCrossReference] AcoustID available:', acoustidOk);
        if (acoustidOk) {
          if (status) status.textContent = "EMPREINTE AUDIO EN COURS...";
          if (container) {
            container.innerHTML = '<div style="padding:12px; text-align:center; color:var(--t3)">🎵 Analyse de l\'empreinte audio…</div>';
          }
          try {
            const fp = await window.wt.fingerprintFile(currentTrack.path);
            if (fp && fp.fingerprint && fp.duration) {
              const ac = await acoustidLookup(fp.fingerprint, fp.duration);
              if (ac && (ac.artist || ac.album)) {
                console.log('[acoustid renderer] match:', ac);
                acoustidMatch = ac;
                if (status) status.textContent = "RECHERCHE AVEC EMPREINTE...";
                const acResults = await unifiedSearch({ artist: ac.artist || '', album: ac.album || ac.title || '' });
                const acCovers = (acResults.covers || []).slice(0, 8);
                if (acCovers.length > 0) {
                  const enriched = acCovers.map(c => ({
                    url:    c.url,
                    source: (c.source || 'Cover') + ' · empreinte',
                    artist: c.artist || ac.artist,
                    album:  c.album  || ac.album,
                    year:   c.year   || ac.year,
                    genre:  c.genre  || null
                  }));
                  enriched.forEach(c => uniqueCovers.push(c));
                }
              }
            }
          } catch (e) {
            console.log('[acoustid renderer] error:', e);
          }
        }
      }
      // AcoustID gave metadata but no covers → show clickable best-match panel
      if (uniqueCovers.length === 0 && acoustidMatch) {
        const ac = acoustidMatch;
        if (status) status.textContent = "EMPREINTE: " + (ac.artist || '?');
        if (container) {
          _omniResMode(container, 'column'); // panneau pleine largeur, pas la bande
          const safeArtist = (ac.artist || '?').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
          const safeAlbum  = (ac.album || ac.title || '?').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
          container.innerHTML = '<div id="acFpMatch" style="padding:12px; background:rgba(200,90,69,0.08); border-radius:8px; cursor:pointer; width:100%;">' +
            '<div style="font-size:9px; color:var(--acc); font-weight:600; margin-bottom:4px;">🎵 IDENTIFIÉ PAR EMPREINTE (cliquer pour appliquer)</div>' +
            '<div style="font-size:10px; color:var(--t1);">' + safeArtist + ' — ' + safeAlbum + '</div>' +
            (ac.year ? '<div style="font-size:9px; color:var(--t3);">📅 ' + ac.year + '</div>' : '') +
            '</div>';
          const matchEl = document.getElementById('acFpMatch');
          if (matchEl) {
            matchEl.addEventListener('click', () => {
              window.applyCoverWithDetails('', ac.album || ac.title, ac.artist, ac.year, null);
            });
          }
        }
        if (btn) { btn.classList.remove('searching'); if (btnText) btnText.textContent = 'Rechercher'; }
        return;
      }
     // Still nothing — true dead end pour les COVERS, mais on peut quand même
      // avoir une année / genre / artiste consolidés (via Wikipedia notamment,
      // ex. Bona nox K.561 → 1788 sans cover trouvée). On affiche un panneau
      // MEILLEUR MATCH allégé pour appliquer ces métadonnées au morceau.
      if (uniqueCovers.length === 0) {
  const _m = window._lastBestMatch || {};
  const _hasMeta = !!(_m.year || _m.genre || _m.artist || _m.album);
  if (status) status.textContent = _hasMeta ? "AUCUNE POCHETTE — MÉTADONNÉES DISPONIBLES" : "AUCUNE POCHETTE FIABLE";
  if (container) {
    container.innerHTML = '';
    _omniResMode(container, 'column'); // panneaux empilés, pas la bande horizontale
    // Message d'info pochette
    const _info = document.createElement('div');
    _info.style.cssText = 'padding:12px; text-align:center; color:var(--t3); line-height:1.5;';
    _info.innerHTML = 'Aucune pochette fiable trouvée pour cet album.<br><span style="font-size:11px;">Utilisez le bouton « Mon image » ci-dessous pour en ajouter une.</span>';
    container.appendChild(_info);

    // Panneau MEILLEUR MATCH allégé
    if (_hasMeta) {
      const bestDiv = document.createElement('div');
      bestDiv.style.cssText = 'margin-top:12px; padding:8px; background:rgba(200,90,69,0.1); border-radius:8px; width:100%; cursor:pointer;';
      const _ys = _m.yearSource || '';
      const _yearTooltip = _ys ? ` title="Source : ${_ys}"` : '';
      bestDiv.innerHTML = `
        <div style="font-size:9px; color:var(--acc); font-weight:600; margin-bottom:4px;">✓ MEILLEUR MATCH — métadonnées seulement (cliquer pour appliquer)</div>
        <div style="font-size:11px; color:var(--t1); font-weight:600;">${(_m.artist || '?')} — ${_displayAlbum(_m.album) || '?'}</div>
        <div style="display:flex; gap:14px; flex-wrap:wrap; margin-top:5px; align-items:center;">
          <span${_yearTooltip} style="display:flex; align-items:center; gap:5px; font-size:10px; color:var(--t2);">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
            ${_m.year || '—'}
          </span>
          <span style="display:flex; align-items:center; gap:5px; font-size:10px; color:var(--t2);">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
            ${_m.genre || '—'}
          </span>
        </div>
      `;
      bestDiv.addEventListener('click', () => {
        window.applyCoverWithDetails(null, _m.album, _m.artist, _m.year, _m.genre, false, _m.title);
      });
      container.appendChild(bestDiv);
    }
  }
  if (btn) {
    btn.classList.remove('searching');
    if (btnText) btnText.textContent = 'Rechercher';
  }
  // Tracklist de l'album : titres proposés (clic = remplit, ou tout l'album par ordre)
  try { if (_hasMeta) _renderAlbumTracklist(_m.artist, _m.album, container); } catch (_) {}
  // ✅ AJOUT : générer les chips même sans pochette
  if (typeof _runConsolidatedPickers === 'function' && _omniSpecificRef) {
    setTimeout(() => {
      _runConsolidatedPickers(_omniSpecificRef).catch(e => console.warn('[searchCrossReference] pickers error:', e));
    }, 200);
  }
  return;
}
      // Else fall through to display the AcoustID-augmented covers
    }
    
    if (status) status.textContent = `${uniqueCovers.length} POCHETTE${uniqueCovers.length > 1 ? 'S' : ''}`;
    
    // Reclasse : la cover qui matche l'album RÉSOLU (MEILLEUR MATCH) passe en
    // tête — c'est elle qu'applique le panneau MEILLEUR MATCH (uniqueCovers[0]).
    {
      const _ra = (window._lastBestMatch && window._lastBestMatch.album) || '';
      if (_ra && uniqueCovers.length > 1 && typeof _albumMatches === 'function') {
        uniqueCovers = uniqueCovers.slice().sort((a, b) =>
          (_albumMatches(_ra, b.album) ? 1 : 0) - (_albumMatches(_ra, a.album) ? 1 : 0));
      }
    }
    // Display covers grid
    _omniResMode(container, 'row'); // restaure la bande si une recherche précédente a laissé le mode colonne
    container.innerHTML = uniqueCovers.map((item, idx) => `
      <div class="omni-cover-result" data-idx="${idx}" style="flex:0 0 90px; cursor:pointer; text-align:center; margin:4px;">
        <img src="${item.url}" style="width:80px; height:80px; border-radius:6px; object-fit:cover; background:#1E1E1B;" 
          onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Crect width=%22100%22 height=%22100%22 fill=%22%23333%22/%3E%3Ctext x=%2250%22 y=%2255%22 text-anchor=%22middle%22 fill=%22%23777%22%3E?%3C/text%3E%3C/svg%3E'">
        <div style="font-size:7px; margin-top:4px; color:var(--t3); max-width:80px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${item.source || 'Cover'}</div>
      </div>
    `).join('');
    container.querySelectorAll('.omni-cover-result').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.idx, 10);
        const item = uniqueCovers[idx];
        if (item) {
          // coverOnly = true : on n'applique QUE l'image. L'année/genre/artiste
          // viennent du « meilleur match » fiable, pas de la vignette (réédition).
          window.applyCoverWithDetails(item.url, null, null, null, null, true);
        }
      });
    });
    
    container.style.flexWrap = 'wrap';
    container.style.gap = '6px';
    container.style.justifyContent = 'flex-start';
    
   // Best-match panel (cliquable). Fusion : la cover #0 fournit l'URL et un
    // fallback artist/album, mais l'année + genre + source viennent du bestMatch
    // CONSOLIDÉ (calculé plus haut depuis tous les unifiedSearch). C'est lui qui
    // porte la connaissance "année de composition" via Wikipedia.
    if (uniqueCovers.length > 0) {
      const _consolidated = window._lastBestMatch || {};
      const _cover0 = uniqueCovers[0];
      const best = {
        url:    _cover0.url,
        title:  _consolidated.title  || null,
        artist: _consolidated.artist || _cover0.artist || null,
        album:  _consolidated.album  || _cover0.album  || null,
        year:   _consolidated.year   || _cover0.year   || null,
        yearSource: _consolidated.yearSource || null,
        genre:  _consolidated.genre  || _cover0.genre  || null,
      };
      const bestDiv = document.createElement('div');
      bestDiv.style.cssText = 'margin-top:12px; padding:8px; background:rgba(200,90,69,0.1); border-radius:8px; width:100%; cursor:pointer;';
      bestDiv.innerHTML = `
        <div style="font-size:9px; color:var(--acc); font-weight:600; margin-bottom:4px;">✓ MEILLEUR MATCH (cliquer pour tout appliquer)</div>
        <div style="font-size:11px; color:var(--t1); font-weight:600;">${(best.artist || '?')} — ${_displayAlbum(best.album) || '?'}</div>
        <div style="display:flex; gap:14px; flex-wrap:wrap; margin-top:5px; align-items:center;">
         <span${best.yearSource ? ' title="Source : ' + best.yearSource + '"' : ''} style="display:flex; align-items:center; gap:5px; font-size:10px; color:var(--t2);">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
            ${best.year || '—'}
          </span>
          <span style="display:flex; align-items:center; gap:5px; font-size:10px; color:var(--t2);">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
            ${best.genre || '—'}
          </span>
        </div>
      `;
      bestDiv.addEventListener('click', () => {
        window.applyCoverWithDetails(best.url, best.album, best.artist, best.year, best.genre, false, best.title);
      });
      container.appendChild(bestDiv);
      // Bouton « revenir » : restaure les valeurs d'origine du morceau.
      const revertDiv = document.createElement('div');
      revertDiv.style.cssText = 'margin-top:6px; text-align:right; width:100%;';
      revertDiv.innerHTML = '<button class="batch-btn" style="font-size:10px; display:inline-flex; align-items:center; gap:5px;">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>' +
        'Revenir à l\'origine</button>';
      revertDiv.querySelector('button').addEventListener('click', (e) => {
        e.stopPropagation();
        if(typeof restoreOmniOriginal === 'function') restoreOmniOriginal();
      });
      container.appendChild(revertDiv);
      try { _renderAlbumTracklist(best.artist, best.album, container); } catch (_) {}
    }
    
    if (btn) {
      btn.classList.remove('searching');
      btn.classList.add('success');
      if (btnText) btnText.textContent = '✓ OK';
      setTimeout(() => {
        btn.classList.remove('success');
        if (btnText) btnText.textContent = 'Rechercher';
      }, 1500);
    }

            // Forcer le rafraîchissement des chips après la recherche
    if (typeof _runConsolidatedPickers === 'function' && _omniSpecificRef) {
      setTimeout(() => {
        _runConsolidatedPickers(_omniSpecificRef).catch(e => console.warn('[searchCrossReference] pickers error:', e));
      }, 200);
    }
    } catch (err) {
    console.error('[searchCrossReference]', err);
    if (status) status.textContent = "ERREUR: " + err.message;
    if (btn) {
      btn.classList.remove('searching');
      btn.classList.add('error');
      if (btnText) btnText.textContent = 'Échec';
      setTimeout(() => {
        btn.classList.remove('error');
        if (btnText) btnText.textContent = 'Rechercher';
      }, 1500);
    }
  }
}

// Fonction pour appliquer uniquement la cover (sans modifier les autres champs)
window.applyCoverOnly = function(coverUrl) {
  if (coverUrl && coverUrl.length > 20) {
    if (typeof _omniPendingCoverUrl !== 'undefined') {
      _omniPendingCoverUrl = coverUrl;
    }
    if (typeof updateOmniPreview === 'function') {
      updateOmniPreview(coverUrl);
    }
    toast('✓ Pochette sélectionnée');
  }
};

window.runUnifiedSearch = async function() {
  const query = document.getElementById('omniSearchIn')?.value.trim();
  if (!query) {
    toast('Entrez un artiste ou un album');
    return;
  }
  
  const btn = document.getElementById('identifyBtn');
  const container = document.getElementById('omniResults');
  const status = document.getElementById('omniStatus');
  
  if (btn) btn.classList.add('searching');
  if (status) status.textContent = "RECHERCHE 7 SOURCES...";
  if (container) {
    container.innerHTML = '<div style="padding:12px; text-align:center; color:var(--t3)">🔍 Recherche sur Deezer, iTunes, MusicBrainz, Last.fm, Archive.org, CoverArt, Discogs...</div>';
    container.style.display = 'flex';
  }
  
  try {
    const results = await unifiedSearch(query);
    
    if (!results.covers || results.covers.length === 0) {
      if (status) status.textContent = "AUCUN RÉSULTAT";
      if (container) container.innerHTML = '<div style="padding:12px; text-align:center; color:var(--t3)">Aucune pochette trouvée</div>';
      return;
    }
    
    if (status) status.textContent = `${results.covers.length} POCHETTES (7 sources)`;
    
    // Afficher maximum 8 résultats — handlers propres via data-idx (évite
    // les bugs d'échappement de chaînes dans les onclick inline)
    const visibleCovers = results.covers.slice(0, 8);
    container.innerHTML = visibleCovers.map((item, idx) => `
      <div class="omni-cover-result" data-idx="${idx}" style="flex:0 0 90px; cursor:pointer; text-align:center; margin:4px;">
        <img src="${item.url}" style="width:80px; height:80px; border-radius:6px; object-fit:cover; background:#1E1E1B;" 
          onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Crect width=%22100%22 height=%22100%22 fill=%22%23333%22/%3E%3Ctext x=%2250%22 y=%2255%22 text-anchor=%22middle%22 fill=%22%23777%22%3E?%3C/text%3E%3C/svg%3E'">
        <div style="font-size:7px; margin-top:4px; color:var(--t3); max-width:80px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${item.source}</div>
      </div>
    `).join('');
    container.querySelectorAll('.omni-cover-result').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.idx, 10);
        const item = visibleCovers[idx];
        if (item) {
          // coverOnly = true : la vignette ne change que l'image, pas l'année/genre.
          window.applyCoverWithDetails(item.url, null, null, null, null, true);
        }
      });
    });
    
    // Afficher le meilleur match
    if (results.bestMatch.artist || results.bestMatch.album) {
      const infoHtml = `
        <div style="margin-top:12px; padding:8px; background:rgba(200,90,69,0.1); border-radius:8px; width:100%;">
          <div style="font-size:9px; color:var(--acc); font-weight:600; margin-bottom:4px;">✓ MEILLEUR MATCH</div>
          <div style="font-size:10px; color:var(--t1);">${results.bestMatch.artist || '?'} - ${_displayAlbum(results.bestMatch.album) || '?'}</div>
          ${results.bestMatch.year ? `<div style="font-size:9px; color:var(--t3);">📅 ${results.bestMatch.year} (${results.bestMatch.yearSource || 'source'})</div>` : ''}
          ${results.bestMatch.genre ? `<div style="font-size:9px; color:var(--t3);">🎵 Genre: ${results.bestMatch.genre}</div>` : ''}
        </div>
      `;
      container.innerHTML += infoHtml;
    }
    
  } catch (err) {
    console.error('[runUnifiedSearch]', err);
    if (status) status.textContent = "ERREUR: " + err.message;
  } finally {
    if (btn) {
      btn.classList.remove('searching');
      btn.classList.add('success');
      setTimeout(() => btn.classList.remove('success'), 1500);
    }
  }
};

// ── Cover perso : fichier local (redimensionné) ou URL collée ──
// On pose dans _omniPendingCoverUrl + preview, exactement comme une vignette.
// Le circuit de sauvegarde existant (validation de la fenêtre) fait le reste.
function omniApplyCoverUrl(url){
  url = (url || '').trim();
  if(!url){ return; }
  if(!/^https?:\/\//i.test(url) && !url.startsWith('data:image')){
    toast('URL d\'image invalide'); return;
  }
  window.applyCoverWithDetails(url, null, null, null, null, true);
}
function omniLoadLocalCover(file){
  if(!file){ return; }
  if(!file.type.startsWith('image/')){ toast('Ce n\'est pas une image'); return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      // Redimensionne à 600px max pour limiter le poids stocké dans prefs.json
      const MAX = 600;
      let { width, height } = img;
      if(width > MAX || height > MAX){
        const r = Math.min(MAX / width, MAX / height);
        width = Math.round(width * r); height = Math.round(height * r);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      window.applyCoverWithDetails(dataUrl, null, null, null, null, true);
      toast('✓ Image chargée');
    };
    img.onerror = () => toast('Image illisible');
    img.src = e.target.result;
  };
  reader.onerror = () => toast('Lecture du fichier échouée');
  reader.readAsDataURL(file);
}

// 2nd applyCoverWithDetails below was overriding the 1st one silently — and
// was inferior (lost the toast and the omniStyle fallback). Renamed to
// neutralize without touching surrounding code, so the 1st version (above
// in this file) remains active.
window._applyCoverWithDetails_unused_v2 = function(coverUrl, albumName, artistName, year, genre) {
  console.log('[applyCoverWithDetails]', { coverUrl, albumName, artistName, year, genre });
  
  // 1. Appliquer la cover
  if (coverUrl && coverUrl.length > 20) {
    if (typeof _omniPendingCoverUrl !== 'undefined') {
      _omniPendingCoverUrl = coverUrl;
    }
    if (typeof updateOmniPreview === 'function') {
      updateOmniPreview(coverUrl);
    }
    
    // Mettre à jour le player
    const pArt = document.getElementById('pArt');
    if (pArt) {
      pArt.innerHTML = `<img src="${coverUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:8px">`;
    }
    
    toast('✓ Cover appliquée');
  }
  
  // 2. Appliquer l'album
  if (albumName && document.getElementById('omniAlbum')) {
    document.getElementById('omniAlbum').value = albumName;
  }
  
  // 3. Appliquer l'artiste
  if (artistName && document.getElementById('omniArtist')) {
    document.getElementById('omniArtist').value = artistName;
  }
  
  // 4. Appliquer l'année
  if (year && document.getElementById('omniYear')) {
    document.getElementById('omniYear').value = year;
  }
  
  // 5. Appliquer le genre
  if (genre && document.getElementById('omniGenre')) {
    const genreSelect = document.getElementById('omniGenre');
    for (let i = 0; i < genreSelect.options.length; i++) {
      if (genreSelect.options[i].value === _genreToSelectOption(genre)) {
        genreSelect.selectedIndex = i;
        break;
      }
    }
  }
};

// ============================================================
// IDENTIFICATION DEPUIS LE FICHIER AUDIO (SHAZAM SANS MICRO)
// ============================================================



// Keep ONLY this version - delete the other two!

// Combined search that returns both cover and correct year
async function searchCompleteMetadata(query) {
  const results = {
    covers: [],
    year: null,
    yearSource: null,
    artist: null,
    album: null
  };
  
  try {
    // Search for covers
    const deezerResults = await directDeezerCoverSearch(query);
    const itunesResults = await directItunesCoverSearch(query);
    results.covers = [...deezerResults, ...itunesResults];
    
    // Extract artist and album from query
    let artist = '';
    let album = query;
    if (query.includes(' - ')) {
      const parts = query.split(' - ');
      artist = parts[0].trim();
      album = parts[1].trim();
    } else {
      const words = query.split(' ');
      if (words.length > 2) {
        artist = words.slice(0, -2).join(' ');
        album = words.slice(-2).join(' ');
      }
    }
    
    // Get original year from MusicBrainz
    if (artist && album) {
      const mbResult = await musicBrainzOriginalYearSearch(artist, album);
      if (mbResult && mbResult.year) {
        results.year = mbResult.year;
        results.yearSource = 'MusicBrainz (original)';
        results.artist = mbResult.artist || artist;
        results.album = mbResult.album || album;
      }
    }
    
    // If MusicBrainz didn't find year, try to get from cover results (prefer non-reissue)
    if (!results.year && results.covers.length > 0) {
      const nonReissue = results.covers.find(r => !r.isReissue && r.year);
      if (nonReissue && nonReissue.year) {
        results.year = nonReissue.year;
        results.yearSource = nonReissue.source;
      } else if (results.covers[0] && results.covers[0].year) {
        results.year = results.covers[0].year;
        results.yearSource = results.covers[0].source + ' (réédition)';
      }
    }
    
    return results;
  } catch (err) {
    console.error('[searchCompleteMetadata]', err);
    return results;
  }
}
// Identifier et appliquer au morceau courant
async function identifyCurrentTrackFromEditor() {
  const t = queue[qi];
  if (!t) {
    toast('Aucun morceau en cours');
    return;
  }
  
  const btn = document.getElementById('identifyBtn');
  const btnText = document.getElementById('identifyBtnText');
  
  if (btn) {
    btn.classList.add('searching');
    btn.classList.remove('success', 'error');
    if (btnText) btnText.textContent = 'Recherche...';
  }
  toast('🔍 Recherche...');
  
  try {
    // Build search query from current track
    let searchQuery = '';
    
    if (t.artist && t.artist !== 'Artiste inconnu' && t.album && t.album !== 'Album inconnu') {
      searchQuery = `${t.artist} ${t.album}`;
    } else if (t.artist && t.title) {
      searchQuery = `${t.artist} ${t.title}`;
    } else {
      const fileName = t.path.split(/[/\\]/).pop() || '';
      searchQuery = fileName.replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' ');
    }
    
    if (!searchQuery || searchQuery.length < 3) {
      throw new Error('Nom de fichier trop court');
    }
    
    // ✅ ONLY set the search field, do NOT auto-fill the other fields
    const searchInput = document.getElementById('omniSearchIn');
    if (searchInput) {
      searchInput.value = searchQuery;
    }
    
    // ✅ Run the cover search automatically
    if (typeof window.runOmniSearch === 'function') {
      await window.runOmniSearch();
    }
    
    if (btn) {
      btn.classList.remove('searching');
      btn.classList.add('success');
      if (btnText) btnText.textContent = '✓ OK';
    }
    
    toast(`✓ Recherche lancée pour: ${searchQuery}`);
    
    setTimeout(() => {
      if (btn) {
        btn.classList.remove('success');
        if (btnText) btnText.textContent = 'Identifier le morceau';
      }
    }, 1500);
    
  } catch (err) {
    console.error('[identifyCurrentTrackFromEditor]', err);
    if (btn) {
      btn.classList.remove('searching');
      btn.classList.add('error');
      if (btnText) btnText.textContent = 'Échec';
    }
    toast(`❌ ${err.message}`);
    
    setTimeout(() => {
      if (btn) {
        btn.classList.remove('error');
        if (btnText) btnText.textContent = 'Identifier le morceau';
      }
    }, 1500);
  }
}

// Identifier depuis le contexte menu (sur un morceau sélectionné)
// NOTE : Cette fonction n'a aucun call site et appelle `identifyTrackFromFile`
// qui n'est défini nulle part. Renommée pour éviter la confusion.
async function _identifySelectedTrack_unused() {
  const selectedTracks = allTracks.filter(t => selectedPaths.has(t.path));
  if (selectedTracks.length !== 1) {
    toast('Sélectionne un seul morceau');
    return;
  }
  
  const t = selectedTracks[0];
  toast('🔍 Identification en cours...');
  
  const url = pathToUrl(t.path);
  const result = await identifyTrackFromFile(url, t.path);
  
  if (!result || !result.success) {
    toast(`❌ ${result?.error || 'Non identifié'}`);
    return;
  }
  
  // Appliquer (même code que ci-dessus)
  if (result.title) t.title = result.title;
  if (result.artist) t.artist = result.artist;
  if (result.album) t.album = result.album;
  if (result.year) t.year = parseInt(result.year);
 if (result.genre) {
    const mapped = typeof clientMapGenre === 'function' ? clientMapGenre(result.genre) : result.genre;
    if (mapped) t.genre = mapped;
    if (!t.genreChild && typeof clientMapChild === 'function') {
      const child = clientMapChild(result.genre);
      if (child) t.genreChild = child;
    }
  }
  if (result.cover && typeof customCovers !== 'undefined') {
    customCovers[t.path] = result.cover;
  }
  t._userModified = true;
  _clearUnidentifiedIfComplete(t);

  // Patch B : propage la modif vers le mobile si le morceau y est déjà
  schedulePropagateTrackUpdate(t);
  
  // Mettre à jour queue
  const qIdx = queue.findIndex(q => q.path === t.path);
  if (qIdx >= 0) Object.assign(queue[qIdx], t);
  
  renderVirtual();
  scheduleMetaSave();
  scheduleSave();
  
  toast(`✓ "${result.title}" - Métadonnées mises à jour`);
}
// Recompute the pill state — reflects current count of _unidentified tracks.
// Animates the number rolling when the count drops.
let _lastEnrichCount = null;
function refreshEnrichPill(){
  const n = (Array.isArray(allTracks) ? allTracks.filter(t => t._unidentified).length : 0);
  const span = document.getElementById('enrichStatus');
  const pill = document.getElementById('enrichPill');
  if(!span || !pill){
    _lastEnrichCount = n;
    return;
  }
  // Update has-unidentified class via enrichSetStatus, BUT pass null text
  // so we don't overwrite the span content (we control the text here directly).
  pill.classList.remove('running','done','has-unidentified');
  if(n > 0) pill.classList.add('has-unidentified');

  const prev = _lastEnrichCount;
  _lastEnrichCount = n;

 // First-time setup or no baseline: paint without animation
  if(prev === null || prev === n){
    span.textContent = n > 0 ? `${n} à compléter` : 'Compléter les infos';
    return;
  }
  // Count went up (new harmonisation just ran on a bigger set): set without animation
  if(n > prev){
    span.textContent = n > 0 ? `${n} à compléter` : 'Compléter les infos';
    return;
  }
  // Count went down: ANIMATE
  if(n > 0){
    span.innerHTML = `<span class="enrich-num"><span class="num-old">${prev}</span><span class="num-new">${n}</span></span> à compléter`;
    const numWrap = span.querySelector('.enrich-num');
    if(numWrap){
      void numWrap.offsetWidth; // force reflow
      numWrap.classList.add('rolling');
      pill.classList.add('count-dropped');
      setTimeout(() => {
        span.textContent = `${n} à compléter`;
        pill.classList.remove('count-dropped');
      }, 360);
    } else {
      span.textContent = `${n} à compléter`;
    }
  } else {
    // n === 0 — collection complete!
    span.textContent = 'Collection complète ✓';
    pill.classList.add('count-dropped');
    setTimeout(() => pill.classList.remove('count-dropped'), 600);
  }
}


// ============================================================
// APPLICATION DES RÉSULTATS POUR L'ÉDITEUR OMNITOOL
// ============================================================
// Make sure this is globally accessible (no 'function' keyword inside another function)
window.applyCoverFromSearch = function(coverUrl, year, album) {
  if (coverUrl) {
    _omniPendingCoverUrl = coverUrl;
    
    // Call updateOmniPreview if it exists
    if (typeof updateOmniPreview === 'function') {
      updateOmniPreview(coverUrl);
    } else {
      // Fallback: update the background directly
      const box = document.querySelector('.batch-box');
      if (box) {
        box.style.setProperty('--omni-bg', `url('${coverUrl}')`);
      }
    }
    
    // Update fullscreen immediately if active
    if (typeof _fsActive !== 'undefined' && _fsActive) {
      const fsArt = document.getElementById('fsArtImg');
      if (fsArt) {
        fsArt.style.backgroundImage = `url("${coverUrl.replace(/"/g, '\\"')}")`;
        fsArt.classList.remove('no-art');
      }
    }
    
    toast('✓ Pochette sélectionnée');
  }
  
  // Update year if valid
  if (year && document.getElementById('omniYear')) {
    const currentYear = new Date().getFullYear();
    const yearNum = parseInt(year);
    
   if (yearNum >= 1400 && yearNum <= currentYear) {
      document.getElementById('omniYear').value = year;
      toast(`✓ Année mise à jour: ${year}`);
    } else if (yearNum < 1400) {
      console.warn('[applyCoverFromSearch] Year too old:', year);
    } else if (yearNum > currentYear) {
      console.warn('[applyCoverFromSearch] Year in future:', year);
    }
  }
  
  // Update album if provided
  if (album && document.getElementById('omniAlbum')) {
    document.getElementById('omniAlbum').value = album;
  }
};

// Also make sure updateOmniPreview is defined (if not already)
function updateOmniPreview(url) {
  const box = document.querySelector('.batch-box');
  if (box) {
    if (url && url.length > 20 && !url.includes('blob:')) {
      box.style.setProperty('--omni-bg', `url('${url}')`);
    } else {
      box.style.setProperty('--omni-bg', 'none');
    }
  }
  
  // Mettre à jour la preview dans l'éditeur
  const preview = document.getElementById('omniCoverPreview');
  if (preview) {
    if (url && url.length > 20) {
      preview.innerHTML = `<img src="${url}" style="width:100%; height:100%; object-fit:cover;">`;
    } else {
      preview.innerHTML = '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--t3);font-size:12px;">♪</div>';
    }
  }
}

// ============================================================
// APPLICATION POUR L'ANCIEN MODAL
// ============================================================

function applyCoverToLegacy(coverUrl) {
  if (coverEditTrack) {
    customCovers[coverEditTrack.path] = coverUrl;
    document.getElementById('cebPreview').innerHTML = `<img src="${coverUrl}" style="width:100%;height:100%;object-fit:contain">`;
    updateArtDisplay(coverUrl);
    toast('✓ Pochette mise à jour');
    // Patch B : propage la nouvelle cover vers le mobile si le morceau y est déjà
    schedulePropagateTrackUpdate(coverEditTrack);
  }
}


// ============================================================
// FONCTIONS DE BASE (déjà existantes, à garder)
// ============================================================




// Token gratuit à obtenir sur https://www.discogs.com/settings/developers
const DISCOGS_TOKEN = ''; // Laisse vide si pas de token, la source sera ignorée



let _lastSelectedIndex = -1; // Mémorise le dernier morceau cliqué
let playbackHistory = []; // Stocke les index des morceaux déjà joués
const ITEM_H = 44, PAGE = 55;
let _autoGenreRunning=false;
let allTracks=[], filtered=[], allLists=[];
let queue=[], qi=0;
let shuffle=false, repeat='none';
function updateShuffleBtn(){
  const btn=document.getElementById('pcSh');
  if(btn) btn.classList.toggle('on',shuffle);
}
let vol=0.8, muted=false, prevVol=0.8, seekDrag=false;
let nowPath=null, curPl=-1;
let plAvail=[], plSel=new Set();
let syncSel=new Set();
let syncDragging=false, syncDragMode=true, lastSyncClickTime=0;
let syncMode='wifi';
let myIP='', myPort=3000;
// Sort state
let sortCol='num', sortAsc=true;
// Context menu state
let ctxPlIdx=-1;
// Smart rules
let smartRules=[];
let editingSmartIdx=-1;
const au=document.getElementById('au');

// ── BOOT ──────────────────────────────────────────
// ============================================================
// CONFIGURATION DES SOURCES
// ============================================================
const COVER_QUALITY = {
  MIN_WIDTH: 600,      // Taille minimale 600x600
  MAX_RESULTS: 8,      // Max de résultats par recherche
  PRIORITY: ['Deezer XL', 'iTunes 600', 'Cover Art Archive', 'MusicBrainz', 'Discogs']
};

// Cache dédié aux recherches HD
if (!window.hdCoverCache) window.hdCoverCache = new Map();

// Cache pour les métadonnées multi-sources
const _multiMetaCache = new Map();

// Normalisation pour dédoublonnage
function normalizeString(str) {
  if (!str) return '';
  return str.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\[\(].*?[\]\)]/g, '')
    .replace(/\b(deluxe|remaster|edition|version|vol\.?\s*\d+|disc\s*\d+|disk\s*\d+)\b/gi, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Messages animés pendant le chargement
const loadingMsgs=['Recherche de ta bibliothèque…','Scan des fichiers audio…','Lecture des playlists iTunes…','Presque prêt…'];
let _loadMsgIdx=0, _loadMsgIv=null;
function startLoadingMessages(){
  _loadMsgIv=setInterval(()=>{
    _loadMsgIdx=(_loadMsgIdx+1)%loadingMsgs.length;
    const el=document.getElementById('loadingMsg');
    if(el) el.textContent=loadingMsgs[_loadMsgIdx];
  },1800);
}
function stopLoadingMessages(){
  clearInterval(_loadMsgIv);
  document.getElementById('wprog-auto').style.display='none';
}
startLoadingMessages();

// ── PERSISTENCE ────────────────────────────────────
let _saveTimer = null;
function scheduleSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    if (!window.wt?.saveCustomLists) return;
    
    // On utilise requestIdleCallback si disponible (méthode diplomate pour ne pas déranger le CPU)
    const performSave = () => {
      window.wt.saveCustomLists(allLists, customCovers).catch(() => {});
      // Patch E : à chaque save, on propage les modifs des playlists
      // marquées comme synced (_sync=true) vers Firestore.
      if (typeof _syncPropagateAllSyncedPlaylists === 'function') {
        _syncPropagateAllSyncedPlaylists();
      }
    };

    if (window.requestIdleCallback) {
      window.requestIdleCallback(performSave);
    } else {
      performSave();
    }
  }, 5000); 
}

async function restoreFavoritesFromStorage() {
  if (!window.wt?.getTrackFavorites) return;
  try {
    const favs = await window.wt.getTrackFavorites();
    if (favs) {
      for (const [path, isFav] of Object.entries(favs)) {
        const track = allTracks.find(t => t.path === path);
        if (track) track.isFavorite = isFav;
      }
      console.log('[restoreFavorites]', Object.keys(favs).length, 'favoris restaurés');
    }
  } catch (e) {
    console.warn('[restoreFavorites]', e);
  }
}

// ── BOOT — pull pattern, no race condition ──────────
async function bootLoad(){
  try {
    const d = await window.wt.getLibrary();
    if(d && (d.tracks?.length > 0 || d.lists?.length > 0)){
      allTracks=d.tracks||[]; filtered=[...allTracks]; allLists=d.lists||[];
      // Si le listener Firestore a reçu la syncQueue avant la fin du scan
      // (course au démarrage), on reconstruit maintenant qu'allTracks est prêt.
      if (!window._syncSelReconstructed && window._pendingSyncIds && window._pendingSyncIds.size > 0
          && typeof _reconstructSyncSelFromIds === 'function') {
        _reconstructSyncSelFromIds(window._pendingSyncIds);
      }
      // Patch N.3 : si une ancienne playlist "Favoris" non-system a été
      // persistée par erreur (avant cette migration), on la dégage : la
      // version system sera rebuild par _injectOrRebuildFavoritesList().
      allLists = allLists.filter(l => !(l && l.name === FAVORITES_LIST_NAME && !l.system));
      // Mode iTunes-only: utiliser les morceaux des playlists si allTracks est vide
      if(allTracks.length===0 && allLists.length>0){
        const seen=new Set();
        allLists.forEach(l=>(l.tracks||[]).forEach(t=>{if(!seen.has(t.path)){seen.add(t.path);allTracks.push(t);}}));
        filtered=[...allTracks];
      }
      // Patch N.3 : injecte la smart playlist Favoris (calculée à partir
      // de t.isFavorite). Pas persistée — rebuild à chaque toggle favori.
      _injectOrRebuildFavoritesList();
      // Restore persisted custom covers
      if(d.customCovers) Object.assign(customCovers, d.customCovers);
      // Restore persisted negative cover cache (échecs de fetch)
      if(d.noCover && typeof d.noCover === 'object') _noCoverCache = d.noCover;
      // Restaurer les favoris depuis localStorage (fallback)
_loadFavoritesFromLocalStorage();
      // Restaurer les favoris depuis les métadonnées persistées
if (window.wt?.getTrackMeta) {
  try {
    const trackMeta = await window.wt.getTrackMeta();
    if (trackMeta) {
      for (const [path, data] of Object.entries(trackMeta)) {
        const track = allTracks.find(t => t.path === path);
        if (track) {
          if (typeof data.isFavorite === 'boolean') {
            track.isFavorite = data.isFavorite;
          }
          if (typeof data.syncExcluded === 'boolean') {
            track._syncExcluded = data.syncExcluded;
          }
          if (data.ignored === true) {
            track._ignored = true;
          }
          // Cooldown + transparence : la vérif auto ne repart pas de zéro à
          // chaque session, et « introuvable en ligne » survit au redémarrage.
          if (data.checkedAt) track._playCheckedAt = data.checkedAt;
          if (data.checkedRev) track._playCheckedRev = data.checkedRev; // C196
          if (data.checkedOutcome === 'refused' || data.checkedOutcome === 'empty') {
            track._autoOutcome = data.checkedOutcome;
            track._autoProcessed = true;
          }
        }
      }
      console.log('[bootLoad] Favoris restaurés depuis trackMeta');
    }
  } catch (e) {
    console.warn('[bootLoad] Erreur lors de la restauration des favoris', e);
  }
}
      // trackMeta est déjà réappliqué côté main.js au rescan
      stopLoadingMessages();
      renderSidebar(); showLib(); updateListHead(); renderVirtual(); updateBreadcrumb();
      if(typeof renderMiniQueue==='function') renderMiniQueue();
      if(typeof refreshReviewBadge==='function') refreshReviewBadge();
      if(d.folder) setFolderLabel(d.folder);
      toast(allLists.length
        ? `✓ ${allTracks.length.toLocaleString()} morceaux · ${allLists.length} playlists`
        : `✓ ${allTracks.length.toLocaleString()} morceaux chargés`);
      // Auto-détection genres en arrière-plan (silencieuse)
      // Auto-fill local album inheritance (instant, no network)
      autoFillLocal(); // instant album inheritance (no network)
      remapGenres();   // normalise les anciens genres vers les 15 buckets
      // Purge async — attendre avant de lancer l'harmonisation pour que les
      // mauvais genres soient effacés avant le re-fetch.
      (async () => {
        try { await purgeBadMeta(); } catch(e){ console.warn(e); }

        // Au boot : pas de fetch automatique. On flag juste les _incomplete
        // depuis le cache existant pour alimenter le badge. La détection des
        // erronés (cache vs tag) se fait via buildMetaDiffs en mode dry-run.
      try {
          if (typeof markAllIncompleteWithCache === 'function') {
            await markAllIncompleteWithCache();
            const n = typeof countTracksToReview === 'function' ? countTracksToReview() : 0;
            console.log(`[boot] ${n} morceaux à vérifier (source de vérité unique)`);
            if (typeof refreshReviewBadge === 'function') refreshReviewBadge();
            // Phase 3 : déclenche l'enrichissement lazy après 5s d'idle
            if (typeof enrichBootKickoff === 'function') enrichBootKickoff();
          }
        } catch (e) { console.warn('[boot] markAllIncompleteWithCache échoué:', e); }

        // Architecture lazy : plus de batch automatique au boot.
        // L'auto-vérif tournera à la volée via enrichQueue (Phases 2-3).
        // L'ancien startAutoEnrich reste accessible via "Tout re-vérifier".
        console.log('[bootLoad] Mode lazy actif — enrichissement à la volée selon visibilité');
      })();
    // Timer 3min désactivé en mode lazy : plus de batch périodique.
      // L'enrichissement se fait à la volée via enrichQueue (Phase 2-3).
    } else {
      stopLoadingMessages();
      document.getElementById('wSubMsg').style.display='';
      document.getElementById('wCtaBtn').style.display='';
    }
  } catch(e){
    console.error('bootLoad:',e);
    stopLoadingMessages();
    document.getElementById('wSubMsg').style.display='';
    document.getElementById('wCtaBtn').style.display='';
  }
}
// Démarrage différé d'un tick pour laisser le DOM peindre en premier
setTimeout(bootLoad, 0);

async function initNet(){
  try {
    myIP   = await window.wt.getIP();
    myPort = await window.wt.getPort();
    document.getElementById('spUrl').textContent=`http://${myIP}:${myPort}/tracks`;
    document.getElementById('spDot').classList.add('on');
    document.getElementById('spDevSub').textContent=`${myIP}:${myPort}`;
  } catch {}
}
initNet();

// ── FOLDER ────────────────────────────────────────
async function forceRescan(){
  // Vide le cache disque puis recharge la bibliothèque
  toast('Actualisation…');
  await window.wt?.clearScanCache?.();
  await bootLoad();
}

async function changeFolderBtn(){
  const hadTracks=allTracks.length>0;
  if(!hadTracks){
    document.getElementById('welcome').style.display='flex';
    document.getElementById('libView').style.display='none';
    document.getElementById('wprog').style.display='flex';
    document.getElementById('wtxt').textContent='Scan en cours…';
  } else {
    toast('Choix du dossier…');
  }
  const r=await window.wt.pickFolder();
  if(!hadTracks) document.getElementById('wprog').style.display='none';
  if(!r){
    if(!hadTracks) document.getElementById('welcome').style.display='flex';
    return;
  }
  const d2=await window.wt.getLibrary().catch(()=>null);
  allTracks=(d2&&d2.tracks)||r.tracks; filtered=[...allTracks];
  allLists=(d2&&d2.lists)||[]; curPl=-1;
  setFolderLabel(r.folder);
  renderSidebar(); showLib(); renderVirtual();
  toast(`✓ ${allTracks.length.toLocaleString()} morceaux`);

}

window._fsOpenEditor = function() {
  const t = queue[qi];
  if (!t) { toast('Aucun morceau'); return; }
  
  const albumTracks = (t.album && t.artist)
    ? allTracks.filter(x => x.album === t.album && x.artist === t.artist)
    : [t];
  albumTracks._primary = t;
  
  // NE PAS fermer le fullscreen, juste ouvrir l'éditeur par-dessus
  openOmniEditor(albumTracks, false);
  
  // Bonus : ajouter un fond semi-transparent à l'éditeur pour qu'on voit encore le fullscreen derrière
  const batchOv = document.getElementById('batchOv');
  if (batchOv) {
    batchOv.style.backgroundColor = 'rgba(0,0,0,0.85)';
  }
};

// ── ITUNES ────────────────────────────────────────
async function connectItunes(manual){
  toast('Connexion iTunes…');
  const r=await window.wt.connectItunes(manual);
  if(!r){toast(manual?'Annulé':'iTunes introuvable — essaie XML…');return;}
  const d3=await window.wt.getLibrary().catch(()=>null);
  if(d3&&d3.lists&&d3.lists.length) allLists=d3.lists;
  else allLists=r.lists;
  renderSidebar();
  plAvail=allLists.map(l=>({name:l.name,count:l.count}));
  plSel=new Set(allLists.map(l=>l.name));
  toast(`iTunes · ${allLists.length} playlists`);
  openModal();
}

function openModal(){renderModal();document.getElementById('ov').classList.add('on');}
function closeModal(){document.getElementById('ov').classList.remove('on');}

function renderModal(){
  const n=plAvail.length;
  document.getElementById('ms').textContent=`${n} playlist${n!==1?'s':''} disponible${n!==1?'s':''}`;
  document.getElementById('ml').innerHTML=plAvail.map(pl=>
    `<div class="mi${plSel.has(pl.name)?' on':''}" onclick="tPl('${esc(pl.name)}')">
      <div class="mc">${plSel.has(pl.name)?'✓':''}</div>
      <div class="mn">${esc(pl.name)}</div>
      <div class="mct">${pl.count} morceaux</div>
    </div>`
  ).join('')||'<div style="padding:32px;text-align:center;color:var(--t3);font-family:var(--font-body)">Aucune playlist trouvée</div>';
  document.getElementById('msel').textContent=`${plSel.size} sélectionnée${plSel.size!==1?'s':''}`;
}
function tPl(n){if(plSel.has(n))plSel.delete(n);else plSel.add(n);renderModal();}
function selAll(){plAvail.forEach(p=>plSel.add(p.name));renderModal();}
function selNone(){plSel.clear();renderModal();}
function applyLists(){
  const incoming=allLists.filter(l=>plSel.has(l.name));
  // Fusionner avec les playlists custom existantes, dernière version gagne pour les iTunes
  const customOnes=allLists.filter(l=>l.custom||l.smart);
  // Dédupliquer par nom — garde le dernier (incoming)
  const map=new Map();
  customOnes.forEach(l=>map.set(l.name,l));
  incoming.forEach(l=>map.set(l.name,l)); // écrase les anciennes
  const fill=document.getElementById('mpfill');
  document.getElementById('mprog').style.display='block';
  document.getElementById('mptxt').textContent=`Import de ${incoming.length} playlist${incoming.length!==1?'s':''}…`;
  let p=0; const iv=setInterval(()=>{p=Math.min(p+10,100);fill.style.width=p+'%';},40);
  setTimeout(()=>{
    clearInterval(iv); fill.style.width='100%';
    allLists=[...map.values()]; renderSidebar(); scheduleSave();
    closeModal(); toast(`✓ ${incoming.length} playlist${incoming.length!==1?'s':''} · doublons fusionnés`);
  },450);
}

// ── BREADCRUMB ────────────────────────────────────
const BC_ICONS={lib:'♪',playlist:'≡',artist:'👤',album:'◉',genre:'◈',flat:'♪',search:'⌕'};
const BC_MODE_LABELS={flat:'Titres',artist:'Artistes',album:'Albums',genre:'Genres',year:'Années',search:'Résultats'};

function updateBreadcrumb(){
  const icon=document.getElementById('navBcIcon'); // optional
  const label=document.getElementById('navBcLabel');
  const sep=document.getElementById('navBcSep');
  const sub=document.getElementById('navBcSub');
  const count=document.getElementById('navBcCount');
  const plCover=document.getElementById('navBcPlCover');
  if(!label) return;

  const n=filtered.length;
  if(count) count.textContent=n.toLocaleString()+' morceau'+(n!==1?'x':'');

  const q=(document.getElementById('searchIn')?.value||'').trim();

  if(curPl>=0 && allLists[curPl]){
    const pl=allLists[curPl];
    const typeLabel=pl.smart?'Smart Playlist':pl.merged?'Playlist fusionnée':'Playlist';
    if(icon) icon.textContent=BC_ICONS.playlist;
    label.textContent=pl.name;
    if(sep) sep.style.display='';
    if(sub) sub.textContent=typeLabel+' · '+pl.count+' morceau'+(pl.count!==1?'x':'');
    // Mini cover de la playlist
    if(plCover){
      plCover.classList.add('on');
      // Cherche un ID stable basé sur la position de la playlist
      plCover.id = 'navBcPlCover'; // garde l'ID stable
      // Reset + placeholder pendant que la cover se charge
      plCover.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
      // Fetch cover si on a une track
      if(pl.tracks && pl.tracks[0]){
        // Priorité à la custom cover stockée, sinon fetch iTunes
        if(customCovers[pl.tracks[0].path]){
          const img = new Image();
          img.onload = () => { plCover.innerHTML = ''; plCover.appendChild(img); };
          img.src = customCovers[pl.tracks[0].path];
        } else {
          fetchPlArt(pl.tracks[0], 'navBcPlCover');
        }
      }
    }
  } else if(q){
    if(icon) icon.textContent=BC_ICONS.search;
    label.textContent='Recherche';
    if(sep) sep.style.display='';
    if(sub) sub.textContent=`"${q}"`;
    if(plCover) plCover.classList.remove('on');
 } else if(_inCompleteBucket){
    // Vue filtrée « à compléter » : on le DIT clairement pour ne pas faire croire
    // que la bibliothèque entière se réduit à ce sous-ensemble.
    if(icon) icon.textContent='◈';
    label.textContent='À compléter';
    if(sep) sep.style.display='';
    if(sub) sub.textContent='sous-ensemble · clique « Tous les morceaux » pour tout revoir';
    if(plCover) plCover.classList.remove('on');
  } else {
    const modeIcons={flat:'♪',artist:'👤',album:'◉',genre:'◈'};
    if(icon) icon.textContent=modeIcons[viewMode]||'♪';
    label.textContent='Bibliothèque';
    if(viewMode!=='flat'){
      if(sep) sep.style.display=''; if(sub) sub.textContent=BC_MODE_LABELS[viewMode]||'';
    } else {
      if(sep) sep.style.display='none'; if(sub) sub.textContent='';
    }
    if(plCover) plCover.classList.remove('on');
  }
}

// ── METADATA PERSISTENCE ──────────────────────────
let _metaSaveTimer = null;
function scheduleMetaSave() {
  clearTimeout(_metaSaveTimer);
  // Refresh the pill counter immediately (reflects user edits without waiting for save flush)
  if(typeof refreshEnrichPill === 'function') refreshEnrichPill();
  _metaSaveTimer = setTimeout(async () => {
    if (!window.wt?.saveTrackMeta) return;

    const meta = {};
    const chunkSize = 500; 
    
    for (let i = 0; i < allTracks.length; i += chunkSize) {
      const chunk = allTracks.slice(i, i + chunkSize);
      
      for (const t of chunk) {
        // On vérifie si on doit sauvegarder ce morceau
        if (t.genre || t.year || t._userModified || t._art || t._needsPersistPurge || t._syncExcluded || t._ignored || t._autoFixed) {
          if (t._needsPersistPurge) {
  meta[t.path] = { genre: '', year: null, userModified: false };
  delete t._needsPersistPurge;
} else {
 const entry = {
    genre: t.genre || '',
    genreChild: t.genreChild || '',
    year: t.year || null,
    art: t._art || null,
    userModified: !!t._userModified,
    isFavorite: !!t.isFavorite,
    syncExcluded: !!t._syncExcluded,    // mémorise l'exclusion auto-favori
    ignored: !!t._ignored,              // « ne plus me le proposer » persistant
    checkedAt: t._playCheckedAt || null, // cooldown vérif auto : pas de re-recherche à chaque session
    checkedRev: t._playCheckedRev || 0,  // C196 : révision de logique au moment de la vérif
    checkedOutcome: (t._autoOutcome === 'refused' || t._autoOutcome === 'empty') ? t._autoOutcome : ''
  };
  
  // Album : persister l'override auto-rempli (recherche par lot) ; ou l'EFFACER
  // si on vient d'annuler (sinon le merge main.js garderait l'ancien au redémarrage).
  if (t._clearAlbumOverride) { entry.album = ''; delete t._clearAlbumOverride; }
  else if (!t._userModified && t._autoFix && t._autoFix.album && t.album) entry.album = t.album;

  // Artiste auto-rempli (recherche par lot) : persister comme l'album auto.
  if (t._clearArtistOverride) { entry.artist = ''; delete t._clearArtistOverride; }
  else if (!t._userModified && t._autoFix && t._autoFix.artist && t.artist) entry.artist = t.artist;

  if (t._userModified) {
    if (t.title) entry.title = t.title;
    if (t.artist) entry.artist = t.artist;
    if (t.album) entry.album = t.album;
    if (t.genreStyle) entry.genreStyle = t.genreStyle;
  }
  
  meta[t.path] = entry;
}
          // Propagation auto vers le mobile : si ce morceau est dans le Sync et
          // qu'un champ propageable (titre/artiste/album/année/genre/cover) a
          // changé depuis la dernière sauvegarde, on pousse la modif sur son doc
          // syncQueue (le mobile suit via son listener). La 1re rencontre fixe la
          // baseline SANS pousser : le doc mobile a déjà l'état courant, écrit au
          // moment du push. Couvre TOUS les chemins d'édition (revue, taxonomie,
          // modale, lot) sans instrumenter chaque site mutateur.
          if (window._pushedTrackPaths && window._pushedTrackPaths.has(t.path)) {
            const _sig = [t.title||'', t.artist||'', t.album||'', t.year||'', t.genre||'', (customCovers[t.path]||t._art||'')].join('\u001f');
            if (typeof t._syncSig === 'undefined') {
              t._syncSig = _sig;
            } else if (t._syncSig !== _sig) {
              t._syncSig = _sig;
              if (typeof schedulePropagateTrackUpdate === 'function') schedulePropagateTrackUpdate(t);
            }
          }
        }
      }
      // On rend la main au navigateur pour éviter les [Violation]
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    if (Object.keys(meta).length > 0) {
      window.wt.saveTrackMeta(meta).catch(() => {});
    }
  }, 10000); 
}

// ── VIEWS ─────────────────────────────────────────
let _inCompleteBucket = false;   // true = vue filtrée « à compléter » (sous-ensemble)
function showAll(){
  _inCompleteBucket = false;     // retour bibliothèque complète → on quitte le filtre
  filtered=[...allTracks]; curPl=-1;
  document.getElementById('si-lib').classList.add('on');
  document.getElementById('si-sync').classList.remove('on');
  document.querySelectorAll('.pl-item').forEach(el=>el.classList.remove('on'));
  document.getElementById('searchIn').value='';
  applySortToFiltered();
  // Retour auto au tab Titres (met à jour les classes visuelles des tabs)
  setViewMode('flat');
  showLib(); updateBreadcrumb();
}

// Lecture rapide : double-clic sur "Tous les morceaux"
// Lance toute la bibliothèque, en respectant l'état shuffle actuel
function playAllLibrary(){
  if(!allTracks.length){ toast('Aucun morceau chargé'); return; }
  showAll();
  setPlayContext('all','');
  queue = allTracks.map(t => ({...t, url: pathToUrl(t.path)}));
  if(typeof _miniQueueLimit !== 'undefined') _miniQueueLimit = 25;
  _shuffleOrder = []; _shuffleCursor = 0;
  if(shuffle){
    qi = Math.floor(Math.random() * queue.length);
    buildShuffleOrder();
    playIdx(qi);
    toast(`▶ Lecture aléatoire · ${queue.length.toLocaleString()} morceaux`);
  } else {
    qi = 0;
    playIdx(0);
    toast(`▶ Lecture · ${queue.length.toLocaleString()} morceaux`);
  }
}
function showPlaylist(i){
  curPl=i; const pl=allLists[i];
  filtered=[...pl.tracks];
  document.getElementById('si-lib').classList.remove('on');
  document.getElementById('si-sync').classList.remove('on');
  document.querySelectorAll('.pl-item').forEach(el=>el.classList.remove('on'));
  const active=document.getElementById('pli'+i);
  if(active) active.classList.add('on');
  document.getElementById('searchIn').value='';
  applySortToFiltered();
  // Retour auto au tab Titres
  setViewMode('flat');
  showLib(); updateBreadcrumb();
}

// Double-clic playlist → afficher ET lancer la lecture immédiatement
function playPlaylistNow(i){
  showPlaylist(i);
  const pl=allLists[i];
  if(!pl||!pl.tracks||!pl.tracks.length) return;
  setPlayContext('playlist', pl.name);
  queue=pl.tracks.map(t=>({...t, url:pathToUrl(t.path)}));
  playIdx(0);
  renderDockQueue();
}
function showSyncView(){
  document.getElementById('si-lib').classList.remove('on');
  document.getElementById('si-sync').classList.add('on');
  document.querySelectorAll('.pl-item').forEach(el=>el.classList.remove('on'));
  document.getElementById('welcome').style.display='none';
  document.getElementById('libView').style.display='none';
  document.getElementById('syncView').classList.add('on');
  // Spinner injecté DIRECTEMENT dans le panneau actif (indépendant de
  // renderSyncQueue et de toute condition) puis rendu du contenu après un court
  // délai — garantit une animation visible à chaque ouverture.
  const _pane = document.getElementById('syncTab-' + _syncTab);
  if (_pane) {
    _pane.innerHTML = `<div class="sync-loading" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:48px 16px;color:var(--muted,#AEACA6);"><svg width="34" height="34" viewBox="0 0 50 50" aria-label="Chargement"><circle cx="25" cy="25" r="20" fill="none" stroke="rgba(200,90,69,0.25)" stroke-width="5"/><circle cx="25" cy="25" r="20" fill="none" stroke="var(--acc)" stroke-width="5" stroke-linecap="round" stroke-dasharray="80 200"><animateTransform attributeName="transform" type="rotate" from="0 25 25" to="360 25 25" dur="0.9s" repeatCount="indefinite"/></circle></svg><div style="font-size:12px;">Chargement…</div></div>`;
  }
  setTimeout(() => renderSyncQueue(), 500);
}
function showLib(){
  document.getElementById('welcome').style.display='none';
  document.getElementById('libView').style.display='flex';
  document.getElementById('syncView').classList.remove('on');
}

// ── VIRTUAL LIST ──────────────────────────────────
let viewMode='flat';
let artistExpanded=new Set(), albumExpanded=new Set(), genreChildFilter=new Map();
let selectedPaths=new Set();

function setViewMode(m, _skipAutoScroll){
  viewMode=m;
  const map={flat:'vtFlat',artist:'vtArtist',album:'vtAlbum',genre:'vtGenre',year:'vtYear'};
  ['vtFlat','vtArtist','vtAlbum','vtGenre','vtYear'].forEach(id=>{
    const el=document.getElementById(id); if(el) el.classList.toggle('on',id===map[m]);
  });
  const vg=document.getElementById('vtGroup'); if(vg) vg.classList.toggle('on',m==='artist');
  artistExpanded.clear(); albumExpanded.clear(); genreChildFilter.clear();
  updateListHead();
  renderVirtual(); updateBreadcrumb();
  // Auto-scroll vers le morceau en cours (sauf si l'appelant gère le scroll,
  // ex. navigateToArtist/Album/Genre/Year depuis le fullscreen).
  if(!_skipAutoScroll) goToCurrentInView();
}

function checkFsOverflow() {
  document.querySelectorAll('.fs-text-wrap').forEach(wrap => {
    const child = wrap.children[0];
    if (child && child.scrollWidth > wrap.clientWidth + 5) {
      wrap.classList.add('marquee-active');
    } else {
      wrap.classList.remove('marquee-active');
    }
  });
}

// ── LISTHEADER DYNAMIC ────────────────────────────────────────────
const LH_CAT_LABELS={artist:'Artistes',album:'Albums',genre:'Genres',year:'Années'};
let groupedSortAsc=true;

function updateListHead(){
  const flat=document.getElementById('listHead-flat');
  const grp=document.getElementById('listHead-grouped');
  const lbl=document.getElementById('lhCatLabel');
  const isFlat=viewMode==='flat';
  // Patch : display explicite — 'grid' pour grouped (sinon style inline '' restait
  // bloqué par d'autres règles), 'grid' aussi pour flat (sa CSS dit grid).
  if(flat) flat.style.display=isFlat?'grid':'none';
  if(grp)  grp.style.display=isFlat?'none':'grid';
  if(lbl)  lbl.textContent=LH_CAT_LABELS[viewMode]||'';
  const label=groupedSortAsc?'A→Z':'Z→A';
  const azFlat=document.getElementById('lhAzBtnFlat');
  const azGrp=document.getElementById('lhAzBtn');
  if(azFlat) azFlat.textContent=label;
  if(azGrp)  azGrp.textContent=label;
}

function toggleGroupedSort(){
  groupedSortAsc=!groupedSortAsc;
  const label=groupedSortAsc?'A→Z':'Z→A';
  const azFlat=document.getElementById('lhAzBtnFlat');
  const azGrp=document.getElementById('lhAzBtn');
  if(azFlat) azFlat.textContent=label;
  if(azGrp)  azGrp.textContent=label;
  const dir=groupedSortAsc?1:-1;
  if(viewMode==='flat'){
    filtered=[...filtered].sort((a,b)=>
      dir*String(a.title||'').localeCompare(String(b.title||''),'fr',{sensitivity:'base'})
    );
    // Reset scroll to top so user sees the sorted result from the beginning
    const lw=document.getElementById('lw');
    if(lw) lw.scrollTop=0;
    renderVirtual();
    return;
  }
  if(viewMode==='artist'||viewMode==='album'||viewMode==='genre'||viewMode==='year'){
    filtered=[...filtered].sort((a,b)=>{
      const ka=viewMode==='year'?(a.year||0):(viewMode==='artist'?a.artist:viewMode==='album'?a.album:a.genre)||'';
      const kb=viewMode==='year'?(b.year||0):(viewMode==='artist'?b.artist:viewMode==='album'?b.album:b.genre)||'';
      return typeof ka==='number'?dir*(ka-kb):dir*(String(ka).localeCompare(String(kb),'fr',{sensitivity:'base'}));
    });
    renderVirtual();
  }
}

// ── FLAT VIEW ──────────────────────────────────────
function renderVirtual(){
  const lw=document.getElementById('lw');
  if(viewMode==='artist'){ renderGrouped(lw, 'artist'); return; }
  if(viewMode==='album'){  renderGrouped(lw, 'album');  return; }
  if(viewMode==='genre'){  renderGrouped(lw, 'genre');  return; }
  if(viewMode==='year'){   renderGrouped(lw, 'year');   return; }

  // Standard virtual list — position:absolute + top (correct pour scroll container)
  document.getElementById('vs').style.height=(filtered.length*ITEM_H)+'px';
  lw.querySelectorAll('.t-row,.ag-row').forEach(r=>r.remove());
  let raf=false;

  function renderFlat(){
    const s=Math.max(0,Math.floor(lw.scrollTop/ITEM_H)-3);
    const e=Math.min(filtered.length,s+PAGE+6);
    lw.querySelectorAll('.t-row').forEach(r=>r.remove());
    const frag=document.createDocumentFragment();
    for(let i=s;i<e;i++){
      const t=filtered[i];
      const play=nowPath===t.path;
      const inSync=syncSel.has(t.path);
      const sel=selectedPaths.has(t.path);
      const div=document.createElement('div');
      div.className='t-row'+(play?' np':'')+(sel?' selected':'');
      div.style.cssText=`top:${i*ITEM_H}px;height:${ITEM_H}px`;
   div.innerHTML=
        `<div class="radd" title="Lire après">`+
        `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M7 4.5C7 3.67 7.92 3.15 8.63 3.58L19.1 10.08C19.79 10.5 19.79 11.5 19.1 11.92L8.63 18.42C7.92 18.85 7 18.33 7 17.5V4.5Z"/></svg></div>`+
        `<div class="rn"></div>`+
        `<div class="r-sync"><div class="r-sync-cb${inSync?' on':''}" title="${inSync?'✓ Sync':'+ Sync'}"></div></div>`+
        `<div class="rc-title"><span class="rt">${esc(t.title)}</span></div>`+
        `<div class="rc-col"><span class="r-artist" data-artist="${(t.artist||'').replace(/"/g,'&quot;')}" onclick="event.stopPropagation();navigateToArtist(this.dataset.artist)" style="cursor:pointer">${esc(t.artist||'–')}</span></div>`+
        `<div class="rc-col"><span class="r-album" data-album="${(t.album||'').replace(/"/g,'&quot;')}" onclick="event.stopPropagation();navigateToAlbum(this.dataset.album)" style="cursor:pointer">${esc(_displayAlbum(t.album))}</span></div>`+
        `<div class="rc-col rc-genre-col"><span class="r-genre">${t.genre?esc(t.genre):''}</span></div>`+
        `<div class="rc-col rc-year-col"><span class="r-year">${t.year||''}</span></div>`+
        `<div class="r-fav"><div class="r-fav-star${t.isFavorite?' on':''}" title="${t.isFavorite?'★ Favori':'☆ Favoriser'}">${t.isFavorite?'★':'☆'}</div></div>`;
      attachRowEvents(div,t,i,inSync);
      frag.appendChild(div);
    }
    lw.appendChild(frag);
  }
  renderFlat();
  lw.onscroll=()=>{ if(!raf){raf=true;requestAnimationFrame(()=>{renderFlat();raf=false;});}};
}

function attachRowEvents(div, t, i, inSync) {
  // Patch N : clic sur l'étoile favori
  const favEl = div.querySelector('.r-fav-star');
  if (favEl) {
    favEl.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      toggleTrackFavorite(t);
    });
  }

  div.addEventListener('dblclick', ev => {
    ev.stopPropagation(); // <--- PREVENT the double-click from reaching the global document
    if (Date.now() - lastSyncClickTime < 400) return;
    playFrom(i);
    hideGrpCtxMenu(); // Force hide if it was somehow open
  });
  div.addEventListener('click', ev => {
    if (ev.target.closest('.r-sync-cb') || ev.target.closest('.radd')) return;
    // ALT/Option click → Reveal in Finder (does not change selection)
    if (ev.altKey) {
      ev.preventDefault();
      if (window.wt?.revealInFinder && t.path) window.wt.revealInFinder(t.path);
      return;
    }
    toggleSelect(t.path, i, ev);
  });
  // ── Cmd/Ctrl-A : select all filtered tracks (Titres tab only) ────
  document.addEventListener('keydown', (ev) => {
    if (!(ev.metaKey || ev.ctrlKey) || ev.key !== 'a') return;
    // Don't hijack when typing in inputs
    const tag = (ev.target?.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || ev.target?.isContentEditable) return;
    // Only meaningful in flat Titres view
    if (currentMode !== 'flat') return;
    ev.preventDefault();
    selectedPaths.clear();
    filtered.forEach(t => selectedPaths.add(t.path));
    _lastSelectedIdx = filtered.length - 1;
    renderVirtual();
  });
  div.addEventListener('contextmenu',ev=>{
    ev.preventDefault(); ev.stopPropagation();
    // iTunes/Finder rule: if right-clicked row is NOT in selection, clear and select just it.
    if (!selectedPaths.has(t.path)) {
      selectedPaths.clear();
      selectedPaths.add(t.path);
      _lastSelectedIdx = i;
      renderVirtual();
    }
    showTrackCtxMenu(ev, t, i);
  });
  div.draggable=true;
  div.addEventListener('dragstart',ev=>{
    // Drag the selection if this row is in it (multi-track payload). Otherwise drag just this row.
    let payload;
    if(selectedPaths.has(t.path) && selectedPaths.size > 1){
      payload = filtered.filter(x => selectedPaths.has(x.path));
      // Custom drag image: "N morceaux"
      try {
        const ghost = document.createElement('div');
        ghost.textContent = `${payload.length} morceaux`;
        ghost.style.cssText = 'position:absolute;top:-1000px;padding:6px 12px;background:var(--acc);color:#fff;font:600 11px Inter;border-radius:6px;';
        document.body.appendChild(ghost);
        ev.dataTransfer.setDragImage(ghost, 10, 10);
        setTimeout(()=>ghost.remove(), 0);
      } catch(_){}
    } else {
      payload = [t];
    }
    ev.dataTransfer.setData('track', JSON.stringify(payload[0])); // back-compat
    ev.dataTransfer.setData('tracks', JSON.stringify(payload));   // new multi-payload
    ev.dataTransfer.effectAllowed = 'copyMove';
  });
  div.querySelector('.radd').addEventListener('click',ev=>{
    ev.stopPropagation();
    if(queue.length){_playNextInsert(t);toast(`"${t.title}" → lecture suivante`);}
    else playFrom(i);
  });
  // ── SYNC: zero-jank — direct DOM toggle, no renderVirtual ────
  const syncCb=div.querySelector('.r-sync-cb');
  if(!syncCb) return;
  function _doSync(addMode){
    if(addMode){
      syncSel.add(t.path);
      _syncLinkAdd(t, { manual: true });  // Patch I : lien manuel
      syncCb.classList.add('on');
      syncCb.title='✓ Sync';
    } else {
      syncSel.delete(t.path);
      _syncLinkRemove(t, { manual: true });  // Patch J : retire le lien manuel
      syncCb.classList.remove('on');
      syncCb.title='+ Sync';
    }
    updateSyncStats([...allTracks.filter(x=>syncSel.has(x.path))]);
  }
  syncCb.addEventListener('mousedown',ev=>{
    ev.stopPropagation();ev.preventDefault();
    lastSyncClickTime=Date.now();
    syncDragging=true; syncDragMode=!syncSel.has(t.path);
    _doSync(syncDragMode);
  });
  syncCb.addEventListener('mouseenter',ev=>{
    if(!syncDragging) return;
    ev.stopPropagation();
    _doSync(syncDragMode);
  });
  syncCb.addEventListener('mouseup',ev=>{ev.stopPropagation();ev.preventDefault();});
}

// ── GROUPED VIEW (Artiste › Album › Titres) ────────
// ── SYNC HELPERS POUR GROUPES (artiste/album/genre/année) ─────────
// Calcule l'état du sync pour un ensemble de pistes : 'all', 'partial', 'none'.
function _groupSyncState(tracks){
  if(!tracks || !tracks.length) return 'none';
  let n=0;
  for(const t of tracks){ if(t && t.path && syncSel.has(t.path)) n++; }
  if(n === 0) return 'none';
  if(n === tracks.length) return 'all';
  return 'partial';
}

// HTML d'une cellule sync (checkbox 3-états) pour une ag-row.
function _groupSyncCellHTML(tracks){
  const state = _groupSyncState(tracks);
  const cls = state === 'all' ? 'r-sync-cb on' : state === 'partial' ? 'r-sync-cb partial' : 'r-sync-cb';
  const title = state === 'all' ? '✓ Tout dans Sync' : state === 'partial' ? 'Partiellement dans Sync' : 'Ajouter au Sync';
  return `<div class="r-sync ag-sync"><div class="${cls}" title="${title}"></div></div>`;
}
// Patch N.5 : étoile agrégée informative sur les en-têtes d'entités.
// Calcule le % de favoris du groupe et renvoie une étoile de 3 tailles
// possibles selon le seuil, ou rien si 0%.
//   0%        → pas d'étoile
//   1% – 30%  → petite étoile
//   31% – 65% → étoile moyenne
//   > 65%     → grande étoile
// Purement visuel : pas de clic, juste un indicateur informatif.
function _groupFavPct(tracks){
  if(!tracks || !tracks.length) return 0;
  let n = 0;
  for(const t of tracks){ if(t && t.isFavorite === true) n++; }
  return n / tracks.length;
}

function _groupFavCellHTML(tracks){
  const pct = _groupFavPct(tracks);
  if(pct <= 0) return `<div class="r-fav ag-fav"></div>`;
  let sizeClass;
  if(pct <= 0.30)      sizeClass = 'sm';
  else if(pct <= 0.65) sizeClass = 'md';
  else                 sizeClass = 'lg';
  const pctTxt = Math.round(pct * 100) + '%';
  return `<div class="r-fav ag-fav"><span class="ag-fav-star ${sizeClass}" title="${pctTxt} favoris dans ce groupe">★</span></div>`;
}

// Toggle sync pour tout un groupe : si all → none, sinon → all.
function toggleGroupSync(tracks, ev){
  if(ev) ev.stopPropagation();
  if(!tracks || !tracks.length) return;
  const state = _groupSyncState(tracks);
  if(state === 'all'){
    tracks.forEach(t => {
      if(t && t.path) {
        syncSel.delete(t.path);
        _syncLinkRemove(t, { manual: true });  // Patch J : retire juste le lien manuel
      }
    });
    toast(`− ${tracks.length} morceau${tracks.length!==1?'x':''} retirés du Sync`);
  } else {
    let added = 0;
    tracks.forEach(t => {
      if(t && t.path && !syncSel.has(t.path)){
        syncSel.add(t.path);
        _syncLinkAdd(t, { manual: true });  // Patch I : lien manuel
        added++;
      }
    });
    toast(`✓ +${added} morceau${added!==1?'x':''} au Sync`);
  }
  updateSyncStats([...allTracks.filter(x=>syncSel.has(x.path))]);
  if(typeof renderSyncQueue==='function' && document.getElementById('syncView')?.classList.contains('on')){
    renderSyncQueue();
  }
  if(typeof renderVirtual==='function') renderVirtual();
}

// ── METADATA HARMONISATION HELPERS ────────────────
// Compute the dominant artist/year/genre for an album from its tracks.
// Year prefers MusicBrainz first-release-date when available (recording year ≈ original release).
// Returns {artist, year, genre, isCompilation, confidence}.
function dominantMeta(tracks){
  if(!tracks || !tracks.length) return {artist:'', year:'', genre:'', isCompilation:false, confidence:0};
  const list = tracks.map(x => x.t || x).filter(Boolean);
  const counts = (key) => {
    const m = new Map();
    for(const t of list){
      const v = t[key];
      if(v === undefined || v === null || v === '') continue;
      m.set(v, (m.get(v)||0) + 1);
    }
    if(!m.size) return {top:'', frac:0};
    const sorted = [...m.entries()].sort((a,b)=>b[1]-a[1]);
    return {top: sorted[0][0], frac: sorted[0][1]/list.length};
  };
  const a = counts('artist');
  const y = counts('year');
  const g = counts('genre');
  const gc = counts('genreChild');
  // Compilation detection
  const albumName = (list[0]?.album || '').toLowerCase();
  const compiPatterns = /\b(various artists|v\/a|ost|soundtrack|bande originale|b\.o\.|compilation|greatest hits|best of|now that's what|now thats what)\b/;
  const isCompilation = a.frac < 0.5 || compiPatterns.test(albumName);
  // Confidence: low if covers <70% on artist or year missing on >50%
  const confidence = Math.min(a.frac, y.frac);
  return {
    artist: isCompilation ? 'Various Artists' : a.top,
    year: y.top || '',
    genre: g.top || '',
    genreChild: gc.top || '',
    isCompilation,
    confidence
  };
}
// Clear the "unidentified" flag once a track has both genre and year (auto or manual).
function _clearUnidentifiedIfComplete(t){
  if(!t) return;
  if(t.genre && t.year) delete t._unidentified;
}
// Compilation pattern reused by buildAlbumGroups (kept in sync with dominantMeta)
const _COMPI_RE = /\b(various artists|v\/a|v\.a\.|ost|soundtrack|bande originale|b\.o\.|compilation|greatest hits|best of|now that's what|now thats what|hits collection|anthology)\b/i;

// Mark whether an existing tag is "junk" — likely scraped or wrong.
// Used by harmonisation to decide whether to overwrite even non-empty tags.
const _JUNK_GENRES = new Set([
  'music','musique','other','autre','unknown','inconnu','divers','various','misc','default',
  '12','13','255','-','—','n/a','none'
]);
function isJunkGenre(g){
  if(!g) return true;
  const n = String(g).trim().toLowerCase();
  return !n || _JUNK_GENRES.has(n) || /^\d+$/.test(n);
}
function isJunkYear(y){
  if(!y) return true;
  const n = parseInt(y);
  if(isNaN(n)) return true;
 return n < 1400 || n > new Date().getFullYear() + 1;
}

function buildGroupedRows(mode){
  const RH={group:72, subAlbum:72, subArtist:56, track:52, pills:44};
  // back-compat alias for any leftover .sub references
  RH.sub = RH.subArtist;
  const rows=[];
  let y=0;

  if(mode==='album'){
    const albums=new Map();
    filtered.forEach((t,i)=>{
      const al=t.album||'(Album inconnu)';
      if(!albums.has(al))albums.set(al,[]);
      albums.get(al).push({t,i});
    });
    // Sort: known albums first, unknown at bottom
    const albumEntries=[...albums.entries()].sort(([a],[b])=>{
      const aUnk=a.startsWith('(');const bUnk=b.startsWith('(');
      if(aUnk!==bUnk) return aUnk?1:-1;
      return a.localeCompare(b,'fr',{sensitivity:'base'});
    });
    for(const [album,tracks] of albumEntries){
      const meta = dominantMeta(tracks);
      const parts = [];
      if(meta.artist) parts.push(meta.artist);
      if(meta.genre)  parts.push(meta.genre);          // genre 2nd
      if(meta.year)   parts.push(String(meta.year));   // year last
      rows.push({type:'group',label:album,sub:parts.join(' · '),key:'AL_'+album,count:tracks.length,tracks,icon:'album',y});
      y+=RH.group;
      if(!artistExpanded.has('AL_'+album))continue;
      tracks.forEach(({t,i},pos)=>{rows.push({type:'track',t,filteredIdx:i,albumPos:pos,y});y+=RH.track;});
    }
    return{rows,totalH:y,RH};
  }

 if(mode==='year'){
    // C11 — Group par TRANCHE (décennie ≥1910, siècle avant), miroir mobile.
    // Seuils et libellés identiques à yearBucket() de library.tsx pour que les
    // périodes correspondent desktop ↔ mobile (le sync ne transporte que t.year,
    // le regroupement est calculé à l'affichage des deux côtés).
    // C220 : bucket d'année = SOURCE DE VÉRITÉ UNIQUE (wtYearBucket, global).
    // Les résolveurs de split button re-dérivaient l'appartenance au groupe en
    // faisant parseInt() sur le LIBELLÉ (« Sans année », « Années 1970 ») →
    // NaN → `x === NaN` toujours faux → « Aucun morceau dans ce groupe » sur
    // TOUS les groupes par année. Ils appellent désormais la même fonction.
    const yearBucket = wtYearBucket;
    // Group by bucket (sortKey desc), then artist, then album
    const years=new Map();
    filtered.forEach((t,i)=>{
      const b=yearBucket(t.year||0);
      if(!years.has(b.key))years.set(b.key,{label:b.label,sortKey:b.sortKey,items:[]});
      years.get(b.key).items.push({t,i});
    });
    const sorted=[...years.entries()].sort((a,b)=>b[1].sortKey-a[1].sortKey);
    for(const [bucketKey,bucket] of sorted){
      const tracks=bucket.items;
      const label=bucket.label;
      // Group by artist
      const byArtist=new Map();
      tracks.forEach(({t,i})=>{const a=_artistDisplayGroup(t.artist)||'(Artiste inconnu)';if(!byArtist.has(a))byArtist.set(a,[]);byArtist.get(a).push({t,i});});
      const artistsCount = byArtist.size;
      rows.push({type:'group',label,sub:`${artistsCount} artiste${artistsCount!==1?'s':''} · ${tracks.length} morceau${tracks.length!==1?'x':''}`,key:'YR_'+bucketKey,count:tracks.length,tracks,icon:'year',y});
      y+=RH.group;
      if(!artistExpanded.has('YR_'+bucketKey))continue;
      // Sort artists alphabetically
      const artistEntries=[...byArtist.entries()].sort(([a],[b])=>a.localeCompare(b,'fr',{sensitivity:'base'}));
      for(const [artist,atracks] of artistEntries){
        const aKey='YR_'+bucketKey+'|'+artist;
        const byAlbum=new Map();
        atracks.forEach(({t,i})=>{const al=t.album||'(Album inconnu)';if(!byAlbum.has(al))byAlbum.set(al,[]);byAlbum.get(al).push({t,i});});
        rows.push({type:'sub',label:artist,sub:`${byAlbum.size} album${byAlbum.size!==1?'s':''} · ${atracks.length} morceau${atracks.length!==1?'x':''}`,key:aKey,count:atracks.length,tracks:atracks,subKind:'artist',y});
        y+=RH.sub;
        if(!albumExpanded.has(aKey))continue;
        const albumEntries=[...byAlbum.entries()].sort(([a],[b])=>a.localeCompare(b,'fr',{sensitivity:'base'}));
        for(const [album,abtracks] of albumEntries){
          const abKey=aKey+'|'+album;
          const gMeta = dominantMeta(abtracks);
          rows.push({type:'sub',label:album,sub:'',key:abKey,count:abtracks.length,tracks:abtracks,subKind:'album',y,
                     albMeta:{artist:gMeta.artist, year:gMeta.year, genre:gMeta.genre}});
          y+=RH.subAlbum;
          if(!albumExpanded.has(abKey))continue;
          abtracks.forEach(({t,i},pos)=>{rows.push({type:'track',t,filteredIdx:i,albumPos:pos,y});y+=RH.track;});
        }
      }
    }
    return{rows,totalH:y,RH};
  }

  if(mode==='genre'){
    const genres=new Map();
    filtered.forEach((t,i)=>{
      const g=t.genre||'(Sans genre)';
      if(!genres.has(g))genres.set(g,[]);
      genres.get(g).push({t,i});
    });
    const sorted=[...genres.entries()].sort(([a,ta],[b,tb])=>{
      const aUnk=a.startsWith('(');const bUnk=b.startsWith('(');
      if(aUnk!==bUnk) return aUnk?1:-1;
      return a.localeCompare(b,'fr',{sensitivity:'base'});
    });
    for(const [genre,tracks] of sorted){
      // Group by artist first to compute counts
      const byArtist=new Map();
      tracks.forEach(({t,i})=>{const a=t.artist||'(Artiste inconnu)';if(!byArtist.has(a))byArtist.set(a,[]);byArtist.get(a).push({t,i});});
      const artistsCount = byArtist.size;
      rows.push({type:'group',label:genre,sub:`${artistsCount} artiste${artistsCount!==1?'s':''} · ${tracks.length} morceau${tracks.length!==1?'x':''}`,key:'GN_'+genre,count:tracks.length,tracks,icon:'genre',y});
      y+=RH.group;
      if(!artistExpanded.has('GN_'+genre))continue;
      // Item 5 — pills de filtre sous-genre dans le parent genre déplié.
      // N'apparaissent que si >=2 sous-genres (t.genreChild) distincts existent.
      // Le compteur d'en-tete reste le total ; la pill ne reduit que l'affiche.
      const _gKey='GN_'+genre;
      const _gChildren=[...new Set(tracks.map(({t})=>t.genreChild).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'fr',{sensitivity:'base'}));
      const _gSel=genreChildFilter.get(_gKey)||null;
      if(_gChildren.length>=2){ rows.push({type:'genrePills',key:_gKey,children:_gChildren,sel:_gSel,y}); y+=RH.pills; }
      const _gShown=(_gSel&&_gChildren.includes(_gSel))?tracks.filter(({t})=>t.genreChild===_gSel):tracks;
      const _gByArtist=new Map();
      _gShown.forEach(({t,i})=>{const a=t.artist||'(Artiste inconnu)';if(!_gByArtist.has(a))_gByArtist.set(a,[]);_gByArtist.get(a).push({t,i});});
      // Sort artists alphabetically
      const artistEntries=[..._gByArtist.entries()].sort(([a],[b])=>a.localeCompare(b,'fr',{sensitivity:'base'}));
      for(const [artist,atracks] of artistEntries){
        const aKey='GN_'+genre+'|'+artist;
        // Group artist tracks by album
        const byAlbum=new Map();
        atracks.forEach(({t,i})=>{const al=t.album||'(Album inconnu)';if(!byAlbum.has(al))byAlbum.set(al,[]);byAlbum.get(al).push({t,i});});
        rows.push({type:'sub',label:artist,sub:`${byAlbum.size} album${byAlbum.size!==1?'s':''} · ${atracks.length} morceau${atracks.length!==1?'x':''}`,key:aKey,count:atracks.length,tracks:atracks,subKind:'artist',y});
        y+=RH.sub;
        if(!albumExpanded.has(aKey))continue;
        // Sort albums alphabetically
        const albumEntries=[...byAlbum.entries()].sort(([a],[b])=>a.localeCompare(b,'fr',{sensitivity:'base'}));
        for(const [album,abtracks] of albumEntries){
          const abKey=aKey+'|'+album;
          const gMeta = dominantMeta(abtracks);
          rows.push({type:'sub',label:album,sub:'',key:abKey,count:abtracks.length,tracks:abtracks,subKind:'album',y,
                     albMeta:{artist:gMeta.artist, year:gMeta.year, genre:gMeta.genre}});
          y+=RH.subAlbum;
          if(!albumExpanded.has(abKey))continue;
          abtracks.forEach(({t,i},pos)=>{rows.push({type:'track',t,filteredIdx:i,albumPos:pos,y});y+=RH.track;});
        }
      }
    }
    return{rows,totalH:y,RH};
  }

  // Artist mode (default)
  const artists=new Map();
  filtered.forEach((t,i)=>{
    const a=t.artist||'(Artiste inconnu)';
    const al=t.album||'(Album inconnu)';
    if(!artists.has(a))artists.set(a,new Map());
    const albums=artists.get(a);
    if(!albums.has(al))albums.set(al,[]);
    albums.get(al).push({t,i});
  });
  // Sort artists: known first, unknown at bottom, then A-Z
  const artistEntries=[...artists.entries()].sort(([a],[b])=>{
    const aUnk=a.startsWith('(');const bUnk=b.startsWith('(');
    if(aUnk!==bUnk) return aUnk?1:-1;
    return a.localeCompare(b,'fr',{sensitivity:'base'});
  });
  for(const [artist,albums] of artistEntries){
    const total=[...albums.values()].reduce((s,ts)=>s+ts.length,0);
    rows.push({type:'artist',artist,key:artist,count:total,albumsCount:albums.size,y});
    y+=RH.group;
    if(!artistExpanded.has(artist))continue;
    for(const [album,tracks] of albums){
      const alKey=artist+'||'+album;
      const aMeta = dominantMeta(tracks);
      rows.push({type:'album',artist,album,key:alKey,count:tracks.length,tracks,y,
                 albMeta:{artist:aMeta.artist, year:aMeta.year, genre:aMeta.genre}});
      y+=RH.subAlbum;
      if(!albumExpanded.has(alKey))continue;
      tracks.forEach(({t,i},pos)=>{rows.push({type:'track',t,filteredIdx:i,albumPos:pos,y});y+=RH.track;});
    }
  }
  return{rows,totalH:y,RH};
}

function _ensureGenrePillsCss(){
  if(document.getElementById('wt-genre-pills-style'))return;
  const css=`
.genre-pills-row{display:flex;align-items:center;padding-left:32px;background:transparent;}
.gp-wrap{display:flex;gap:6px;flex-wrap:nowrap;overflow-x:auto;padding:4px 10px 4px 0;max-width:100%;scrollbar-width:thin;}
.gp-wrap::-webkit-scrollbar{height:5px;}
.gp-pill{font-size:11px;line-height:1;padding:4px 11px;border-radius:11px;border:.5px solid var(--ln);color:var(--t2);background:transparent;white-space:nowrap;cursor:pointer;user-select:none;transition:background .12s,border-color .12s,color .12s;}
.gp-pill:hover{border-color:var(--t3);color:var(--t1);}
.gp-pill.on{background:#C85A45;border-color:transparent;color:#fff;}
`;
  const st=document.createElement('style'); st.id='wt-genre-pills-style'; st.textContent=css; document.head.appendChild(st);
}
function renderGrouped(lw, currentMode){
  // Valeur par défaut si undefined
  if (!currentMode) currentMode = viewMode || 'flat';
  console.log('renderGrouped called with mode:', currentMode);
  
  const{rows,totalH,RH}=buildGroupedRows(currentMode);
  document.getElementById('vs').style.height=totalH+'px';
  lw.querySelectorAll('.t-row,.ag-row').forEach(r=>r.remove());
  let raf=false;
  function doRender(){
    const top=lw.scrollTop, bot=top+lw.clientHeight+300;
    lw.querySelectorAll('.t-row,.ag-row').forEach(r=>r.remove());
    const frag=document.createDocumentFragment();
    rows.forEach(r=>{
      if(r.y+80<top||r.y>bot)return;
      const rh = r.type==='track' ? RH.track
               : r.type==='genrePills' ? RH.pills
               : r.type==='sub'   ? (r.subKind==='album' ? RH.subAlbum : RH.subArtist)
               : r.type==='album' ? RH.subAlbum
               : RH.group;
      const div=document.createElement('div');
    if(r.type==='track'){
        const{t,filteredIdx:i,albumPos}=r;
        const play=nowPath===t.path, inSync=syncSel.has(t.path), sel=selectedPaths.has(t.path);
        div.className='t-row'+(play?' np':'')+(sel?' selected':'');
        // Patch N.3.4b : grid-template-columns aligné sur le header
        //   leading | num | sync | title | artist | album | genre | year | fav
        // Patch N.3.4c : même grille que la vue Titres (flat) pour cohérence
        // visuelle parfaite entre tabs. Légère indentation conservée pour
        // marquer la hiérarchie album→track.
       div.style.cssText=`top:${r.y}px;height:${rh}px;padding-left:32px;grid-template-columns:22px 0 34px minmax(0,2fr) minmax(0,1.4fr) minmax(0,1.1fr) minmax(0,140px) 44px 28px;`;
        const tn=albumPos!==undefined?albumPos+1:'';
        
        // Empty cells (kept in DOM so CSS Grid slots don't collapse).
        // Visible cells follow the per-tab matrix you defined:
        //   Artist tab tracks → Titre · Genre · Fav
        //   Album tab tracks  → Titre · Fav
        //   Genre tab tracks  → Titre · Fav
        //   Année tab tracks  → Titre · Genre · Fav
        const _empty   = '<div class="rc-col"></div>';
        const _emptyG  = '<div class="rc-col rc-genre-col"></div>';
        const _emptyY  = '<div class="rc-col rc-year-col"></div>';
        const _genreVis = `<div class="rc-col rc-genre-col"></div>`;

        let artistHtml = _empty;
        let albumHtml  = _empty;
        let genreHtml  = _emptyG;
        let yearHtml   = _emptyY;

        if (currentMode === 'artist' || currentMode === 'year') {
          genreHtml = _genreVis;   // genre is the only extra column
        }
        // album & genre modes: title + fav only — all four stay empty
        // any other mode falls through with empties (safe default)
        
        div.innerHTML =
          `<div class="radd"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg></div>` +
          `<div class="rn"></div>` +
          `<div class="r-sync"><div class="r-sync-cb${inSync?' on':''}" title="${inSync?'✓ Dans le Sync':'Ajouter au Sync'}"></div></div>` +
          `<div class="rc-title"><span class="rt">${esc(t.title)}</span></div>` +
          artistHtml +
          albumHtml +
          genreHtml +
          yearHtml +
          `<div class="r-fav"><div class="r-fav-star${t.isFavorite?' on':''}" title="${t.isFavorite?'★ Favori':'☆ Favoriser'}">${t.isFavorite?'★':'☆'}</div></div>`;
        attachRowEvents(div,t,i,inSync);
      }
      else if(r.type==='genrePills'){
        _ensureGenrePillsCss();
        div.className='ag-row genre-pills-row';
        div.style.cssText=`top:${r.y}px;height:${rh}px`;
        const _pills=[`<span class="gp-pill${!r.sel?' on':''}" data-child="">Tous</span>`]
          .concat((r.children||[]).map(c=>`<span class="gp-pill${r.sel===c?' on':''}" data-child="${String(c).replace(/"/g,'&quot;')}">${esc(c)}</span>`));
        div.innerHTML=`<div class="gp-wrap">${_pills.join('')}</div>`;
        div.addEventListener('click',ev=>{
          const _p=ev.target.closest('.gp-pill'); if(!_p)return;
          ev.stopPropagation();
          const _c=_p.getAttribute('data-child')||'';
          if(_c) genreChildFilter.set(r.key,_c); else genreChildFilter.delete(r.key);
          renderGrouped(lw,currentMode);
        });
      }
       else if(r.type==='group'){
        const open=artistExpanded.has(r.key);
        const groupArtId='agGrpA_'+r.key.replace(/[^a-z0-9]/gi,'_').slice(0,30);
        div.className='ag-row'+(r.icon==='genre'?' genre-row':r.icon==='year'?' year-row':r.icon==='album'?' album-group-row':' artist-row');
        div.style.cssText=`top:${r.y}px;height:${rh}px`;
        div.setAttribute('data-row-key', r.key);
        if(r.icon==='genre') div.setAttribute('data-genre', r.label);
        // Album mode : cover de l'album. Sinon : pas de cover (CSS hide)
        let artHtml = '';
        if(r.icon === 'album'){
          artHtml = `<div class="ag-art" id="${groupArtId}"><div class="ag-art-ph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></div></div>`;
        } else {
          artHtml = `<div class="ag-art"></div>`; // placeholder hidden by CSS for genre/year/artist rows
        }
        // Choisir la classe du label selon le type
        let nameInner;
        if(r.icon === 'album'){
          nameInner = esc(r.label); // brackets come from .album-group-row .ag-name CSS
        } else if(r.icon === 'genre'){
          // Genre: laisser le style accent (CSS .genre-row .ag-name)
          nameInner = esc(r.label);
        } else if(r.icon === 'year'){
          // Année : style année (gris fort)
          nameInner = `<span class="r-year-big">${esc(r.label)}</span>`;
        } else {
          nameInner = `<span class="r-artist">${esc(r.label)}</span>`;
        }
        // Sub-info parsing — style per field type for charter consistency
        // - Album mode: position-based (1st = artist, 2nd = year)
        // - Other modes: count text (grey courier)
        const subParts = (r.sub || '').split(' · ').filter(Boolean);
        const _sep = ' <span style="color:var(--t3);opacity:.5">·</span> ';
        let subHtml;
        if(r.icon === 'album' && subParts.length){
          // Position-based detection: idx 0 = artist; year matches /\d{4}/; rest = genre
          subHtml = subParts.map((p, idx) => {
            const v = p.trim();
            if(idx === 0) return `<span class="r-artist">${esc(v)}</span>`;
            if(/^\d{4}$/.test(v)) return `<span class="r-year">${esc(v)}</span>`;
            return `<span class="ag-genre-chip" data-genre="${v.replace(/"/g,'&quot;')}">${esc(v)}</span>`;
          }).join(_sep);
        } else if(subParts.length){
          subHtml = subParts.map(p => `<span class="r-album-cnt">${esc(p)}</span>`).join(_sep);
        } else {
          subHtml = `<span class="r-album-cnt">${r.count} titre${r.count!==1?'s':''}</span>`;
        }
      const _grpTracks = (r.tracks||[]).map(({t})=>t).filter(Boolean);
        // ID logique pour le split button selon le type de groupe (cohérent avec
      // _resolveSyncGroupTracks → kind = genre/year/album/artist)
      const _grpId = `${r.icon}:${r.label}`;
      div.innerHTML=
          _groupSyncCellHTML(_grpTracks)+
          `<div class="ag-content-mid">`+
            artHtml+
            `<div class="ag-info">`+
              `<div class="ag-name">${nameInner}</div>`+
              `<div class="ag-ct">${subHtml}</div>`+
            `</div>`+
          `</div>`+
          _splitButtonHTML(_grpId)+
          _groupFavCellHTML(_grpTracks);
        div.setAttribute('data-wt-ps-parent', '');
        div.addEventListener('click',ev=>{
          if(ev.target.closest('.ag-sync')){toggleGroupSync((r.tracks||[]).map(({t})=>t).filter(Boolean), ev);return;}
          // Split button ▶/🔀 : lecture au SIMPLE clic (avant, le clic était
          // juste avalé → il fallait double-cliquer le bandeau pour jouer).
          const psBtn = ev.target.closest('.wt-ps-play, .wt-ps-shuf');
          if(psBtn){
            ev.stopPropagation();
            if(!_grpTracks.length){toast('Aucun morceau dans ce groupe');return;}
            const kind = r.icon==='genre'?'genre':r.icon==='year'?'year':r.icon==='album'?'album':'group';
            if(psBtn.classList.contains('wt-ps-shuf')) shuffleGroup(_grpTracks, kind, r.label);
            else playGroup(_grpTracks, kind, r.label);
            return;
          }
          if(ev.target.closest('.wt-ps')){ev.stopPropagation();return;}
          artistExpanded.has(r.key)?artistExpanded.delete(r.key):artistExpanded.add(r.key);
          renderVirtual();
        });
        div.addEventListener('dblclick',ev=>{
          ev.stopPropagation();
          const ts=(r.tracks||[]).map(({t})=>t);
          if(!ts.length) return;
          setPlayContext(r.icon==='genre'?'genre':r.icon==='year'?'year':'album',r.label);
          queue=ts.map(t=>({...t,url:pathToUrl(t.path)}));
          playIdx(0); renderDockQueue();
        });
        div.addEventListener('contextmenu',ev=>{ev.preventDefault();showGrpCtxMenu(ev,r.label,r.label,r.count+' titre'+(r.count!==1?'s':''),()=>(r.tracks||[]).map(({t})=>t), r.icon==='album');});
        // Pre-fetch album cover in album mode
        if(r.icon === 'album' && r.tracks?.[0]?.t){
          const tArr = r.tracks.map(x => x.t);
          { const tArr = r.tracks.map(x => x.t).filter(Boolean); setTimeout(()=>fetchPlArt(tArr[0], groupArtId, tArr, 0), 60); }
        }
      } else if(r.type==='sub'){
        const open=albumExpanded.has(r.key);
        const subArtId='agSubA_'+r.key.replace(/[^a-z0-9]/gi,'_').slice(0,40);
        div.className='ag-row album-row';
        div.style.cssText=`top:${r.y}px;height:${rh}px`;
        const subKind = r.subKind || 'album'; // legacy default
        let subArtHtml;
        if(subKind === 'artist'){
          subArtHtml = `<div class="ag-art" data-subkind="artist" id="${subArtId}"></div>`;
        } else {
          subArtHtml = `<div class="ag-art" id="${subArtId}"><div class="ag-art-ph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" style="width:18px;height:18px"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></div></div>`;
        }
        // Unified format : titre Inter blanc + sub Artiste · [Album] · Année (mêmes classes que track row)
        let infoHtml = '';
        if(subKind === 'artist'){
          // Sous-rangée "Artiste" (sous Genre ou Année)
          // Label = nom artiste (style artiste rouge), sub = "X albums · Y morceaux"
          infoHtml = `<div class="ag-info">`+
            `<div class="ag-name"><span class="r-artist">${esc(r.label)}</span></div>`+
            `<div class="ag-ct"><span class="r-album-cnt">${esc(r.sub || (r.count + ' titre' + (r.count!==1?'s':'')))}</span></div>`+
            `</div>`;
        } else {
          // Sous-rangée "Album" sous Genre/Année — sub-line = artist · genre · year (consistance avec Album tab)
          // Si albMeta est fourni par buildGroupedRows on l'utilise, sinon on calcule à la volée.
          const m = r.albMeta || dominantMeta(r.tracks||[]);
          const bits = [];
          // En tab Genre, le genre parent est déjà connu → on le saute pour éviter la redondance.
          // En tab Année, l'année parente est déjà connue → on la saute pour éviter la redondance.
          if(m.artist) bits.push(`<span class="r-artist">${esc(m.artist)}</span>`);
          if(m.genre && currentMode !== 'genre') bits.push(`<span class="ag-genre-chip" data-genre="${(m.genre||'').replace(/"/g,'&quot;')}">${esc(m.genre)}</span>`);
          if(m.genreChild) bits.push(`<span class="ag-child-chip" style="font-size:.82em;opacity:.7;padding:1px 6px;border:.5px solid var(--ln);border-radius:6px">${esc(m.genreChild)}</span>`);
          if(m.year && currentMode !== 'year')   bits.push(`<span class="r-year">${esc(String(m.year))}</span>`);
          const sep = ' <span style="color:var(--t3);opacity:.5">·</span> ';
          infoHtml = `<div class="ag-info">`+
            `<div class="ag-name album">${esc(r.label)}</div>`+
            `<div class="ag-ct">${bits.join(sep)}</div>`+
            `</div>`;
        }
      const _subTracks = (r.tracks||[]).map(({t})=>t).filter(Boolean);
        const _subId = `${subKind === 'artist' ? 'artist' : 'album'}:${r.label}`;
      div.innerHTML=
          _groupSyncCellHTML(_subTracks)+
          `<div class="ag-content-mid">`+
            subArtHtml+
            infoHtml+
          `</div>`+
          _splitButtonHTML(_subId)+
          _groupFavCellHTML(_subTracks);
      div.setAttribute('data-wt-ps-parent', '');
        div.addEventListener('click',ev=>{
          if(ev.target.closest('.ag-sync')){toggleGroupSync((r.tracks||[]).map(({t})=>t).filter(Boolean), ev);return;}
          if(ev.target.closest('.wt-ps')){ev.stopPropagation();return;}
          albumExpanded.has(r.key)?albumExpanded.delete(r.key):albumExpanded.add(r.key);
          renderVirtual();
        });
        div.addEventListener('dblclick',ev=>{
          ev.stopPropagation();
          const ts=(r.tracks||[]).map(({t})=>t);
          if(!ts.length) return;
          setPlayContext(subKind==='artist'?'artist':'album',r.label);
          queue=ts.map(t=>({...t,url:pathToUrl(t.path)}));
          playIdx(0); renderDockQueue();
        });
        div.addEventListener('contextmenu',ev=>{ev.preventDefault();showGrpCtxMenu(ev,r.label,r.sub||'',r.count+' titre'+(r.count!==1?'s':''),()=>(r.tracks||[]).map(({t})=>t), subKind==='album');});
        // Fetch image — covers uniquement pour les sous-rangées 'album'
        if(r.tracks?.[0]?.t && subKind === 'album'){
          const tArr = r.tracks.map(x => x.t);
          { const tArr = r.tracks.map(x => x.t).filter(Boolean); setTimeout(()=>fetchPlArt(tArr[0], subArtId, tArr, 0), 60); }
        }
      } else if(r.type==='artist'){
        const open=artistExpanded.has(r.key);
        const artId='agArtP_'+r.key.replace(/[^a-z0-9]/gi,'_').slice(0,30);
        div.className='ag-row artist-row';
        div.style.cssText=`top:${r.y}px;height:${rh}px`;
        div.setAttribute('data-row-key', r.key);
        const albumsCt = r.albumsCount || 0;
        const ctText = `${albumsCt} album${albumsCt!==1?'s':''} · ${r.count} morceau${r.count!==1?'x':''}`;
      const _artTracks = filtered.filter(t=>(t.artist||'(Artiste inconnu)')===r.artist);
        div.innerHTML=
          _groupSyncCellHTML(_artTracks)+
          `<div class="ag-content-mid">`+
            `<div class="ag-art" id="${artId}"></div>`+
            `<div class="ag-info">`+
              `<div class="ag-name"><span class="r-artist">${esc(r.artist)}</span></div>`+
              `<div class="ag-ct"><span class="r-album-cnt">${esc(ctText)}</span></div>`+
            `</div>`+
          `</div>`+
          _splitButtonHTML('artist:' + r.artist)+
          _groupFavCellHTML(_artTracks);
        // Marque la rangée pour révéler le split button au hover
        div.setAttribute('data-wt-ps-parent', '');
       div.addEventListener('click',ev=>{
          if(ev.target.closest('.ag-sync')){toggleGroupSync(filtered.filter(t=>(t.artist||'(Artiste inconnu)')===r.artist), ev);return;}
          // Split button : on laisse le délégateur global gérer (cf. listener au mount)
          if(ev.target.closest('.wt-ps')){ev.stopPropagation();return;}
          artistExpanded.has(r.key)?artistExpanded.delete(r.key):artistExpanded.add(r.key);
          renderGrouped(lw);
        });
        div.addEventListener('dblclick',ev=>{
          ev.stopPropagation();
          const ts=filtered.filter(t=>(t.artist||'(Artiste inconnu)')===r.artist);
          if(!ts.length) return;
          setPlayContext('artist',r.artist);
          queue=ts.map(t=>({...t,url:pathToUrl(t.path)}));
          playIdx(0); renderDockQueue();
        });
        div.addEventListener('contextmenu',ev=>{ev.preventDefault();const tracks=filtered.filter(t=>(t.artist||'(Artiste inconnu)')===r.artist);showGrpCtxMenu(ev,r.artist,'',`${albumsCt} album${albumsCt!==1?'s':''} · ${r.count} morceau${r.count!==1?'x':''}`,()=>tracks);});
        // Photo d'artiste désactivée — placeholder uniquement (mini covers réservés aux albums)
      } else {
        const open=albumExpanded.has(r.key);
        const artId='agA_'+r.key.replace(/[^a-z0-9]/gi,'_').slice(0,30);
        div.className='ag-row album-row';
        div.style.cssText=`top:${r.y}px;height:${rh}px`;
        const albumTracks = (r.tracks||[]).map(({t})=>t).filter(Boolean);
        // Artist · Genre · Year (matches Album-tab header)
        const m = r.albMeta || dominantMeta(r.tracks||[]);
        const subBits = [];
        if(m.artist) subBits.push(`<span class="r-artist">${esc(m.artist)}</span>`);
        if(m.genre)  subBits.push(`<span class="ag-genre-chip" data-genre="${(m.genre||'').replace(/"/g,'&quot;')}">${esc(m.genre)}</span>`);
        if(m.genreChild) subBits.push(`<span class="ag-child-chip" style="font-size:.82em;opacity:.7;padding:1px 6px;border:.5px solid var(--ln);border-radius:6px">${esc(m.genreChild)}</span>`);
        if(m.year)   subBits.push(`<span class="r-year">${esc(String(m.year))}</span>`);
        const subSep = ' <span style="color:var(--t3);opacity:.5">·</span> ';
      // Pour le split button album, on construit la clé "artistNorm||albumNorm"
      // cohérente avec _resolveSyncGroupTracks. Sauf qu'ici on est en biblio
      // (pas en sync), donc on utilise artist+album directs via _handleLibSplitButton.
      const _albId = `${r.artist}||${r.album}`;
      div.innerHTML=
          _groupSyncCellHTML(albumTracks)+
          `<div class="ag-content-mid">`+
            `<div class="ag-art" id="${artId}">...</div>`+
            `<div class="ag-info">`+
              `<div class="ag-name album">${esc(_displayAlbum(r.album))}</div>`+
              `<div class="ag-ct">${subBits.join(subSep)}</div>`+
            `</div>`+
          `</div>`+
          _splitButtonHTML('album:' + _albId)+
          _groupFavCellHTML(albumTracks);
        div.setAttribute('data-wt-ps-parent', '');
        div.addEventListener('click',ev=>{
          if(ev.target.closest('.ag-sync')){toggleGroupSync(albumTracks, ev);return;}
          if(ev.target.closest('.wt-ps')){ev.stopPropagation();return;}
          albumExpanded.has(r.key)?albumExpanded.delete(r.key):albumExpanded.add(r.key);
          renderGrouped(lw);
        });
        div.addEventListener('contextmenu',ev=>{ev.preventDefault();const tracks=(r.tracks||[]).map(({t})=>t);showGrpCtxMenu(ev,r.album,r.tracks?.[0]?.t?.artist||'',r.count+' titre'+(r.count!==1?'s':''),()=>tracks,true);});
        if(r.tracks?.[0]?.t){
          const tArr = r.tracks.map(x => x.t);
          setTimeout(()=>fetchPlArt(tArr[0], artId, tArr, 0), 80);
        }
      }
      frag.appendChild(div);
    });
    lw.appendChild(frag);
  }
  doRender();
  lw.onscroll=()=>{if(!raf){raf=true;requestAnimationFrame(()=>{doRender();raf=false;});}};
}

function playArtist(artist){
  const ts=filtered.filter(t=>(t.artist||'(Artiste inconnu)')===artist);
  if(!ts.length)return;
  setPlayContext('artist',artist);
  queue=ts.map(t=>({...t,url:pathToUrl(t.path)}));
  playIdx(0);
}
function playAlbum(artist,album){
  const ts=filtered.filter(t=>(t.artist||'(Artiste inconnu)')===artist&&(t.album||'(Album inconnu)')===album);
  if(!ts.length)return;
  setPlayContext('album',album);
  queue=ts.map(t=>({...t,url:pathToUrl(t.path)}));
  playIdx(0);
}

// ============================================================
// HELPERS PLAY / SHUFFLE UNIVERSELS
// ============================================================
// Helpers réutilisables par les boutons split (▶/🔀) dans le panneau Sync
// et la bibliothèque. Ils acceptent un tableau de tracks (déjà filtré par
// l'appelant : ex. tous les morceaux d'un artiste, d'un genre, du Sync, etc.)
// et lancent la lecture proprement avec le contexte adéquat.
//
// Pourquoi un helper plutôt que d'utiliser playArtist/playAlbum existants ?
// — ils sont couplés à `filtered` (état bibliothèque courant)
// — ils ne marchent pas si on est dans le panneau Sync (filtered = autre)
// — on veut un point d'entrée unique pour tous les cas d'usage

/**
 * Lance la lecture d'un groupe de morceaux dans l'ordre.
 * @param {Track[]} tracks Tableau de morceaux à jouer
 * @param {string}  ctxKind Type de contexte ('artist'/'album'/'genre'/'year'/'playlist'/'sync')
 * @param {string}  ctxLabel Libellé du contexte (nom artiste, nom album, etc.)
 */
function playGroup(tracks, ctxKind, ctxLabel) {
  if (!tracks || !tracks.length) {
    toast('Aucun morceau à jouer');
    return;
  }
  setPlayContext(ctxKind || 'group', ctxLabel || '');
  queue = tracks.map(t => ({ ...t, url: pathToUrl(t.path) }));
  _shuffleOrder = []; _shuffleCursor = 0;

  // L'user a cliqué ▶ : il veut une lecture séquentielle. On désactive le
  // mode shuffle global si actif, et on synchronise l'icône du player.
  if (shuffle) {
    shuffle = false;
    document.getElementById('pcSh')?.classList.remove('on');
    document.getElementById('miniSh')?.classList.remove('on');
  }

  qi = 0;
  playIdx(0);
  toast(`▶ ${ctxLabel || 'Lecture'} · ${tracks.length} morceau${tracks.length > 1 ? 'x' : ''}`);
}

function shuffleGroup(tracks, ctxKind, ctxLabel) {
  if (!tracks || !tracks.length) {
    toast('Aucun morceau à jouer');
    return;
  }
  setPlayContext(ctxKind || 'group', ctxLabel || '');
  queue = tracks.map(t => ({ ...t, url: pathToUrl(t.path) }));
  _shuffleOrder = []; _shuffleCursor = 0;

  // L'user a cliqué 🔀 : on ACTIVE le mode shuffle global. Sinon computeNext
  // ignore _shuffleOrder et fait qi+1 après le 1er morceau aléatoire (bug
  // "shuffle par artiste" perçu par l'user car le tableau est trié par
  // artiste à l'arrivée). Synchronise aussi l'icône du player principal.
  if (!shuffle) {
    shuffle = true;
    document.getElementById('pcSh')?.classList.add('on');
    document.getElementById('miniSh')?.classList.add('on');
  }

  qi = Math.floor(Math.random() * queue.length);
  if (typeof buildShuffleOrder === 'function') buildShuffleOrder();
  playIdx(qi);
  toast(`🔀 ${ctxLabel || 'Lecture aléatoire'} · ${tracks.length} morceau${tracks.length > 1 ? 'x' : ''}`);
}

// ============================================================
// SPLIT BUTTON ▶ / 🔀 — générateur HTML
// ============================================================
// Crée le HTML du composant split button pour les vues Sync et biblio.
// Le câblage JS se fait via délégation d'événements (cf. _attachSyncListeners).
//
// @param {string} dataId    Identifiant logique du groupe ('artist:Pink Floyd',
//                           'album:Pink Floyd||The Wall', 'track:/path/...').
//                           Encodé dans data-wt-ps-id, décodé par le handler.
// @param {Object} opts      { sm: true } pour la variante petit format
// @returns {string}         HTML inline

function _splitButtonHTML(dataId, opts = {}) {
  const cls = opts.sm ? 'wt-ps wt-ps-sm' : 'wt-ps';
  const safe = escapeHtmlAttr(dataId);
  return `
    <span class="${cls}" data-wt-ps-id="${safe}">
      <button class="wt-ps-play" data-wt-ps-action="play" title="Lecture" aria-label="Lecture">
        <svg viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M3 2 L10 6 L3 10 Z"/>
        </svg>
      </button>
      <button class="wt-ps-shuf" data-wt-ps-action="shuffle" title="Lecture aléatoire" aria-label="Lecture aléatoire">
        <svg viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M1 3 L4 3 L6 6 L8 9 L11 9 M9 7 L11 9 L9 11 M1 9 L4 9 L6 6 M9 5 L11 3 L9 1 M8 3 L11 3"/>
        </svg>
      </button>
    </span>`;
}

// ── SELECTION + BATCH ─────────────────────────────
let _lastSelectedIdx = -1;

function toggleSelect(path, index, e) {
  if (!e) {
    // Fallback si appelé sans événement
    selectedPaths.has(path) ? selectedPaths.delete(path) : selectedPaths.add(path);
  } 
  else if (e.shiftKey && _lastSelectedIdx !== -1) {
    // SHIFT CLIC : On sélectionne tout le bloc
    const start = Math.min(_lastSelectedIdx, index);
    const end = Math.max(_lastSelectedIdx, index);
    for (let i = start; i <= end; i++) {
      if (filtered[i]) selectedPaths.add(filtered[i].path);
    }
  } 
  else if (e.ctrlKey || e.metaKey) {
    // CTRL / CMD : On ajoute/retire un par un
    selectedPaths.has(path) ? selectedPaths.delete(path) : selectedPaths.add(path);
    _lastSelectedIdx = index;
  } 
  else {
    // CLIC SIMPLE : On vide tout et on sélectionne l'élu
    selectedPaths.clear();
    selectedPaths.add(path);
    _lastSelectedIdx = index;
  }

  updateSelBar(); 
  renderVirtual();
}

function clearSelection(){
  _lastSelectedIdx = -1; // On reset aussi le pivot
  selectedPaths.clear();
  updateSelBar();
  renderVirtual();
}

function updateSelBar(){ /* sel-bar removed — selection actions live in right-click menu (Batch B will add drag) */ }

// NEW: Accept 'ref' (the specific track clicked)
let _omniSpecificRef = null; // On crée une variable pour le morceau précis

// Snapshot des champs du formulaire, pris à l'ouverture de la fenêtre.
// Permet au bouton « revenir » de restaurer l'état initial du morceau.
let _omniOriginalSnapshot = null;
function _captureOmniSnapshot(){
  _omniOriginalSnapshot = {
    title:  document.getElementById('omniTitle')?.value  || '',
    artist: document.getElementById('omniArtist')?.value || '',
    album:  document.getElementById('omniAlbum')?.value  || '',
    year:   document.getElementById('omniYear')?.value   || '',
    style:  document.getElementById('omniStyle')?.value  || '',
    genre:  document.getElementById('omniGenre')?.value  || '',
   cover:  ((typeof _omniSpecificRef !== 'undefined' && _omniSpecificRef?.path && typeof customCovers !== 'undefined')
              ? customCovers[_omniSpecificRef.path] : null)
            || (typeof _omniSpecificRef !== 'undefined' && _omniSpecificRef?.cover) || null
  };
}
// Restaure le formulaire à l'état d'origine (annule un clic sur un match).
function restoreOmniOriginal(){
  if(!_omniOriginalSnapshot){ return; }
  const s = _omniOriginalSnapshot;
  const set = (id, v) => { const el = document.getElementById(id); if(el) el.value = v; };
  set('omniTitle', s.title);
  set('omniArtist', s.artist);
  set('omniAlbum', s.album);
  set('omniYear', s.year);
  set('omniStyle', s.style);
  set('omniGenre', s.genre);
  // Cover : on remet l'originale (ou rien) et on annule la cover en attente.
  _omniPendingCoverUrl = s.cover || null;
  const box = document.querySelector('.batch-box');
  if(box) box.style.setProperty('--omni-bg', s.cover ? `url('${s.cover}')` : 'none');
  if(typeof updateOmniPreview === 'function' && s.cover) updateOmniPreview(s.cover);
  if(typeof toast === 'function') toast('↩ Valeurs d\'origine restaurées');
}

function openBatch(t) {
  // Si on passe un morceau (clic droit sur un titre), on le prend. 
  // Sinon on prend le premier de la sélection.
  _omniSpecificRef = t || (allTracks.filter(x => selectedPaths.has(x.path))[0]);
  _omniTargetTracks = allTracks.filter(x => selectedPaths.has(x.path));
  
  if (!_omniSpecificRef) return;

  // Reset état hérité (bug #2 : la modale héritait du précédent track)
  const _omniResStrip = document.getElementById('omniResults');
  if (_omniResStrip) { _omniResStrip.innerHTML = ''; _omniResStrip.style.display = 'none'; }
  window._lastBestMatch = null;
  window._lastConsolidatedMeta = null;
  if (typeof _clearConsolidatedPickers === 'function') _clearConsolidatedPickers();

  // REMPLISSAGE PRÉCIS
  document.getElementById('omniTitle').value = _omniSpecificRef.title || "";
  document.getElementById('omniArtist').value = _omniSpecificRef.artist || "";
  document.getElementById('omniAlbum').value = _omniSpecificRef.album || "";
  document.getElementById('omniYear').value = _omniSpecificRef.year || "";
  document.getElementById('omniStyle').value = _omniSpecificRef.genreStyle || "";
  
  document.getElementById('omniSearchIn').value = _cleanMetaQuery(`${_omniSpecificRef.artist || ''} ${_omniSpecificRef.album || ''}`);
  // C223 : champ MORCEAU — artiste + titre (et non artiste + album)
  const _osT = document.getElementById('omniSearchTrack');
  if (_osT) _osT.value = `${_omniSpecificRef.artist || ''} ${_omniSpecificRef.title || ''}`.trim();
  
  if (_omniSpecificRef.cover) {
    document.querySelector('.batch-box').style.setProperty('--omni-bg', `url('${_omniSpecificRef.cover}')`);
  }
document.getElementById('batchOv').classList.add('on');
  document.body.classList.add('omni-open'); // floute le fullscreen derrière (cf. style.css)
  _captureOmniSnapshot();
}

// REMPLACER closeBatch par cette version
function closeBatch() {
  // Nettoyer l'intervalle de surveillance de la cover
  if (window._omniCleanup) {
    clearInterval(window._omniCleanup);
    window._omniCleanup = null;
  }
  // Réinitialiser l'état lié à la cover pour ne rien laisser fuiter
  // vers le morceau suivant (champ URL collée + cover en attente).
  _omniPendingCoverUrl = null;
  const urlField = document.getElementById('omniCoverUrl');
  if (urlField) urlField.value = '';
  _omniOriginalSnapshot = null;
 // Reset état modale (bug #2)
  const _omniResStrip = document.getElementById('omniResults');
  if (_omniResStrip) { _omniResStrip.innerHTML = ''; _omniResStrip.style.display = 'none'; }
  window._lastBestMatch = null;
  window._lastConsolidatedMeta = null;
  _omniSpecificRef = null;
  if (typeof _clearConsolidatedPickers === 'function') _clearConsolidatedPickers();
  document.getElementById('batchOv').classList.remove('on');
  document.body.classList.remove('omni-open');
}
function applyBatch(){
  const ts=allTracks.filter(t=>selectedPaths.has(t.path));
  const nA=document.getElementById('batchArtist').value.trim();
  const nAl=document.getElementById('batchAlbum').value.trim();
  const nG=document.getElementById('batchGenre').value.trim();
  const nY=document.getElementById('batchYear')?.value.trim()||'';
  const inherit=document.getElementById('batchInheritAlbum')?.checked;
  ts.forEach(t=>{if(nA)t.artist=nA;if(nAl)t.album=nAl;if(nG)t.genre=nG;if(nY&&!isNaN(parseInt(nY)))t.year=parseInt(nY);t._userModified=true;_clearUnidentifiedIfComplete(t);});
  // Album inheritance: apply to all tracks of the same album
  if(inherit&&(nG||nY)){
    const albums=new Set(ts.map(t=>t.album).filter(Boolean));
    let extra=0;
    allTracks.forEach(t=>{
      if(!selectedPaths.has(t.path)&&albums.has(t.album)){
        if(nG)t.genre=nG;
        if(nY&&!isNaN(parseInt(nY)))t.year=parseInt(nY);
        extra++;
      }
    });
    if(extra>0) toast(`✓ ${ts.length} sélectionnés + ${extra} de l'album mis à jour`);
    else toast(`✓ ${ts.length} morceau${ts.length!==1?'x':''} mis à jour`);
  } else {
    toast(`✓ ${ts.length} morceau${ts.length!==1?'x':''} mis à jour`);
  }
  closeBatch(); clearSelection();
  renderVirtual(); scheduleSave(); scheduleMetaSave();
}
document.getElementById('batchOv').addEventListener('click',e=>{if(e.target===document.getElementById('batchOv'))closeBatch();});
// Show album-inherit checkbox when genre or year is changed
function _batchCheckInherit(){
  const g=document.getElementById('batchGenre')?.value||'';
  const y=document.getElementById('batchYear')?.value||'';
  const row=document.getElementById('batchAlbumInheritRow');
  if(row) row.style.display=(g||y)?'':'none';
}
document.getElementById('batchGenre')?.addEventListener('change',_batchCheckInherit);
document.getElementById('batchYear')?.addEventListener('input',_batchCheckInherit);

// ── SORT ──────────────────────────────────────────
function sortBy(col){
  if(sortCol===col) sortAsc=!sortAsc; else {sortCol=col;sortAsc=(col!=='year');}
  ['num','title','artist','album','genre','year'].forEach(k=>{
    const el=document.getElementById('sh-'+k);
    if(!el) return;
    el.classList.toggle('sort-on',k===col);
    el.classList.toggle('sort-desc',k===col&&!sortAsc);
  });
  applySortToFiltered(); renderVirtual();
}

function applySortToFiltered(){
  if(sortCol==='num') return;
  const dir=sortAsc?1:-1;
  // Stable sort: uses index as tiebreaker to prevent inversions
  filtered=filtered.map((t,i)=>({t,i})).sort((a,b)=>{
    let cmp=0;
    if(sortCol==='title')  cmp=(a.t.title||'').localeCompare(b.t.title||'','fr',{sensitivity:'base'});
    else if(sortCol==='artist') cmp=(a.t.artist||'').localeCompare(b.t.artist||'','fr',{sensitivity:'base'});
    else if(sortCol==='album')  cmp=(a.t.album||'').localeCompare(b.t.album||'','fr',{sensitivity:'base'});
    else if(sortCol==='genre')  cmp=(a.t.genre||'').localeCompare(b.t.genre||'','fr',{sensitivity:'base'});
    else if(sortCol==='year')   cmp=(a.t.year||0)-(b.t.year||0);
    // Tiebreaker: original index (stable)
    return cmp!==0 ? dir*cmp : a.i-b.i;
  }).map(({t})=>t);
}

// Remplacez la fonction onSearch existante par celle-ci
function onSearch() {
  const q = document.getElementById('searchIn').value.trim().toLowerCase();
  const base = curPl >= 0 ? allLists[curPl].tracks : allTracks;
  
  if (!q) {
    filtered = [...base];
    if (curPl === -1) {
      document.querySelectorAll('.pl-item').forEach(el => el.classList.remove('on'));
    }
    applySortToFiltered();
    renderVirtual();
    updateBreadcrumb();
    return;
  }


// Wire up search box + outside click
document.addEventListener('DOMContentLoaded', () => {
  const s = document.getElementById('cfSearch');
  if(s) s.addEventListener('input', _cfRenderList);
  const c = document.getElementById('cfClear');
  if(c) c.addEventListener('click', () => { document.getElementById('cfSearch').value=''; _cfRenderList(); });
  document.addEventListener('mousedown', (ev) => {
    const dd = document.getElementById('colFilter');
    if(!dd?.classList.contains('on')) return;
    if(ev.target.closest('#colFilter')) return;
    if(ev.target.closest('[data-filterable]')) return;
    closeColFilter();
  });
});
  
  // Sépare les mots (ex: "slash sh" -> ["slash", "sh"])
  const words = q.split(/\s+/);
  
  filtered = base.filter(t => {
   const title = (t.title || '').toLowerCase();
    const artist = (t.artist || '').toLowerCase();
    const album = (t.album || '').toLowerCase();
    const genre = (t.genre || '').toLowerCase();
    const child = (t.genreChild || '').toLowerCase();
    const allText = title + ' ' + artist + ' ' + album + ' ' + genre + ' ' + child;
    
   // Règle 1: Contient la chaîne exacte (recherche normale)
    if (title.includes(q) || artist.includes(q) || album.includes(q) || genre.includes(q) || child.includes(q)) {
      return true;
    }
    
    // Règle 2: Recherche par mots avec début (ex: "sh" trouve "Shine", "Shadow")
    if (words.length === 1) {
      const singleWord = words[0];
      // Cherche si le mot commence par la recherche
      const titleWords = title.split(' ');
      const artistWords = artist.split(' ');
      const albumWords = album.split(' ');
      
      for (const w of titleWords) {
        if (w.startsWith(singleWord)) return true;
      }
      for (const w of artistWords) {
        if (w.startsWith(singleWord)) return true;
      }
      for (const w of albumWords) {
        if (w.startsWith(singleWord)) return true;
      }
      return false;
    }
    
    // Règle 3: Deux mots ou plus (ex: "slash sh")
    if (words.length >= 2) {
      // Chaque mot doit être trouvé (soit contenu, soit début de mot)
      let allMatch = true;
      
      for (let i = 0; i < words.length; i++) {
        const word = words[i];
        let found = false;
        
        // Premier mot: cherche dans tout le texte (contient)
        if (i === 0) {
          if (allText.includes(word)) found = true;
        } 
        // Deuxième mot et plus: cherche en début de mot seulement
        else {
          const titleWords = title.split(' ');
          const artistWords = artist.split(' ');
          const albumWords = album.split(' ');
          
          for (const w of titleWords) {
            if (w.startsWith(word)) { found = true; break; }
          }
          if (!found) {
            for (const w of artistWords) {
              if (w.startsWith(word)) { found = true; break; }
            }
          }
          if (!found) {
            for (const w of albumWords) {
              if (w.startsWith(word)) { found = true; break; }
            }
          }
        }
        
        if (!found) {
          allMatch = false;
          break;
        }
      }
      
      if (allMatch) return true;
    }
    
    return false;
  });
  
  if (q) {
    curPl = -1;
    document.querySelectorAll('.pl-item').forEach(el => el.classList.remove('on'));
  }
  
  applySortToFiltered();
  renderVirtual();
  updateBreadcrumb();
}

// ── AUTO GENRE DETECTION ────────────────────────────
// Uses MusicBrainz (free, no API key) to find artist genre.
// Le mapping réel des tags → 15 buckets est fait par clientMapGenre() défini
// plus bas (CLIENT_GENRE_MAP). mapToGenre15 n'est qu'un wrapper qui retourne
// null (et non le genre original) si pas de match — signature attendue par
// les fetchers MusicBrainz/iTunes.
const _genreCache=new Map();
// Le <select> « genre global » fusionne classique + bandes originales sous un
// SEUL libellé « Classical, Opera & Score ». Les buckets internes « Classical &
// Opera » / « Soundtrack & Score » doivent donc viser cette option du select.
function _genreToSelectOption(g) {
  if (g === 'Classical & Opera' || g === 'Soundtrack & Score') return 'Classical, Opera & Score';
  return g;
}
// Affichage album : nettoie les artefacts d'import (« _ » qui remplaçait « : »
// ou « / ») SANS toucher le tag d'origine — t.album reste intact pour le
// matching réseau et la persistance sidecar. Purement cosmétique au rendu.
function _displayAlbum(album){
  if(!album) return '';
  return String(album)
    .replace(/_+(?=\s)/g, ':')   // « Grieg_ Holberg Suite » → « Grieg: Holberg Suite »
    .replace(/_+/g, ' ')          // « AC_DC » → « AC DC »
    .replace(/\s{2,}/g, ' ')
    .trim();
}
function mapToGenre15(raw){
  // clientMapGenre peut retourner null ou le bucket canonique
  const mapped = (typeof clientMapGenre === 'function') ? clientMapGenre(raw) : null;
  return mapped || null;
}



// Source pour les métadonnées MusicBrainz (genre + année)




// Source pour les métadonnées Deezer
async function fetchDeezerMeta(album, artist) {
  try {
    const q = encodeURIComponent(`${artist || ''} ${album || ''}`);
    const res = await fetch(`https://api.deezer.com/search/album?q=${q}&limit=1`);
    const data = await res.json();
    const item = data.data?.[0];
    if (!item) return { genre: null, year: null };
    
    let year = null;
    if (item.release_date) {
      const y = parseInt(item.release_date.split('-')[0]);
     if (!isNaN(y) && y > 1400) year = y;
    }
    
    // Deezer a un champ 'genre_id' mais pas de texte direct - fallback
    return { genre: null, year };
  } catch { return { genre: null, year: null }; }
}

async function fetchAlbumMetaItunes(album, artist, cacheKey){
  try {
    const q=encodeURIComponent((artist?artist+' ':'')+album);
    const url=`https://itunes.apple.com/search?term=${q}&entity=album&limit=1`;
    const res=await fetch(url);
    if(!res.ok) return {genre:null,year:null};
    const data=await res.json();
    const item=data.results?.[0];
    if(!item) return {genre:null,year:null};
    const rawGenre=item.primaryGenreName||'';
    const genre=mapToGenre15(rawGenre)||null;
    // iTunes releaseDate = date de publication sur iTunes, donc potentiellement
    // la réédition. On accepte car c'est notre dernier recours, mais on clamp.
    const currentYear = new Date().getFullYear();
    const yearStr=item.releaseDate||'';
    const ym=yearStr.match(/^(1[6-9]\d{2}|20\d{2})/);
    let year = null;
    if(ym){
      const y = parseInt(ym[1]);
      if(y >= 1600 && y <= currentYear) year = y;
    }
    const result={genre,year};
    if(cacheKey) _genreCache.set(cacheKey, result);
    return result;
  } catch { return {genre:null,year:null}; }
}

// Legacy wrapper
async function fetchAlbumGenre(album, artist){
  const {genre}=await fetchAlbumMeta(album,artist);
  return genre;
}


// ── AUTO-FILL LOCAL: album-based inheritance ─────────────────────
// ── CLIENT-SIDE GENRE NORMALIZER ─────────────────────────────────
// Même logique que GENRE_MAP_15 dans main.js — garde les deux en sync
// 15 buckets universels couvrant l'histoire de la musique.
const CLIENT_GENRE_MAP = {
  // 1 — Blues & Gospel
  blues:'Blues, Roots & Gospel', 'delta blues':'Blues, Roots & Gospel', 'electric blues':'Blues, Roots & Gospel',
  'chicago blues':'Blues, Roots & Gospel', 'country blues':'Blues, Roots & Gospel', 'rhythm and blues':'Blues, Roots & Gospel',
  'blues rock':'Blues, Roots & Gospel', 'blues revival':'Blues, Roots & Gospel',
  gospel:'Blues, Roots & Gospel', 'black gospel':'Blues, Roots & Gospel', 'contemporary gospel':'Blues, Roots & Gospel',
  spirituals:'Blues, Roots & Gospel', 'negro spirituals':'Blues, Roots & Gospel', roots:'Blues, Roots & Gospel',

  // 2 — Jazz & Swing
  jazz:'Jazz & Swing', bebop:'Jazz & Swing', 'be-bop':'Jazz & Swing',
  'hard bop':'Jazz & Swing', 'post-bop':'Jazz & Swing', 'cool jazz':'Jazz & Swing',
  'free jazz':'Jazz & Swing', 'avant-garde jazz':'Jazz & Swing', 'modal jazz':'Jazz & Swing',
  'jazz fusion':'Jazz & Swing', fusion:'Jazz & Swing', 'smooth jazz':'Jazz & Swing',
  'soul jazz':'Jazz & Swing', 'acid jazz':'Jazz & Swing', 'nu jazz':'Jazz & Swing',
  'big band':'Jazz & Swing', swing:'Jazz & Swing', 'vocal jazz':'Jazz & Swing',
  ragtime:'Jazz & Swing', dixieland:'Jazz & Swing',

  // 3 — Soul, Funk & Disco
  soul:'Soul, Funk & Disco', 'northern soul':'Soul, Funk & Disco', 'southern soul':'Soul, Funk & Disco',
  'doo wop':'Soul, Funk & Disco', 'doo-wop':'Soul, Funk & Disco', doowop:'Soul, Funk & Disco',
  'vocal group':'Soul, Funk & Disco', 'vocal harmony':'Soul, Funk & Disco',
  'classic soul':'Soul, Funk & Disco', motown:'Soul, Funk & Disco', 'philly soul':'Soul, Funk & Disco',
  funk:'Soul, Funk & Disco', 'p-funk':'Soul, Funk & Disco', 'g-funk':'Soul, Funk & Disco',
  'funk rock':'Soul, Funk & Disco', 'jazz-funk':'Soul, Funk & Disco',
  disco:'Soul, Funk & Disco', 'nu-disco':'Soul, Funk & Disco', 'post-disco':'Soul, Funk & Disco',
  boogie:'Soul, Funk & Disco', groove:'Soul, Funk & Disco',
  'neo soul':'Soul, Funk & Disco', 'neo-soul':'Soul, Funk & Disco',

  // 4 — Classic & Hard Rock
  'classic rock':'Classic Rock & Hard Rock', 'hard rock':'Classic Rock & Hard Rock',
  'progressive rock':'Classic Rock & Hard Rock', 'prog rock':'Classic Rock & Hard Rock',
  'psychedelic rock':'Classic Rock & Hard Rock', psychedelia:'Classic Rock & Hard Rock',
  'arena rock':'Classic Rock & Hard Rock', 'glam rock':'Classic Rock & Hard Rock',
  'southern rock':'Classic Rock & Hard Rock', 'pub rock':'Classic Rock & Hard Rock',
  'rock and roll':'Classic Rock & Hard Rock', rockabilly:'Classic Rock & Hard Rock',
  'heartland rock':'Classic Rock & Hard Rock', 'stadium rock':'Classic Rock & Hard Rock',
  rock:'Classic Rock & Hard Rock',

  // 5 — Punk & Alternative
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

  // 6 — Metal
  'heavy metal':'Heavy Metal & Loud', 'death metal':'Heavy Metal & Loud', 'black metal':'Heavy Metal & Loud',
  'thrash metal':'Heavy Metal & Loud', 'doom metal':'Heavy Metal & Loud', 'power metal':'Heavy Metal & Loud',
  'speed metal':'Heavy Metal & Loud', 'symphonic metal':'Heavy Metal & Loud', 'folk metal':'Heavy Metal & Loud',
  'progressive metal':'Heavy Metal & Loud', 'prog metal':'Heavy Metal & Loud',
  metalcore:'Heavy Metal & Loud', deathcore:'Heavy Metal & Loud', 'nu metal':'Heavy Metal & Loud',
  djent:'Heavy Metal & Loud', 'stoner metal':'Heavy Metal & Loud', 'sludge metal':'Heavy Metal & Loud',
  hardcore:'Heavy Metal & Loud', 'groove metal':'Heavy Metal & Loud', doom:'Heavy Metal & Loud', stoner:'Heavy Metal & Loud',
  metal:'Heavy Metal & Loud',

  // 7 — Hip-Hop & Rap
  'hip hop':'Hip-Hop & Rap Culture', 'hip-hop':'Hip-Hop & Rap Culture',
  rap:'Hip-Hop & Rap Culture', 'gangsta rap':'Hip-Hop & Rap Culture',
  trap:'Hip-Hop & Rap Culture', 'cloud rap':'Hip-Hop & Rap Culture', drill:'Hip-Hop & Rap Culture',
  grime:'Hip-Hop & Rap Culture', 'boom bap':'Hip-Hop & Rap Culture',
  'old school hip hop':'Hip-Hop & Rap Culture', 'golden age hip hop':'Hip-Hop & Rap Culture',
  'east coast hip hop':'Hip-Hop & Rap Culture', 'west coast hip hop':'Hip-Hop & Rap Culture',
  'conscious hip hop':'Hip-Hop & Rap Culture', 'alternative hip hop':'Hip-Hop & Rap Culture',
  'rap français':'Hip-Hop & Rap Culture', 'french rap':'Hip-Hop & Rap Culture',

  // 8 — R&B, Pop & Dance
  'r&b':'R&B, Pop & Dance', 'rhythm & blues':'R&B, Pop & Dance',
  'contemporary r&b':'R&B, Pop & Dance', 'alternative r&b':'R&B, Pop & Dance',
  'urban contemporary':'R&B, Pop & Dance', 'quiet storm':'R&B, Pop & Dance',
  pop:'R&B, Pop & Dance', 'dance pop':'R&B, Pop & Dance', electropop:'R&B, Pop & Dance',
  'teen pop':'R&B, Pop & Dance', 'power pop':'R&B, Pop & Dance', 'art pop':'R&B, Pop & Dance',
  'synth pop':'R&B, Pop & Dance', 'synth-pop':'R&B, Pop & Dance', synthpop:'R&B, Pop & Dance',
  hyperpop:'R&B, Pop & Dance', 'bedroom pop':'R&B, Pop & Dance', 'indie pop':'R&B, Pop & Dance',
  'chamber pop':'R&B, Pop & Dance', 'k-pop':'R&B, Pop & Dance', 'j-pop':'R&B, Pop & Dance',
  'adult contemporary':'R&B, Pop & Dance', 'new jack swing':'R&B, Pop & Dance',

  // 9 — Folk & Country
  folk:'Folk, Country & Americana', 'folk rock':'Folk, Country & Americana', 'contemporary folk':'Folk, Country & Americana',
  'traditional folk':'Folk, Country & Americana', 'indie folk':'Folk, Country & Americana', 'anti-folk':'Folk, Country & Americana',
  country:'Folk, Country & Americana', 'alt-country':'Folk, Country & Americana', 'alternative country':'Folk, Country & Americana',
  'country rock':'Folk, Country & Americana', 'country pop':'Folk, Country & Americana',
  'outlaw country':'Folk, Country & Americana', 'honky tonk':'Folk, Country & Americana',
  bluegrass:'Folk, Country & Americana', newgrass:'Folk, Country & Americana',
  americana:'Folk, Country & Americana', 'appalachian music':'Folk, Country & Americana',
  'singer-songwriter':'Folk, Country & Americana', 'singer songwriter':'Folk, Country & Americana',
  acoustic:'Folk, Country & Americana',

  // 10 — Ambient & Chill
  ambient:'Ambient, New Age & Chill', 'dark ambient':'Ambient, New Age & Chill', 'ambient techno':'Ambient, New Age & Chill',
  'new age':'Ambient, New Age & Chill', drone:'Ambient, New Age & Chill', 'drone music':'Ambient, New Age & Chill',
  'minimal music':'Ambient, New Age & Chill', minimalism:'Ambient, New Age & Chill',
  meditation:'Ambient, New Age & Chill', 'healing music':'Ambient, New Age & Chill',
  chill:'Ambient, New Age & Chill', 'chill-out':'Ambient, New Age & Chill', chillout:'Ambient, New Age & Chill',
  'lo-fi':'Ambient, New Age & Chill', lofi:'Ambient, New Age & Chill', 'lo fi':'Ambient, New Age & Chill',
  chillhop:'Ambient, New Age & Chill', 'lo-fi hip hop':'Ambient, New Age & Chill', 'lo-fi beats':'Ambient, New Age & Chill',
  downtempo:'Ambient, New Age & Chill', 'trip hop':'Ambient, New Age & Chill', 'trip-hop':'Ambient, New Age & Chill',
  chillwave:'Ambient, New Age & Chill',

  // 11 — Electronic & Techno
  electronic:'Electronic, House & Techno', 'electronic music':'Electronic, House & Techno', electronica:'Electronic, House & Techno',
  techno:'Electronic, House & Techno', 'minimal techno':'Electronic, House & Techno', 'melodic techno':'Electronic, House & Techno',
  'detroit techno':'Electronic, House & Techno', 'acid techno':'Electronic, House & Techno',
  house:'Electronic, House & Techno', 'deep house':'Electronic, House & Techno', 'tech house':'Electronic, House & Techno',
  'progressive house':'Electronic, House & Techno', 'afro house':'Electronic, House & Techno',
  'melodic house':'Electronic, House & Techno', 'acid house':'Electronic, House & Techno', 'electro house':'Electronic, House & Techno',
  edm:'Electronic, House & Techno', 'dance music':'Electronic, House & Techno', 'electronic dance':'Electronic, House & Techno',
  idm:'Electronic, House & Techno', 'drum and bass':'Electronic, House & Techno', 'drum & bass':'Electronic, House & Techno',
  dnb:'Electronic, House & Techno', dubstep:'Electronic, House & Techno', 'future bass':'Electronic, House & Techno',
  trance:'Electronic, House & Techno', psytrance:'Electronic, House & Techno', 'big beat':'Electronic, House & Techno',
  breakbeat:'Electronic, House & Techno', club:'Electronic, House & Techno',
  synthwave:'Electronic, House & Techno', 'synth wave':'Electronic, House & Techno',
  darksynth:'Electronic, House & Techno', vaporwave:'Electronic, House & Techno', retrowave:'Electronic, House & Techno',
  'italo disco':'Electronic, House & Techno', 'future pop':'Electronic, House & Techno', acid:'Electronic, House & Techno',

  // 12 — Reggae, Dub & Ska
  reggae:'Reggae, Dub & Ska', 'roots reggae':'Reggae, Dub & Ska', 'reggae fusion':'Reggae, Dub & Ska',
  'lovers rock':'Reggae, Dub & Ska',
  dub:'Reggae, Dub & Ska', 'dub music':'Reggae, Dub & Ska', 'dub reggae':'Reggae, Dub & Ska',
  ska:'Reggae, Dub & Ska', 'two tone':'Reggae, Dub & Ska',
  rocksteady:'Reggae, Dub & Ska', dancehall:'Reggae, Dub & Ska', ragga:'Reggae, Dub & Ska',

  // 13 — Latin, Caribbean, Flamenco, Tango
  latin:'Latin, Caribbean, Flamenco, Tango', 'latin pop':'Latin, Caribbean, Flamenco, Tango', 'latin rock':'Latin, Caribbean, Flamenco, Tango',
  salsa:'Latin, Caribbean, Flamenco, Tango', reggaeton:'Latin, Caribbean, Flamenco, Tango', bachata:'Latin, Caribbean, Flamenco, Tango',
  merengue:'Latin, Caribbean, Flamenco, Tango', cumbia:'Latin, Caribbean, Flamenco, Tango', 'latin jazz':'Latin, Caribbean, Flamenco, Tango',
  'latin trap':'Latin, Caribbean, Flamenco, Tango', 'latin alternative':'Latin, Caribbean, Flamenco, Tango',
  tango:'Latin, Caribbean, Flamenco, Tango', bolero:'Latin, Caribbean, Flamenco, Tango', mariachi:'Latin, Caribbean, Flamenco, Tango',
  ranchera:'Latin, Caribbean, Flamenco, Tango', banda:'Latin, Caribbean, Flamenco, Tango',
  samba:'Latin, Caribbean, Flamenco, Tango', 'bossa nova':'Latin, Caribbean, Flamenco, Tango', bossa:'Latin, Caribbean, Flamenco, Tango',
  mpb:'Latin, Caribbean, Flamenco, Tango', tropicalia:'Latin, Caribbean, Flamenco, Tango',
  brazilian:'Latin, Caribbean, Flamenco, Tango', brazil:'Latin, Caribbean, Flamenco, Tango', brasil:'Latin, Caribbean, Flamenco, Tango',
  'brazilian pop':'Latin, Caribbean, Flamenco, Tango', 'brazilian jazz':'Latin, Caribbean, Flamenco, Tango',
  'musica brasileira':'Latin, Caribbean, Flamenco, Tango', 'música brasileira':'Latin, Caribbean, Flamenco, Tango',
  pagode:'Latin, Caribbean, Flamenco, Tango', forro:'Latin, Caribbean, Flamenco, Tango', 'forró':'Latin, Caribbean, Flamenco, Tango',
  axe:'Latin, Caribbean, Flamenco, Tango', 'axé':'Latin, Caribbean, Flamenco, Tango', sertanejo:'Latin, Caribbean, Flamenco, Tango',
  choro:'Latin, Caribbean, Flamenco, Tango', 'baile funk':'Latin, Caribbean, Flamenco, Tango', 'funk carioca':'Latin, Caribbean, Flamenco, Tango',
  calypso:'Latin, Caribbean, Flamenco, Tango', soca:'Latin, Caribbean, Flamenco, Tango', zouk:'Latin, Caribbean, Flamenco, Tango',
  kizomba:'Latin, Caribbean, Flamenco, Tango', compas:'Latin, Caribbean, Flamenco, Tango',

  // 14 — Afrobeat & World
  afrobeat:'Afrobeat, African & World', afrobeats:'Afrobeat, African & World', afropop:'Afrobeat, African & World',
  'afro-pop':'Afrobeat, African & World', 'afro-fusion':'Afrobeat, African & World', afroswing:'Afrobeat, African & World',
  highlife:'Afrobeat, African & World', juju:'Afrobeat, African & World',
  'ethio-jazz':'Afrobeat, African & World', 'ethiopian jazz':'Afrobeat, African & World',
  mbaqanga:'Afrobeat, African & World', soukous:'Afrobeat, African & World', benga:'Afrobeat, African & World',
  amapiano:'Afrobeat, African & World', gqom:'Afrobeat, African & World', kwaito:'Afrobeat, African & World',
  world:'Afrobeat, African & World', 'world music':'Afrobeat, African & World', worldbeat:'Afrobeat, African & World',
  traditional:'Afrobeat, African & World', ethnic:'Afrobeat, African & World',
  celtic:'Afrobeat, African & World', flamenco:'Afrobeat, African & World',
  'middle eastern':'Afrobeat, African & World', arabic:'Afrobeat, African & World',
  bollywood:'Afrobeat, African & World', bhangra:'Afrobeat, African & World',
  gnawa:'Afrobeat, African & World', mbalax:'Afrobeat, African & World',

 // 15 — Classical & Opera
  classical:'Classical & Opera', 'classical music':'Classical & Opera',
  'neo-classical':'Classical & Opera', neoclassical:'Classical & Opera', 'neo classical':'Classical & Opera',
  'modern classical':'Classical & Opera', 'contemporary classical':'Classical & Opera',
  'early music':'Classical & Opera', medieval:'Classical & Opera', renaissance:'Classical & Opera',
  baroque:'Classical & Opera', romantic:'Classical & Opera',
  'chamber music':'Classical & Opera', orchestral:'Classical & Opera', symphony:'Classical & Opera',
  symphonic:'Classical & Opera', concerto:'Classical & Opera', sonata:'Classical & Opera',
  opera:'Classical & Opera', operetta:'Classical & Opera',
  choral:'Classical & Opera', piano:'Classical & Opera',
  instrumental:'Classical & Opera', 'post-minimalism':'Classical & Opera',
  'classical, opera & score':'Classical & Opera',
  // 16 — Soundtrack & Score
  soundtrack:'Soundtrack & Score', 'film score':'Soundtrack & Score', score:'Soundtrack & Score',
  cinematic:'Soundtrack & Score', 'film music':'Soundtrack & Score',
  'game music':'Soundtrack & Score', 'video game music':'Soundtrack & Score', vgm:'Soundtrack & Score',
  'original soundtrack':'Soundtrack & Score', ost:'Soundtrack & Score', 'epic music':'Soundtrack & Score',
  // 17 — Chanson & Variété
  chanson:'Chanson & Variété',
  'chanson française':'Chanson & Variété', 'chanson francaise':'Chanson & Variété',
  'chanson à texte':'Chanson & Variété', 'chanson a texte':'Chanson & Variété',
  'chanson réaliste':'Chanson & Variété', 'chanson realiste':'Chanson & Variété',
  'nouvelle chanson française':'Chanson & Variété', 'nouvelle chanson francaise':'Chanson & Variété',
  'variété française':'Chanson & Variété', 'variete francaise':'Chanson & Variété',
  'variété':'Chanson & Variété', 'variete':'Chanson & Variété',
  'french pop':'Chanson & Variété', 'french chanson':'Chanson & Variété',
  'yé-yé':'Chanson & Variété', 'ye-ye':'Chanson & Variété', yeye:'Chanson & Variété',
  musette:'Chanson & Variété', 'bal-musette':'Chanson & Variété',
  // orphelins observés
  'musica tropical':'Latin, Caribbean, Flamenco, Tango', 'música tropical':'Latin, Caribbean, Flamenco, Tango', tropical:'Latin, Caribbean, Flamenco, Tango',
};

// Liste canonique des 15 buckets (ordre d'affichage dans la sidebar)
const GENRE_15_LIST = [
  'Blues, Roots & Gospel','Jazz & Swing','Soul, Funk & Disco','Classic Rock & Hard Rock',
  'Punk, Grunge & Alternative','Heavy Metal & Loud','Hip-Hop & Rap Culture','R&B, Pop & Dance',
  'Folk, Country & Americana','Ambient, New Age & Chill','Electronic, House & Techno','Reggae, Dub & Ska',
  'Latin, Caribbean, Flamenco, Tango','Afrobeat, African & World','Classical & Opera','Soundtrack & Score',
  'Chanson & Variété'
];

// ── TAXONOMIE ENFANTS (16 parents → sous-genres) ────────────────────────────
// Chaque enfant : { parent, intensity 1..3, dance bool }.
// intensity/dance sont DORMANTS pour l'instant (réservés aux futures smart
// playlists FOCUS=1 / ENERGY=3 / DANCE=dance) — non affichés dans l'UI.
// Le parent reste la seule donnée qui pilote couleur / fullscreen / tri.
const CHILD_GENRES = {
  // Blues, Roots & Gospel
  'Delta Blues / Acoustic':            { parent:'Blues, Roots & Gospel', intensity:1},
  'Electric Blues / Chicago':          { parent:'Blues, Roots & Gospel', intensity:2},
  'Gospel':                            { parent:'Blues, Roots & Gospel', intensity:2},
  // Jazz & Swing
  'Cool Jazz / Vocal Jazz':            { parent:'Jazz & Swing', intensity:1},
  'Hard Bop / Modal':                  { parent:'Jazz & Swing', intensity:2},
  'Gypsy Jazz / Swing':                { parent:'Jazz & Swing', intensity:2},
  // Soul, Funk & Disco
  'Classic Soul / Neo-Soul':           { parent:'Soul, Funk & Disco', intensity:1},
  'Funk':                              { parent:'Soul, Funk & Disco', intensity:2},
  'Disco':                             { parent:'Soul, Funk & Disco', intensity:3},
  // Classic Rock & Hard Rock
  'Psychedelic 60s/70s':               { parent:'Classic Rock & Hard Rock', intensity:1},
  'Classic Rock / Arena':              { parent:'Classic Rock & Hard Rock', intensity:2},
  'Hard Rock':                         { parent:'Classic Rock & Hard Rock', intensity:3},
  // Punk, Grunge & Alternative
  'Indie Rock / Dream Pop / Shoegaze': { parent:'Punk, Grunge & Alternative', intensity:1},
  'Art Rock / Post-Rock':              { parent:'Punk, Grunge & Alternative', intensity:1},
  'Grunge / Post-Punk / Noise':        { parent:'Punk, Grunge & Alternative', intensity:2},
  'Punk Rock / Hardcore':              { parent:'Punk, Grunge & Alternative', intensity:3},
  // Heavy Metal & Loud
  'Heavy Metal / Power Metal':         { parent:'Heavy Metal & Loud', intensity:2},
  'Progressive Metal':                 { parent:'Heavy Metal & Loud', intensity:2},
  'Stoner / Sludge / Doom':            { parent:'Heavy Metal & Loud', intensity:2},
  'Thrash / Death / Black Metal':      { parent:'Heavy Metal & Loud', intensity:3},
  // Hip-Hop & Rap Culture
  'Lo-Fi / Jazz Hop':                  { parent:'Hip-Hop & Rap Culture', intensity:1},
  'Boom Bap / Classic Rap':            { parent:'Hip-Hop & Rap Culture', intensity:2},
  'Modern Rap / Trap':                 { parent:'Hip-Hop & Rap Culture', intensity:3},
  // R&B, Pop & Dance
  'Synth-Pop / New Wave':              { parent:'R&B, Pop & Dance', intensity:2},
  'Mainstream Pop':                    { parent:'R&B, Pop & Dance', intensity:2},
  'Club / Eurodance':                  { parent:'R&B, Pop & Dance', intensity:3},
  // Folk, Country & Americana
  'Indie Folk / Acoustic':             { parent:'Folk, Country & Americana', intensity:1},
  'Traditional Folk / Bluegrass':      { parent:'Folk, Country & Americana', intensity:2},
  'Country':                           { parent:'Folk, Country & Americana', intensity:2},
  // Ambient, New Age & Chill
  'Ambient / Drone':                   { parent:'Ambient, New Age & Chill', intensity:1},
  'New Age / Neoclassical':            { parent:'Ambient, New Age & Chill', intensity:1},
  // Electronic, House & Techno
  'Downtempo / Trip-Hop':              { parent:'Electronic, House & Techno', intensity:1},
  'Synthwave / Retrowave':             { parent:'Electronic, House & Techno', intensity:2},
  'House / Deep House':                { parent:'Electronic, House & Techno', intensity:2},
  'Techno / Acid / Trance':            { parent:'Electronic, House & Techno', intensity:3},
  // Reggae, Dub & Ska
  'Roots Reggae / Lovers Rock':        { parent:'Reggae, Dub & Ska', intensity:2},
  'Dub':                               { parent:'Reggae, Dub & Ska', intensity:2},
  'Ska / Rocksteady':                  { parent:'Reggae, Dub & Ska', intensity:2},
  // Latin, Caribbean, Flamenco, Tango
  'Bossa Nova / Samba-Canção':         { parent:'Latin, Caribbean, Flamenco, Tango', intensity:1},
  'Tango / Nuevo Tango':               { parent:'Latin, Caribbean, Flamenco, Tango', intensity:1},
  'Salsa / Bachata / Merengue / Mambo':{ parent:'Latin, Caribbean, Flamenco, Tango', intensity:2},
  'Reggaeton / Dembow / Latin Trap':   { parent:'Latin, Caribbean, Flamenco, Tango', intensity:3},
  // Afrobeat, African & World
  'Flamenco / Nuevo Flamenco':         { parent:'Afrobeat, African & World', intensity:2},
  'Indian Classical':                  { parent:'Afrobeat, African & World', intensity:1},
  'Afrobeat / Highlife':               { parent:'Afrobeat, African & World', intensity:2},
  'Desert Blues / Tuareg Rock':        { parent:'Afrobeat, African & World', intensity:2},
  'Balkan / Klezmer / Celtic Trad':    { parent:'Afrobeat, African & World', intensity:2},
  // Classical & Opera
  'Orchestral / Opera':                { parent:'Classical & Opera', intensity:2},
  'Solo Instrument / Chamber':         { parent:'Classical & Opera', intensity:1},
  // Soundtrack & Score
  'Atmospheric / Ambient Score':       { parent:'Soundtrack & Score', intensity:1},
  'Epic / Action Soundtrack':          { parent:'Soundtrack & Score', intensity:3},
  // Chanson & Variété
  'Chanson française':                 { parent:'Chanson & Variété', intensity:1},
  'Variété française / Pop FR':        { parent:'Chanson & Variété', intensity:2},
};

// parent → liste de ses enfants (pour le dropdown groupé de la modale de revue)
const CHILDREN_BY_PARENT = (() => {
  const out = {};
  GENRE_15_LIST.forEach(p => { out[p] = []; });
  Object.keys(CHILD_GENRES).forEach(name => {
    const p = CHILD_GENRES[name].parent;
    if (!out[p]) out[p] = [];
    out[p].push(name);
  });
  return out;
})();

// Retourne le parent canonique d'un enfant, ou null si inconnu.
function genreParentOf(child){
  if (!child) return null;
  const e = CHILD_GENRES[child];
  return e ? e.parent : null;
}

// Intensité (1..3) d'un enfant — dormant, réservé aux smart playlists par seuil.
function genreIntensity(child){
  const e = child ? CHILD_GENRES[child] : null;
  return e ? e.intensity : null;
}

// ── GARANT UNIVERSEL enfant → parent ─────────────────────────────────────────
// Tout enfant (canonique, brut fetché, ou saisi par l'utilisateur) DOIT obtenir
// un parent. Overrides appris persistés en localStorage (réutilisés au prochain
// boot) — c'est ce qui rend le système apprenant plutôt que figé.
let _childParentOverrides = (() => {
  try { return JSON.parse(localStorage.getItem('wt_child_parent_overrides') || '{}') || {}; }
  catch(e){ return {}; }
})();
function _saveChildParentOverrides(){
  try { localStorage.setItem('wt_child_parent_overrides', JSON.stringify(_childParentOverrides)); } catch(e){}
}
// Enregistre/écrase l'association apprise enfant → parent (choix utilisateur).
function setChildParent(child, parent){
  if(!child || !parent) return false;
  if(GENRE_15_LIST.indexOf(parent) === -1) return false; // parent doit être un des 16
  _childParentOverrides[String(child).toLowerCase().trim()] = parent;
  _saveChildParentOverrides();
  return true;
}
// Résout le parent d'un enfant. Renvoie le parent (string) ou null si indécidable
// — auquel cas l'appelant DOIT demander un parent à l'utilisateur (jamais d'orphelin).
function resolveChildParent(child){
  if(!child) return null;
  const key = String(child).toLowerCase().trim();
  // 1) override appris (priorité absolue : c'est un choix utilisateur)
  if(_childParentOverrides[key]) return _childParentOverrides[key];
  // 2) enfant canonique connu
  const direct = (typeof genreParentOf==='function') ? genreParentOf(child) : null;
  if(direct) return direct;
  // 3) le brut matche une signature d'enfant connue → parent de cet enfant
  if(typeof clientMapChild==='function'){
    const canon = clientMapChild(child);
    if(canon){ const p = genreParentOf(canon); if(p) return p; }
  }
  // 4) le texte de l'enfant est lui-même un mot-genre reconnaissable → parent
  if(typeof clientMapGenre==='function'){
    const p = clientMapGenre(child);
    if(p && GENRE_15_LIST.indexOf(p) !== -1) return p;
  }
  // 5) indécidable → l'UI doit imposer un choix de parent
  return null;
}
// Pose un enfant sur un track en garantissant un parent cohérent. Si aucun
// parent n'est résolu et qu'aucun n'est fourni, on REFUSE (retourne false) :
// pas de parent ⇒ pas d'enfant. Si parentHint est fourni par l'UI, il fait foi
// et l'association est apprise pour la suite.
function assignChildToTrack(t, child, parentHint){
  if(!t || !child) return false;
  let parent = parentHint || resolveChildParent(child);
  if(!parent) return false;                 // orphelin interdit
  if(parentHint) setChildParent(child, parentHint);
  t.genre = parent;
  t.genreChild = child;
  return true;
}

// Mappe un genre brut (tag MusicBrainz/Deezer/Last.fm) vers un ENFANT précis si
// on reconnaît une signature claire. Renvoie null si pas de match net (on
// retombe alors sur clientMapGenre pour le parent seul). Volontairement
// conservateur : seuls les sous-genres sans ambiguïté sont mappés ici. La
// couverture fine viendra avec le chantier sources (Discogs Style / Last.fm).
const CHILD_RAW_MAP = {
  'shoegaze':'Indie Rock / Dream Pop / Shoegaze', 'dream pop':'Indie Rock / Dream Pop / Shoegaze',
  'indie rock':'Indie Rock / Dream Pop / Shoegaze', 'post-rock':'Art Rock / Post-Rock',
  'post rock':'Art Rock / Post-Rock', 'art rock':'Art Rock / Post-Rock',
  'grunge':'Grunge / Post-Punk / Noise', 'post-punk':'Grunge / Post-Punk / Noise',
  'noise rock':'Grunge / Post-Punk / Noise', 'hardcore punk':'Punk Rock / Hardcore',
  'punk':'Punk Rock / Hardcore', 'psychedelic rock':'Psychedelic 60s/70s', 'psychedelic':'Psychedelic 60s/70s',
  'hard rock':'Hard Rock', 'arena rock':'Classic Rock / Arena',
  'thrash metal':'Thrash / Death / Black Metal', 'death metal':'Thrash / Death / Black Metal',
  'black metal':'Thrash / Death / Black Metal', 'progressive metal':'Progressive Metal',
  'doom metal':'Stoner / Sludge / Doom', 'stoner rock':'Stoner / Sludge / Doom', 'sludge':'Stoner / Sludge / Doom',
  'power metal':'Heavy Metal / Power Metal', 'heavy metal':'Heavy Metal / Power Metal',
  'disco':'Disco', 'funk':'Funk', 'neo soul':'Classic Soul / Neo-Soul', 'neo-soul':'Classic Soul / Neo-Soul',
  'soul':'Classic Soul / Neo-Soul', 'cool jazz':'Cool Jazz / Vocal Jazz', 'vocal jazz':'Cool Jazz / Vocal Jazz',
  'hard bop':'Hard Bop / Modal', 'modal jazz':'Hard Bop / Modal', 'gypsy jazz':'Gypsy Jazz / Swing', 'swing':'Gypsy Jazz / Swing',
  'gospel':'Gospel', 'delta blues':'Delta Blues / Acoustic', 'acoustic blues':'Delta Blues / Acoustic',
  'electric blues':'Electric Blues / Chicago', 'chicago blues':'Electric Blues / Chicago',
  'trap':'Modern Rap / Trap', 'boom bap':'Boom Bap / Classic Rap', 'lo-fi hip hop':'Lo-Fi / Jazz Hop', 'jazz hop':'Lo-Fi / Jazz Hop',
  'synthpop':'Synth-Pop / New Wave', 'synth-pop':'Synth-Pop / New Wave', 'new wave':'Synth-Pop / New Wave', 'eurodance':'Club / Eurodance',
  'bluegrass':'Traditional Folk / Bluegrass', 'indie folk':'Indie Folk / Acoustic', 'country':'Country',
  'ambient':'Ambient / Drone', 'drone':'Ambient / Drone', 'new age':'New Age / Neoclassical',
  'trip-hop':'Downtempo / Trip-Hop', 'trip hop':'Downtempo / Trip-Hop', 'downtempo':'Downtempo / Trip-Hop',
  'synthwave':'Synthwave / Retrowave', 'retrowave':'Synthwave / Retrowave',
  'deep house':'House / Deep House', 'house':'House / Deep House', 'techno':'Techno / Acid / Trance', 'trance':'Techno / Acid / Trance', 'acid':'Techno / Acid / Trance',
  'dub':'Dub', 'roots reggae':'Roots Reggae / Lovers Rock', 'lovers rock':'Roots Reggae / Lovers Rock', 'ska':'Ska / Rocksteady', 'rocksteady':'Ska / Rocksteady',
  'bossa nova':'Bossa Nova / Samba-Canção', 'samba':'Bossa Nova / Samba-Canção', 'tango':'Tango / Nuevo Tango', 'nuevo tango':'Tango / Nuevo Tango',
  'salsa':'Salsa / Bachata / Merengue / Mambo', 'bachata':'Salsa / Bachata / Merengue / Mambo', 'merengue':'Salsa / Bachata / Merengue / Mambo', 'mambo':'Salsa / Bachata / Merengue / Mambo',
  'reggaeton':'Reggaeton / Dembow / Latin Trap', 'dembow':'Reggaeton / Dembow / Latin Trap',
  'flamenco':'Flamenco / Nuevo Flamenco', 'indian classical':'Indian Classical', 'hindustani':'Indian Classical', 'carnatic':'Indian Classical',
  'afrobeat':'Afrobeat / Highlife', 'highlife':'Afrobeat / Highlife', 'desert blues':'Desert Blues / Tuareg Rock', 'tuareg':'Desert Blues / Tuareg Rock',
  'klezmer':'Balkan / Klezmer / Celtic Trad', 'balkan':'Balkan / Klezmer / Celtic Trad', 'celtic':'Balkan / Klezmer / Celtic Trad',
  'opera':'Orchestral / Opera', 'orchestral':'Orchestral / Opera', 'chamber music':'Solo Instrument / Chamber',
  'soundtrack':'Epic / Action Soundtrack', 'film score':'Atmospheric / Ambient Score', 'score':'Atmospheric / Ambient Score',
  'chanson française':'Chanson française', 'chanson francaise':'Chanson française',
  'chanson à texte':'Chanson française', 'chanson a texte':'Chanson française',
  'chanson réaliste':'Chanson française', 'chanson realiste':'Chanson française',
  'chanson':'Chanson française',
  'variété française':'Variété française / Pop FR', 'variete francaise':'Variété française / Pop FR',
  'variété':'Variété française / Pop FR', 'variete':'Variété française / Pop FR',
  'french pop':'Variété française / Pop FR', 'yé-yé':'Variété française / Pop FR', 'ye-ye':'Variété française / Pop FR',
};
// ── Normalisation des genres bruts (accents + casse + ponctuation) ──────────
// Une seule porte d'entrée pour TOUT le matching de genre. Évite d'énumérer
// chaque variante ("Variétés Françaises", "VARIÉTÉ", "variete francaise"…).
function _normGenre(s){
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // retire les accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')                      // ponctuation → espace
    .trim();
}
// Dé-pluralisation prudente (mots > 3 lettres) — UNIQUEMENT en dernier recours.
function _deplural(s){
  return s.split(' ').map(w => w.length > 3 ? w.replace(/s$/, '') : w).join(' ');
}
// Index normalisés construits une fois (clé normalisée → bucket / enfant).
const _CGM_NORM = (() => { const o = {}; for (const k in CLIENT_GENRE_MAP) { const nk = _normGenre(k); if (nk) o[nk] = CLIENT_GENRE_MAP[k]; } return o; })();
const _CRM_NORM = (() => { const o = {}; for (const k in CHILD_RAW_MAP)    { const nk = _normGenre(k); if (nk) o[nk] = CHILD_RAW_MAP[k];    } return o; })();

function clientMapChild(raw){
  if (!raw) return null;
  if (CHILD_GENRES[raw]) return raw;             // déjà un enfant canonique
  const r = _normGenre(raw);
  if (!r) return null;
  if (_CRM_NORM[r]) return _CRM_NORM[r];          // exact (accent/casse/ponctuation-insensible)
  const keys = Object.keys(_CRM_NORM).sort((a,b) => b.length - a.length);
  for (const key of keys){
    if (key.length <= 3) continue;
    const rgx = new RegExp('(^|[^a-z0-9])' + key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '([^a-z0-9]|$)', 'i');
    if (rgx.test(r)) return _CRM_NORM[key];
  }
  const rp = _deplural(r);                        // dernier recours : pluriel
  if (rp !== r && _CRM_NORM[rp]) return _CRM_NORM[rp];
  return null;
}

function clientMapGenre(raw){
  if(!raw) return null;
  if(GENRE_15_LIST.includes(raw)) return raw;     // déjà un bucket canonique
  const r = _normGenre(raw);
  if(!r) return null;
  if(_CGM_NORM[r]) return _CGM_NORM[r];            // exact (accent/casse/ponctuation-insensible)
  // clés longues d'abord ('heavy metal' avant 'metal')
  const keys = Object.keys(_CGM_NORM).sort((a,b) => b.length - a.length);
  for(const key of keys){
    if(key.length <= 3) continue;
    const rgx = new RegExp('(^|[^a-z0-9])' + key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '([^a-z0-9]|$)', 'i');
    if(rgx.test(r)) return _CGM_NORM[key];
  }
  const rp = _deplural(r);                         // dernier recours : pluriel
  if(rp !== r && _CGM_NORM[rp]) return _CGM_NORM[rp];
  return null;
}

// Normalise les genres existants dans allTracks vers les 15 buckets Wave Tune
// Appelé après bootLoad — ne touche pas aux morceaux déjà dans le bon format.
// Migre automatiquement les anciens noms de buckets (avant refonte) vers les nouveaux,
// sauf pour les tracks marqués _userModified (user wins).
function remapGenres(){
  const TARGET_GENRES = new Set(GENRE_15_LIST);
  // Map explicite ancien bucket → nouveau bucket (migration one-shot après refonte)
  // L'ancien regroupement mélangeait blues/jazz/soul, séparait synthwave de l'électro,
  // punk+metal dans un seul bucket, ambient+classique ensemble. La refonte sépare
  // ces familles. On redistribue au mieux.
  const LEGACY_BUCKET_MIGRATION = {
    'Indie / Alternative':    'Punk, Grunge & Alternative',
    'Classic Rock':           'Classic Rock & Hard Rock',
    'Modern Pop':             'R&B, Pop & Dance',
    'Hip-Hop / Trap':         'Hip-Hop & Rap Culture',
    'Jazz / Soul Fusion':     'Jazz & Swing',         // default, blues/soul rattrapés par overrides artistes
    'Deep & Tech House':      'Electronic, House & Techno',
    'Neo-Classical / Ambient':'Classical & Opera',          // default, ambient pur rattrapé par re-match keyword
    'R&B / Neo-Soul':         'R&B, Pop & Dance',     // neo-soul legends rattrapés par overrides
    'Folk & Americana':       'Folk, Country & Americana',
    'Synthwave / Electropop': 'Electronic, House & Techno',
    'Heavy / Metal Core':     'Heavy Metal & Loud',                // default, punk/grunge rattrapés par re-match keyword
    'Lo-Fi Beats':            'Ambient, New Age & Chill',
    'Reggae / Dub / Roots':   'Reggae, Dub & Ska',
   'Latin / Afrobeat':       'Latin, Caribbean, Flamenco, Tango',    // default, afrobeat rattrapés par overrides
    'Cinematic Score':        'Soundtrack & Score',
    'Música tropical':        'Latin, Caribbean, Flamenco, Tango',    // libellé brut résiduel, pas un choix réfléchi
    'Musica tropical':        'Latin, Caribbean, Flamenco, Tango',
    // Scission 16 genres : l'ancien bucket fusionné par défaut → Classical & Opera
    // (les BO/scores se re-trient ensuite à la revue ou via fetch). Migration de
    // nomenclature : s'applique même aux _userModified (le user a choisi "classique",
    // pas l'ancien libellé), comme les autres entrées de cette table.
    'Classical, Opera & Score':'Classical & Opera',
  };
  let remapped = 0, migrated = 0, cleared = 0;
  const _clearedForEnrich = [];
  allTracks.forEach(t => {
    if(!t.genre) return;
    if(TARGET_GENRES.has(t.genre)) return; // déjà dans le bon format
    // 1) Migration explicite d'un ancien bucket (écrase même _userModified : c'est
    //    une migration de nomenclature, le user n'a pas choisi l'ancien nom lui-même,
    //    il a choisi un concept qu'on redistribue. Si l'user avait tapé un genre
    //    custom libre, il ne correspondra pas à un ancien bucket donc pas touché.)
    if(LEGACY_BUCKET_MIGRATION[t.genre]){
      t.genre = LEGACY_BUCKET_MIGRATION[t.genre];
      migrated++;
      return;
    }
    // 2) Tag iTunes/Music brut → bucket — sauf si user a explicitement modifié
    if(t._userModified) return;
    const mapped = clientMapGenre(t.genre);
    if(mapped){ t.genre = mapped; remapped++; }
    else {
      // Genre non canonique ET non mappable → on l'efface ET on lance une
      // recherche en ligne pour le réaffilier à un bucket canonique (jamais de
      // bucket parasite « Raíces », « Doo Wop »…). En attendant le résultat, le
      // morceau est en « (Sans genre) ». Si la recherche ne trouve rien, il y
      // reste (honnête) — il ne sera pas re-tenté à chaque démarrage.
      console.log('[remapGenres] genre non mappable effacé → ré-enrichissement:', t.genre, '—', t.artist || '', '/', t.title || '');
      delete t.genre;
      if(!t.year) t._needsPersistPurge = true;  // pas d'année à préserver → purge directe
      t._incomplete = true;                      // candidat enrichissement
      _clearedForEnrich.push(t);
      cleared++;
    }
  });
  if(remapped > 0 || migrated > 0 || cleared > 0){
    filtered = [...allTracks]; // reset pour inclure les changements
    if(migrated > 0) console.log('[remapGenres]', migrated, 'buckets anciens → nouveaux');
    if(remapped > 0) console.log('[remapGenres]', remapped, 'tags bruts normalisés');
    if(cleared > 0) console.log('[remapGenres]', cleared, 'genres non mappables effacés (→ Sans genre, à ré-enrichir)');
    // Persister la migration pour ne pas la refaire à chaque lancement
    if(typeof scheduleMetaSave === 'function') scheduleMetaSave();
  }
  // Lance la recherche en ligne pour réaffilier les genres effacés à un bucket
  // canonique (l'enrichQueue écrit auto le genre quand il en trouve un, throttlé).
  if(_clearedForEnrich.length && typeof enrichQueue !== 'undefined' && enrichQueue.addForce){
    enrichQueue.addForce(_clearedForEnrich, { priority: 6 });
    console.log('[remapGenres]', _clearedForEnrich.length, 'morceau(x) envoyé(s) à la recherche de genre canonique');
  }
}

// Purge les métadonnées clairement aberrantes (années futures, genres absurdes)
// pour permettre une re-harmonisation propre. Respecte _userModified.
async function purgeBadMeta(){
  const currentYear = new Date().getFullYear();
  let purgedYears = 0, purgedGenres = 0;
  // Récupérer la liste des overrides artiste côté main.js pour corriger les
  // tracks déjà sauvegardés avec un mauvais genre (ex: Taj Mahal classé dans un bucket Electronic).
  let overrides = {};
  try {
    if (window.wt?.getArtistOverrides) {
      overrides = await window.wt.getArtistOverrides();
    }
  } catch(e) {
    console.warn('[purgeBadMeta] overrides unavailable — Electron probablement pas redémarré avec le nouveau main.js. Fermer complètement l\'app et relancer.');
  }
  // Fonction de normalisation identique à main.js (lowercase, pas d'accents, pas de ponctuation)
  function normArtist(s){
    if(!s) return '';
    return String(s).toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .replace(/[^a-z0-9 ]/g,' ')
      .replace(/\s+/g,' ').trim();
  }
  allTracks.forEach(t => {
    if(t._userModified) return; // user wins, don't touch
    let purgedThis = false;
    // 1) Année future = bug certain
    if(t.year && (t.year > currentYear || t.year < 1600)){
      delete t.year;
      purgedYears++;
      purgedThis = true;
    }
    // 2) Artiste dans la liste d'overrides mais genre actuel ≠ override
    //    → effacer le genre pour forcer un re-fetch propre (override s'appliquera)
    const artistKey = normArtist(t.artist);
    if(artistKey && overrides[artistKey]){
      const expected = overrides[artistKey];
      if(t.genre && t.genre !== expected){
        delete t.genre;
        purgedGenres++;
        purgedThis = true;
      }
    }
    // Si plus rien sur la track, la marquer pour purge côté serveur
    if(purgedThis && !t.genre && !t.year){
      t._needsPersistPurge = true;
    }
  });
  if(purgedYears > 0) console.log('[purgeBadMeta]', purgedYears, 'années aberrantes effacées');
  if(purgedGenres > 0) console.log('[purgeBadMeta]', purgedGenres, 'genres override à re-fetch');
  if(purgedYears > 0 || purgedGenres > 0) scheduleMetaSave();
  return purgedYears + purgedGenres;
}

function autoFillLocal(){
  let filled=0;
  const byAlbum=new Map();
  allTracks.forEach(t=>{
    if(!t.album) return;
    const k=t.album.trim().toLowerCase();
    if(!byAlbum.has(k)) byAlbum.set(k,[]);
    byAlbum.get(k).push(t);
  });
  for(const [,tracks] of byAlbum){
    const yearDonor=tracks.find(t=>t.year&&t.year>0);
    const genreDonor=tracks.find(t=>t.genre&&!t.genre.startsWith('('));
    tracks.forEach(t=>{
      if(t._userModified) return; // sacred
      if(!t.year && yearDonor){ t.year=yearDonor.year; filled++; }
      if(!t.genre && genreDonor){ t.genre=genreDonor.genre; filled++; }
    });
  }
 if(filled>0) scheduleMetaSave();
  return filled;
}

// ── DÉTECTION DES ANNÉES INCOHÉRENTES (intra-album) ─────────────
// Heuristique 100% locale, gratuite, déterministe : pour chaque album
// "normal" (non-compilation), on calcule l'année DOMINANTE (la plus
// fréquente). Tout morceau dont l'année diffère de la dominante est un
// OUTLIER candidat — typiquement une réédition/remaster taguée à la mauvaise
// date dans un album sinon cohérent.
//
// On EXCLUT :
//   • les compilations / OST / best-of (années différentes y sont normales)
//   • les morceaux _userModified (décision explicite de l'user = sacrée)
//   • les albums sans année dominante claire (frac trop basse → pas fiable)
//   • les années "junk" comme dominante (on ne propose pas de remplacer par pire)
//
// Retourne une liste groupée par album, prête pour la revue :
//   [{ album, artist, dominantYear, frac, outliers:[{path,title,currentYear}] }]
//
// NB : ne MODIFIE rien. C'est applyYearFix / applyAllYearFixes qui écrivent.
function detectYearOutliers(opts={}){
  // frac min de la dominante pour qu'on lui fasse confiance (0.6 = 60% des
  // morceaux de l'album partagent cette année). Réglable.
  const MIN_DOMINANT_FRAC = opts.minDominantFrac ?? 0.6;
  // taille mini de l'album : sous ce seuil, "dominante" n'a pas de sens
  // (un album de 2 titres avec 1 chacun → pas d'outlier détectable).
  const MIN_ALBUM_SIZE = opts.minAlbumSize ?? 3;

  // Grouper par artiste+album (comme buildAlbumGroups, pour ne pas mélanger
  // deux albums homonymes d'artistes différents).
  const groups = new Map();
  allTracks.forEach(t=>{
    const al = (t.album||'').trim();
    if(!al) return;
    const ar = (t.artist||'').trim();
    const k = ar + '||' + al;
    if(!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  });

  const proposals = [];
  for(const [, tracks] of groups){
    if(tracks.length < MIN_ALBUM_SIZE) continue;

    const meta = dominantMeta(tracks);
    // Compilation → années hétérogènes légitimes, on ne touche pas.
    if(meta.isCompilation) continue;

    const domYear = parseInt(meta.year);
    if(isJunkYear(domYear)) continue;          // dominante inexploitable

    // Recalcule la fraction de la dominante sur les morceaux QUI ONT une année
    // (un album à moitié sans année ne doit pas faire chuter artificiellement
    //  la confiance dans la dominante des morceaux qui en ont une).
    const withYear = tracks.filter(t=>t.year && !isJunkYear(t.year));
    if(withYear.length < MIN_ALBUM_SIZE) continue;
    const domCount = withYear.filter(t=>parseInt(t.year)===domYear).length;
    const frac = domCount / withYear.length;
    if(frac < MIN_DOMINANT_FRAC) continue;     // pas de dominante claire

    // Outliers = morceaux avec une année DIFFÉRENTE de la dominante,
    // non junk eux-mêmes (les junk sont gérés par purgeBadMeta), non userModified.
    const outliers = withYear.filter(t=>{
      if(t._userModified) return false;
      const y = parseInt(t.year);
      return y !== domYear && !isJunkYear(y);
    }).map(t=>({ path:t.path, title:t.title||'(sans titre)', currentYear:parseInt(t.year) }));

    if(outliers.length){
      proposals.push({
        album: tracks[0].album,
        artist: meta.artist || tracks[0].artist || '(Artiste inconnu)',
        dominantYear: domYear,
        frac: Math.round(frac*100),
        outliers
      });
    }
  }

  // Tri : albums avec le plus d'outliers d'abord (impact visuel max sur la frise)
  proposals.sort((a,b)=>b.outliers.length - a.outliers.length);
  return proposals;
}

// Affiche dans la console ce que la détection attrape, sans rien modifier.
// À appeler à la main (console) pour valider l'heuristique sur ta vraie biblio.
function debugYearOutliers(opts={}){
  const proposals = detectYearOutliers(opts);
  const totalOutliers = proposals.reduce((s,p)=>s+p.outliers.length,0);
  console.log(`[detectYearOutliers] ${proposals.length} albums concernés, ${totalOutliers} morceaux suspects`);
  const flat = [];
  proposals.forEach(p=>{
    p.outliers.forEach(o=>{
      flat.push({
        album: p.album,
        artist: p.artist,
        titre: o.title,
        annéeActuelle: o.currentYear,
        annéeProposée: p.dominantYear,
        confiance: p.frac + '%'
      });
    });
  });
  console.table(flat);
  return proposals;
}

// Applique une correction d'année validée par l'utilisateur sur UN morceau.
// Pose _userModified = true → la décision devient sacrée (plus jamais écrasée
// par l'harmonisation auto). Persiste via scheduleMetaSave.
function applyYearFix(path, year){
  const y = parseInt(year);
  if(isJunkYear(y)) return false;
  const t = allTracks.find(x=>x.path===path);
  if(!t) return false;
  t.year = y;
  t._userModified = true;
  _clearUnidentifiedIfComplete(t);
  scheduleMetaSave();
  return true;
}

// Applique en masse toutes les propositions (mode "tout accepter").
// Chaque morceau corrigé prend l'année dominante de son album.
function applyAllYearFixes(proposals){
  const list = proposals || detectYearOutliers();
  let fixed = 0;
  list.forEach(p=>{
    p.outliers.forEach(o=>{
      const t = allTracks.find(x=>x.path===o.path);
      if(!t || t._userModified) return;
      t.year = p.dominantYear;
      t._userModified = true;
      _clearUnidentifiedIfComplete(t);
      fixed++;
    });
  });
  if(fixed>0){
    filtered = [...filtered];   // refresh refs pour le re-render
    scheduleMetaSave();
    if(typeof renderVirtual === 'function') renderVirtual();
  }
  if(typeof toast === 'function') toast(`✓ ${fixed} année${fixed!==1?'s':''} corrigée${fixed!==1?'s':''}`);
  return fixed;
}

// ── RE-VÉRIFICATION DES ANNÉES PAR ALBUM (re-fetch MusicBrainz) ──
// Cible le VRAI problème : les albums entiers tagués à la date de réédition
// (ex. "Here, My Dear" tout en 2001 au lieu de 1978). L'incohérence intra-album
// ne les détecte pas (l'album est faux de façon cohérente). Et l'enrichissement
// normal les ignore (buildAlbumGroups skip tout morceau ayant déjà genre+année).
//
// On contourne ce filtre : on sélectionne les albums NORMAUX (non-compilation)
// dont l'année ≥ minYear (zone réédition), même complets, et on redemande à
// MusicBrainz la first-release-date (vraie date d'origine, déjà extraite par
// le handler fetch-online-meta côté main.js).
//
// PHASE DRY-RUN : n'écrit RIEN. Affiche les corrections proposées en console
// pour valider la qualité avant d'engager un run complet (~2000 albums).

// Construit les groupes d'albums à re-vérifier. Format compatible fetchOnlineMeta.
// opts.minYear : ne prend que les albums dont l'année actuelle est ≥ ce seuil.
function buildYearRecheckGroups(opts={}){
  const minYear = opts.minYear ?? 2000;

  // Détection compilation : même logique que buildAlbumGroups (artistes distincts
  // ou nom d'album évocateur). On EXCLUT les compilations (années hétérogènes
  // légitimes, et le handler ne fournit pas d'année fiable pour elles).
  const byAlbumName = new Map();
  allTracks.forEach(t=>{
    const al = t.album || '';
    if(!al) return;
    if(!byAlbumName.has(al)) byAlbumName.set(al, []);
    byAlbumName.get(al).push(t);
  });

  const minPaths = opts.minPaths ?? 1;   // ≥2 pour ne garder que les albums complets
  // Artefacts non-musicaux à ignorer (mémos vocaux iTunes, etc.)
  const _isNonMusic = (ar, al) => {
    const a = ar.toLowerCase(), b = al.toLowerCase();
    return a === 'itunes music' || b === 'voice memos' || a === 'unknown artist';
  };

  const groups = new Map();           // key artist||album → {album, artist, paths, currentYear}
  allTracks.forEach(t=>{
    if(t._userModified) return;        // décision user = sacrée
    const al = (t.album||'').trim();
    const ar = (t.artist||'').trim();
    if(!al) return;
    if(!ar) return;                     // artiste vide → fetch année non fiable (autre chantier)
    if(_isNonMusic(ar, al)) return;     // mémos vocaux & co

    const albTracks = byAlbumName.get(t.album) || [];
    const distinctArtists = new Set(albTracks.map(x=>x.artist||'').filter(Boolean));
    const isCompi = _COMPI_RE.test(al.toLowerCase()) || distinctArtists.size >= 3;
    if(isCompi) return;

 const y = parseInt(t.year);
    // Le classique entre TOUJOURS dans le lot (filet de sécurité), quel que soit
    // minYear et même sans année : c'est justement là qu'on veut corriger l'année
    // de composition. Détection par le genre (fiable) ou le titre.
    const _isClassical = /classical|opera|symphon|concerto|baroque/i.test(t.genre || '')
      || /[:]|\b(symphony|sinfonia|concerto|sonata|requiem|mass|quartet|bwv|opus|op\.?\s*\d|k\.?\s*\d)\b/i.test(al);
    if(!_isClassical){
      if(isJunkYear(y)) return;         // année inexploitable → géré ailleurs
      if(y < minYear) return;           // hors zone réédition
    }

    const k = ar + '||' + al;
    if(!groups.has(k)){
      groups.set(k, { album: al, artist: ar, paths: [], isCompilation: false, currentYear: isJunkYear(y) ? null : y });
    }
    groups.get(k).paths.push(t.path);
  });

  // Filtre taille mini (albums complets seulement si minPaths ≥ 2)
  return [...groups.values()].filter(g => g.paths.length >= minPaths);
}

// DRY-RUN : re-vérifie un échantillon et AFFICHE les propositions sans écrire.
// opts.minYear (def 2000), opts.limit (def 50).
// Une proposition n'est retenue que si MusicBrainz renvoie une année TRUSTED
// et ANTÉRIEURE à l'année actuelle (= réédition probable, écart dans le bon sens).
async function dryRunYearRecheck(opts={}){
  const minYear = opts.minYear ?? 2000;
  const limit   = opts.limit   ?? 50;

  if(!window.wt?.fetchOnlineMeta){
    console.warn('[dryRunYearRecheck] window.wt.fetchOnlineMeta indisponible (Electron pas redémarré ?)');
    return [];
  }

  const allGroups = buildYearRecheckGroups({ minYear });
  const sample = allGroups.slice(0, limit);
  console.log(`[dryRunYearRecheck] ${allGroups.length} albums ≥ ${minYear} au total — test sur ${sample.length}. ` +
              `~1,1s par album non-caché, patiente…`);

  // Map path → album group (pour retrouver currentYear à la réception)
  const pathToGroup = new Map();
  sample.forEach(g => g.paths.forEach(p => pathToGroup.set(p, g)));

  let results;
  try {
    results = await window.wt.fetchOnlineMeta(sample);
  } catch(e){
    console.warn('[dryRunYearRecheck] fetchOnlineMeta a échoué:', e);
    return [];
  }

  // Agrège par album : on regarde l'année renvoyée pour les morceaux du groupe.
  // fetchOnlineMeta ne renvoie que les morceaux dont la meta a "changé" côté
  // cache — donc on lit l'année proposée par morceau et on la rattache au groupe.
  const perAlbum = new Map();         // key artist||album → {group, proposedYear, trusted}
  Object.entries(results || {}).forEach(([path, meta])=>{
    const g = pathToGroup.get(path);
    if(!g) return;
    if(!meta || !meta.year) return;
    const k = g.artist + '||' + g.album;
    // On garde la 1re année trusted vue pour l'album (toutes identiques en principe)
    if(!perAlbum.has(k)){
      perAlbum.set(k, { group: g, proposedYear: parseInt(meta.year), trusted: !!meta.yearTrusted });
    }
  });

  // Construit les propositions retenues (trusted + antérieure).
  const proposals = [];
  for(const [, v] of perAlbum){
    const cur = v.group.currentYear;
    const prop = v.proposedYear;
    if(isJunkYear(prop)) continue;
    if(!v.trusted) continue;            // on ne propose que du fiable en dry-run
    if(prop >= cur) continue;           // doit être antérieure (réédition → origine)
    proposals.push({
      album: v.group.album,
      artist: v.group.artist,
      anneeActuelle: cur,
      anneeProposee: prop,
      ecart: cur - prop,
      nbMorceaux: v.group.paths.length,
      trusted: v.trusted
    });
  }
  proposals.sort((a,b)=>b.ecart - a.ecart);

  console.log(`[dryRunYearRecheck] ${proposals.length} albums avec correction proposée ` +
              `(sur ${sample.length} testés) :`);
  console.table(proposals);
  // On range le résultat brut pour inspection manuelle éventuelle
  window._lastYearRecheck = { sample, results, proposals };
  return proposals;
}

// ── CORRECTION DES ANNÉES VIA CACHE MÉTA (auto + revue) ─────────
// S'appuie sur le cache MusicBrainz déjà calculé (window.wt.getMetaCache),
// zéro réseau. Compare l'année du cache (first-release-date) à l'année locale.
//   • AUTO : year cache trusted ET plus ancienne, écart ≥ 5 ans → corrige seul.
//   • REVUE : toutes les autres divergences → modale, tu valides à l'œil.
// _userModified reste sacré (jamais touché, jamais auto-écrasé).

const YEAR_AUTO_MIN_GAP = 5;   // écart mini (ans) pour l'auto-correction (legacy)

// ── DÉCISION DE FIABILITÉ DE L'ANNÉE PROPOSÉE ─────────────────────
// Philosophie produit appliquée mécaniquement : COMPOSITION > RÉÉDITION.
// La plus ancienne année gagne. Le cache propose une date plus ANCIENNE
// que le local ? On lui fait confiance (= FIABLE auto). Plus récente ?
// Le filtre en amont (buildMetaDiffs) l'a déjà skipée, on n'arrive même
// pas ici. _userModified reste sacré.
//
// Cascade minimale, 3 règles :
//   1. Wikipedia (composed) → FIABLE — autorité ultime sur la composition
//      (extraction stricte côté main.js : marqueur classique fort +
//      champ infobox structuré).
//   2. Classique sans Wikipedia + cache > 1930 → INCERTAIN — la date
//      cache est nécessairement un enregistrement/réédition, pas la
//      composition ; ambigu, l'humain tranche.
//   3. Tout going-backward (gap ≥ 1) → FIABLE — règle d'or appliquée.
//
// Risque assumé : MB-RG peut occasionnellement matcher un mauvais album
// et renvoyer une fausse date ancienne. C'est rare, et préférable à
// 300 cas INCERTAIN à valider manuellement.
//
// Retourne { trusted:bool, reason:string }.
function _decideYearTrust(c, info){
  const cy  = parseInt(c.year);
  const ly  = info.localYear ? parseInt(info.localYear) : null;
  const gap = (ly !== null && Number.isFinite(ly)) ? (ly - cy) : null;
  const dbg = c._debug || {};
  const ys  = dbg.yearSource || '';

  // 1. Wikipedia historique : autorité ultime sur la composition.
  //    Couvre Composed/Written/Premiered/Performed (Phase 2 refonte session 5).
  //    Élargi depuis la précédente règle qui n'acceptait que 'Wikipedia (composed)'.
  if (/^Wikipedia \((composed|written|premiered|performed)\)$/.test(ys))
    return { trusted:true, reason:'wiki-historical' };

 // 2. Classique moderne (>1930) sans Wikipedia : nécessairement réédition.
  //    Test uniquement sur le genre LOCAL (= déjà sur disque). On NE teste
  //    PAS le genre proposé (c.genre) parce que MB-RG fait régulièrement
  //    de faux matchs et propose "Classical, Opera & Score" sur du Ventures,
  //    du Dueling Banjos, du Vangelis... Le genre local est la référence
  //    fiable : c'est ce que l'utilisateur a déjà accepté.
  const isClassical = /classical|opera|baroque|symphony|orchestra/i
    .test(info.localGenre || '');
  if (isClassical && cy > 1930) return { trusted:false, reason:'classical-modern' };

  // 3. CONVERGENCE multi-sources (≥ 3 sources ±1 an) : la source la plus
  //    fiable structurellement. Signée d'office, peu importe le gap (même
  //    gap=0 ou pas d'année locale). Garde-fou classique-moderne ci-dessus
  //    s'applique en premier — si convergence à 1985 sur du Bach, on refuse
  //    avant d'arriver ici. Sinon, on signe.
  if (ys.startsWith('Converge-')) return { trusted:true, reason:'multi-source-converge' };

  // 4. RÈGLE D'OR : going-backward = correction historique = FIABLE.
  //    La règle d'or sans condition de source : si on est dans la cascade
  //    avec gap > 0, c'est que le filtre a laissé passer (= going-backward
  //    ou égal). On signe. Couvre Brian Auger 1972→1968, Roy Brown
  //    1993→1948, Otis Redding 1998→1966, etc.
  if (gap !== null && gap >= 1) return { trusted:true, reason:'historical-correction' };

  // Reliquat : gap nul/négatif passé à travers le filtre (impossible en
  // théorie post-Patch 1) OU pas d'année locale (cas iTunes-only).
  // Sécurité : on ne signe pas sans gap.
  return { trusted:false, reason:'no-local-year' };
}

// Construit la liste des divergences cache vs local, classées auto/revue.
// Retourne { auto:[...], review:[...] } — chaque entrée = un album.
async function buildYearCacheDiffs(){
  if(!window.wt?.getMetaCache){
    console.warn('[yearCache] getMetaCache indisponible (Electron pas redémarré ?)');
    return { auto:[], review:[] };
  }
  const cache = await window.wt.getMetaCache();

  // Regroupe les tracks locaux par artist||album (albums normaux uniquement).
  const byKey = new Map();
  const byAlbumName = new Map();
  allTracks.forEach(t=>{
    const al=t.album||''; if(!al) return;
    if(!byAlbumName.has(al)) byAlbumName.set(al,[]);
    byAlbumName.get(al).push(t);
  });
  allTracks.forEach(t=>{
    if(t._userModified) return;
    const ar=(t.artist||'').trim(), al=(t.album||'').trim();
    if(!ar||!al) return;
    // compilation → on ignore (années hétérogènes légitimes)
    const albT=byAlbumName.get(t.album)||[];
    const distinct=new Set(albT.map(x=>x.artist||'').filter(Boolean));
    if(_COMPI_RE.test(al.toLowerCase()) || distinct.size>=3) return;
    const k=ar+'||'+al;
    if(!byKey.has(k)) byKey.set(k,{artist:ar,album:al,paths:[],localYear:parseInt(t.year)||null});
    byKey.get(k).paths.push(t.path);
  });

  const auto=[], review=[];
  for(const [k,info] of byKey){
    const c=cache[k];
    if(!c||!c.year) continue;
    const cy=parseInt(c.year);
    if(isJunkYear(cy)) continue;
    if(!info.localYear || cy===info.localYear) continue;   // pas de divergence
   const gap=info.localYear-cy;                            // >0 = cache plus ancien
    // Décision de fiabilité : cascade de signaux (voir _decideYearTrust).
    // Remplace l'ancien garde-fou plat « classique+>1930 → false » qui
    // bloquait aussi les vrais cas fiables (Wikipedia composé, convergence
    // multi-sources, MB-RG low-trust avec gap normal de correction).
    const _td = _decideYearTrust(c, info);
    const entry={ key:k, artist:info.artist, album:info.album,
                  localYear:info.localYear, cacheYear:cy, gap,
                  trusted:_td.trusted, _trustReason:_td.reason,
                  paths:info.paths };
    // AUTO si fiable, point — cascade déjà tranchée. Pas de seuil de gap.
    if(entry.trusted){
      auto.push(entry);
    } else {
      review.push(entry);
    }
  }
  // tri : plus gros écart absolu d'abord
  auto.sort((a,b)=>Math.abs(b.gap)-Math.abs(a.gap));
  review.sort((a,b)=>Math.abs(b.gap)-Math.abs(a.gap));
  return { auto, review };
}

// Applique une année à tous les morceaux d'un album (par paths).
// Pose _userModified=true (décision validée = sacrée). Ne persiste pas seul :
// l'appelant groupe les writes puis appelle scheduleMetaSave une fois.
function _applyYearToPaths(paths, year, opts={}){
  const y=parseInt(year);
  if(isJunkYear(y)) return 0;
  let n=0;
  paths.forEach(p=>{
    const t=allTracks.find(x=>x.path===p);
    if(!t || t._userModified) return;
   if(parseInt(t.year)===y) return;
    const _oldY = t.year || '';
    t.year=y;
    t._userModified=true;
    t._autoFixed=true;
    // Détail AVANT→APRÈS sur le morceau (lu par l'onglet "Corrigé"). On FUSIONNE
    // pour ne pas écraser un éventuel changement de genre déjà posé.
    t._autoFix = Object.assign({}, t._autoFix, { year:{from:_oldY,to:y}, source:(t._autoFix&&t._autoFix.source)||'cache-auto', ts:Date.now() });
    delete t._reviewPending;
    if(typeof recordAutoFix==='function') recordAutoFix(t,{year:{from:_oldY,to:y},source:'cache-auto',ts:Date.now()});
    if(typeof _clearUnidentifiedIfComplete==='function') _clearUnidentifiedIfComplete(t);
    n++;
  });
  return n;
}

// Point d'entrée principal : lance l'auto-correction puis ouvre la revue.
async function runYearCacheFix(opts={}){
  const { auto, review } = await buildYearCacheDiffs();

  // 1) AUTO — corrige le noyau sûr sans rien demander
  let autoFixed=0, autoAlbums=0;
  auto.forEach(e=>{
    const n=_applyYearToPaths(e.paths, e.cacheYear);
    if(n>0){ autoFixed+=n; autoAlbums++; }
  });
  if(autoFixed>0){
    scheduleMetaSave();
    if(typeof renderVirtual==='function') renderVirtual();
  }
  console.log(`[yearCache] auto: ${autoAlbums} albums / ${autoFixed} morceaux corrigés. Revue: ${review.length} albums.`);
  if(typeof toast==='function' && autoFixed>0){
    toast(`✓ ${autoAlbums} album${autoAlbums!==1?'s':''} corrigé${autoAlbums!==1?'s':''} automatiquement`);
  }

  // 2) REVUE — ouvre la modale si des divergences restent
  if(review.length && !opts.skipReview){
    openYearReview(review);
  } else if(!review.length){
    if(typeof toast==='function') toast('Aucune divergence à revoir 🎉');
  }
  return { autoFixed, autoAlbums, reviewCount:review.length };
}

// ── MODALE DE REVUE ──────────────────────────────────────────────
// Créée dynamiquement (réutilise les classes .batch-ov/.batch-box/.batch-btn
// existantes — aucun HTML/CSS à ajouter). Liste groupée par album, chaque
// ligne : artiste/album, local → cache, écart, badge trusted, et 3 actions :
// Accepter (applique cache), Refuser (ignore), champ manuel + OK.
let _yearReviewData=[];
function openYearReview(review){
  _yearReviewData=review.slice();
  let ov=document.getElementById('yearReviewOv');
  if(!ov){
    ov=document.createElement('div');
    ov.className='batch-ov';
    ov.id='yearReviewOv';
    ov.addEventListener('click',e=>{ if(e.target===ov) closeYearReview(); });
    document.body.appendChild(ov);
  }
  ov.innerHTML=`
    <div class="batch-box" style="width:600px;max-height:82vh">
      <div class="batch-hd">
        <div>
          <div class="batch-title">Revue des années</div>
          <div id="yrSub" style="font-size:11px;color:var(--t3);margin-top:2px">
            ${review.length} album${review.length!==1?'s':''} à vérifier — années issues de MusicBrainz
          </div>
        </div>
        <button class="batch-cls" onclick="closeYearReview()">✕</button>
      </div>
      <div class="batch-body" style="padding:14px 16px;overflow-y:auto;display:flex;flex-direction:column;gap:8px">
        <div style="display:flex;gap:8px;margin-bottom:6px">
          <button class="batch-btn ok" onclick="yrAcceptAll()" style="flex:1">✓ Tout accepter</button>
          <button class="batch-btn" onclick="closeYearReview()" style="flex:1">Fermer</button>
        </div>
        <div id="yrList" style="display:flex;flex-direction:column;gap:6px"></div>
      </div>
    </div>`;
  _renderYearReviewList();
  requestAnimationFrame(()=>ov.classList.add('on'));
}

function _renderYearReviewList(){
  const list=document.getElementById('yrList');
  if(!list) return;
  if(!_yearReviewData.length){
    list.innerHTML='<div style="text-align:center;color:var(--t3);padding:20px;font-size:12px">Terminé 🎉</div>';
    return;
  }
  list.innerHTML=_yearReviewData.map((e,i)=>{
    const badge=e.trusted
      ? '<span style="font-size:8px;background:var(--acc);color:#fff;padding:2px 5px;border-radius:3px;letter-spacing:.05em">FIABLE</span>'
      : '<span style="font-size:8px;background:var(--bg3);color:var(--t3);padding:2px 5px;border-radius:3px">incertain</span>';
    const dir=e.gap>0?'plus ancien':'plus récent';
    return `
    <div data-yr-idx="${i}" style="border:.5px solid var(--ln);border-radius:8px;padding:9px 11px;display:flex;align-items:center;gap:10px">
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;color:var(--t1);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(_displayAlbum(e.album))}</div>
        <div style="font-size:10px;color:var(--t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(e.artist)} · ${e.paths.length} morceau${e.paths.length!==1?'x':''}</div>
      </div>
      <div style="text-align:center;font-size:11px;color:var(--t2);white-space:nowrap">
        <span style="color:var(--t3)">${e.localYear}</span>
        <span style="margin:0 4px">→</span>
        <span style="color:var(--acc);font-weight:600">${e.cacheYear}</span>
        <div style="font-size:8px;color:var(--t3)">${Math.abs(e.gap)} ans ${dir}</div>
      </div>
      <div style="display:flex;align-items:center;gap:4px">
        ${badge}
        <button class="batch-btn ok" onclick="yrAccept(${i})" style="padding:5px 9px;min-height:0" title="Appliquer ${e.cacheYear}">✓</button>
        <button class="batch-btn" onclick="yrReject(${i})" style="padding:5px 9px;min-height:0" title="Ignorer">✕</button>
        <input type="number" placeholder="manuel" onkeydown="if(event.key==='Enter')yrManual(${i},this.value)"
               style="width:62px;background:rgba(0,0,0,.4);border:.5px solid var(--ln);border-radius:5px;color:var(--t1);font-size:11px;padding:4px 6px" />
      </div>
    </div>`;
  }).join('');
}

function _yrRemoveAndRefresh(idx){
  _yearReviewData.splice(idx,1);
  _renderYearReviewList();
  const sub=document.getElementById('yrSub');
  if(sub) sub.textContent=`${_yearReviewData.length} album${_yearReviewData.length!==1?'s':''} à vérifier — années issues de MusicBrainz`;
}

function yrAccept(idx){
  const e=_yearReviewData[idx]; if(!e) return;
  const n=_applyYearToPaths(e.paths, e.cacheYear);
  if(n>0){ scheduleMetaSave(); if(typeof renderVirtual==='function') renderVirtual(); }
  _yrRemoveAndRefresh(idx);
}
function yrManual(idx, val){
  const e=_yearReviewData[idx]; if(!e) return;
  const y=parseInt(val);
  if(isJunkYear(y)){ if(typeof toast==='function') toast('Année invalide'); return; }
  const n=_applyYearToPaths(e.paths, y);
  if(n>0){ scheduleMetaSave(); if(typeof renderVirtual==='function') renderVirtual(); }
  _yrRemoveAndRefresh(idx);
}
function yrReject(idx){ _yrRemoveAndRefresh(idx); }
function yrAcceptAll(){
  let fixed=0;
  _yearReviewData.forEach(e=>{ fixed+=_applyYearToPaths(e.paths, e.cacheYear); });
  if(fixed>0){ scheduleMetaSave(); if(typeof renderVirtual==='function') renderVirtual(); }
  if(typeof toast==='function') toast(`✓ ${fixed} morceau${fixed!==1?'x':''} corrigé${fixed!==1?'s':''}`);
  _yearReviewData=[];
  closeYearReview();
}
function closeYearReview(){
  const ov=document.getElementById('yearReviewOv');
  if(ov) ov.classList.remove('on');
}

// ── CORRECTION DES GENRES VIA CACHE MÉTA (auto + revue) ─────────
// Même mécanique que les années, MAIS comparaison TOUJOURS bucket-à-bucket :
// on passe le genre brut du cache par clientMapGenre pour le ramener dans les
// 15 buckets, puis on compare au bucket local. Ça élimine le bruit
// "rock vs classic rock" (mêmes buckets après mapping → pas de divergence).
//
//   • AUTO : genre local junk/vide + cache genreTrusted mappable → remplit.
//   • REVUE : désaccord FRANC entre deux buckets réels différents → tu valides.
//   • IGNORÉ : cache non mappable (clientMapGenre→null), ou même bucket, ou
//              local non-junk sans consensus trusted (pas de bruit).

// Construit les divergences de GENRE cache vs local, classées auto/revue.
async function buildGenreCacheDiffs(){
  if(!window.wt?.getMetaCache){
    console.warn('[genreCache] getMetaCache indisponible (Electron pas redémarré ?)');
    return { auto:[], review:[] };
  }
  const cache = await window.wt.getMetaCache();

  // Regroupe par artist||album (albums normaux uniquement, comme pour l'année)
  const byKey = new Map();
  const byAlbumName = new Map();
  allTracks.forEach(t=>{
    const al=t.album||''; if(!al) return;
    if(!byAlbumName.has(al)) byAlbumName.set(al,[]);
    byAlbumName.get(al).push(t);
  });
  allTracks.forEach(t=>{
    if(t._userModified) return;
    const ar=(t.artist||'').trim(), al=(t.album||'').trim();
    if(!ar||!al) return;
    const albT=byAlbumName.get(t.album)||[];
    const distinct=new Set(albT.map(x=>x.artist||'').filter(Boolean));
    if(_COMPI_RE.test(al.toLowerCase()) || distinct.size>=3) return;
    const k=ar+'||'+al;
    if(!byKey.has(k)) byKey.set(k,{artist:ar,album:al,paths:[],localGenre:t.genre||null});
    byKey.get(k).paths.push(t.path);
  });

  const auto=[], review=[];
  for(const [k,info] of byKey){
    const c=cache[k];
    if(!c||!c.genre) continue;
    // Ramène le genre cache dans les 15 buckets. Non mappable → on ignore.
    const cacheBucket=clientMapGenre(c.genre);
    if(!cacheBucket) continue;

    const localBucket = info.localGenre ? clientMapGenre(info.localGenre) : null;
    const localJunk = isJunkGenre(info.localGenre);

    const entry={ key:k, artist:info.artist, album:info.album,
                  localGenre:info.localGenre||'(vide)',
                  cacheGenre:cacheBucket, cacheRaw:c.genre,
                  trusted:!!c.genreTrusted, paths:info.paths };

    if(localJunk || !localBucket){
      // Local junk/vide/non mappable → AUTO si le cache est trusted, sinon revue.
      if(entry.trusted) auto.push(entry);
      else review.push(entry);
    } else if(localBucket !== cacheBucket){
      // Deux buckets RÉELS différents = désaccord franc → toujours en revue
      // (jamais auto : trop risqué de réécraser un genre déjà valide).
      review.push(entry);
    }
    // else : même bucket → accord, on ignore (c'est ça qui tue le bruit)
  }
  return { auto, review };
}

function _applyGenreToPaths(paths, genre, child){
  if(isJunkGenre(genre)) return 0;
  child = child || '';
  let n=0;
  paths.forEach(p=>{
    const t=allTracks.find(x=>x.path===p);
    if(!t || t._userModified) return;
    const sameGenre = (t.genre===genre);
    const sameChild = (!child || t.genreChild===child);
    if(sameGenre && sameChild) return;
    const _oldG = t.genre || '';
    t.genre=genre;
    t._userModified=true;
    t._autoFixed=true;
    // Détail AVANT→APRÈS sur le morceau (lu par l'onglet "Corrigé"). Fusion pour
    // conserver un éventuel changement d'année déjà posé.
    t._autoFix = Object.assign({}, t._autoFix, { genre:{from:_oldG,to:genre}, source:(t._autoFix&&t._autoFix.source)||'cache-auto', ts:Date.now() });
    delete t._reviewPending;
    if(typeof recordAutoFix==='function') recordAutoFix(t,{genre:{from:_oldG,to:genre},source:'cache-auto',ts:Date.now()});
    if(typeof _clearUnidentifiedIfComplete==='function') _clearUnidentifiedIfComplete(t);
    n++;
  });
  return n;
}

async function runGenreCacheFix(opts={}){
  const { auto, review } = await buildGenreCacheDiffs();

  let autoFixed=0, autoAlbums=0;
  auto.forEach(e=>{
    const n=_applyGenreToPaths(e.paths, e.cacheGenre);
    if(n>0){ autoFixed+=n; autoAlbums++; }
  });
  if(autoFixed>0){
    scheduleMetaSave();
    if(typeof renderVirtual==='function') renderVirtual();
  }
  console.log(`[genreCache] auto: ${autoAlbums} albums / ${autoFixed} morceaux. Revue: ${review.length} albums.`);
  if(typeof toast==='function' && autoFixed>0){
    toast(`✓ ${autoAlbums} genre${autoAlbums!==1?'s':''} rempli${autoAlbums!==1?'s':''} automatiquement`);
  }

  if(review.length && !opts.skipReview){
    openGenreReview(review);
  } else if(!review.length){
    if(typeof toast==='function') toast('Aucun désaccord de genre à revoir 🎉');
  }
  return { autoFixed, autoAlbums, reviewCount:review.length };
}

// ── MODALE DE REVUE GENRES (réutilise les mêmes classes CSS) ─────
let _genreReviewData=[];
function openGenreReview(review){
  _genreReviewData=review.slice();
  let ov=document.getElementById('genreReviewOv');
  if(!ov){
    ov=document.createElement('div');
    ov.className='batch-ov';
    ov.id='genreReviewOv';
    ov.addEventListener('click',e=>{ if(e.target===ov) closeGenreReview(); });
    document.body.appendChild(ov);
  }
  ov.innerHTML=`
    <div class="batch-box" style="width:640px;max-height:82vh">
      <div class="batch-hd">
        <div>
          <div class="batch-title">Revue des genres</div>
          <div id="grSub" style="font-size:11px;color:var(--t3);margin-top:2px">
            ${review.length} album${review.length!==1?'s':''} en désaccord — genres issus de MusicBrainz
          </div>
        </div>
        <button class="batch-cls" onclick="closeGenreReview()">✕</button>
      </div>
      <div class="batch-body" style="padding:14px 16px;overflow-y:auto;display:flex;flex-direction:column;gap:8px">
        <div style="display:flex;gap:8px;margin-bottom:6px">
          <button class="batch-btn ok" onclick="grAcceptAllTrusted()" style="flex:1">✓ Accepter les fiables</button>
          <button class="batch-btn" onclick="closeGenreReview()" style="flex:1">Fermer</button>
        </div>
        <div id="grList" style="display:flex;flex-direction:column;gap:6px"></div>
      </div>
    </div>`;
  _renderGenreReviewList();
  requestAnimationFrame(()=>ov.classList.add('on'));
}

function _renderGenreReviewList(){
  const list=document.getElementById('grList');
  if(!list) return;
  if(!_genreReviewData.length){
    list.innerHTML='<div style="text-align:center;color:var(--t3);padding:20px;font-size:12px">Terminé 🎉</div>';
    return;
  }
  list.innerHTML=_genreReviewData.map((e,i)=>{
    const badge=e.trusted
      ? '<span style="font-size:8px;background:var(--acc);color:#fff;padding:2px 5px;border-radius:3px;letter-spacing:.05em">FIABLE</span>'
      : '<span style="font-size:8px;background:var(--bg3);color:var(--t3);padding:2px 5px;border-radius:3px">incertain</span>';
    return `
    <div style="border:.5px solid var(--ln);border-radius:8px;padding:9px 11px;display:flex;align-items:center;gap:10px">
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;color:var(--t1);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(_displayAlbum(e.album))}</div>
        <div style="font-size:10px;color:var(--t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(e.artist)} · ${e.paths.length} morceau${e.paths.length!==1?'x':''}</div>
      </div>
      <div style="flex:1.3;text-align:center;font-size:10px;color:var(--t2)">
        <div style="color:var(--t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(e.localGenre)}</div>
        <div style="margin:1px 0">↓</div>
        <div style="color:var(--acc);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(e.cacheGenre)}</div>
      </div>
      <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
        ${badge}
        <button class="batch-btn ok" onclick="grAccept(${i})" style="padding:5px 9px;min-height:0" title="Appliquer ${esc(e.cacheGenre)}">✓</button>
        <button class="batch-btn" onclick="grReject(${i})" style="padding:5px 9px;min-height:0" title="Garder l'actuel">✕</button>
      </div>
    </div>`;
  }).join('');
}

function _grRemoveAndRefresh(idx){
  _genreReviewData.splice(idx,1);
  _renderGenreReviewList();
  const sub=document.getElementById('grSub');
  if(sub) sub.textContent=`${_genreReviewData.length} album${_genreReviewData.length!==1?'s':''} en désaccord — genres issus de MusicBrainz`;
}
function grAccept(idx){
  const e=_genreReviewData[idx]; if(!e) return;
  const n=_applyGenreToPaths(e.paths, e.cacheGenre);
  if(n>0){ scheduleMetaSave(); if(typeof renderVirtual==='function') renderVirtual(); }
  _grRemoveAndRefresh(idx);
}
function grReject(idx){ _grRemoveAndRefresh(idx); }
function grAcceptAllTrusted(){
  // Plus prudent que "tout accepter" : n'applique QUE les fiables.
  let fixed=0;
  const remaining=[];
  _genreReviewData.forEach(e=>{
    if(e.trusted){ fixed+=_applyGenreToPaths(e.paths, e.cacheGenre); }
    else remaining.push(e);
  });
  if(fixed>0){ scheduleMetaSave(); if(typeof renderVirtual==='function') renderVirtual(); }
  if(typeof toast==='function') toast(`✓ ${fixed} morceau${fixed!==1?'x':''} (fiables) corrigé${fixed!==1?'s':''}`);
  _genreReviewData=remaining;
  _renderGenreReviewList();
  const sub=document.getElementById('grSub');
  if(sub) sub.textContent=`${_genreReviewData.length} album${_genreReviewData.length!==1?'s':''} en désaccord — genres issus de MusicBrainz`;
}
function closeGenreReview(){
  const ov=document.getElementById('genreReviewOv');
  if(ov) ov.classList.remove('on');
}

// ── REVUE UNIFIÉE DES MÉTADONNÉES (année + genre, par album) ────
// Point d'entrée unique (bouton toolbar "Métadonnées"). Croise le cache
// MusicBrainz (window.wt.getMetaCache) avec le local, par album. Un même
// album peut avoir un souci d'année ET de genre → une seule ligne, les deux
// éditables côte à côte. Auto-applique le noyau sûr, met le reste en revue.
//   • Année auto : trusted + plus ancienne + écart ≥ 5 ans.
//   • Genre auto : local junk/vide + cache trusted mappable.
//   • Tout le reste (désaccords, incertains) → modale, validation humaine.
// _userModified reste sacré.

async function buildMetaDiffs(){
  if(!window.wt?.getMetaCache){
    console.warn('[metaReview] getMetaCache indisponible (Electron pas redémarré ?)');
    return { albums:[], autoYear:0, autoYearAlbums:0, autoGenre:0, autoGenreAlbums:0 };
  }
  const cache = await window.wt.getMetaCache();

  // Regroupe par artist||album (albums normaux uniquement)
  const byKey = new Map();
  const byAlbumName = new Map();
  allTracks.forEach(t=>{
    const al=t.album||''; if(!al) return;
    if(!byAlbumName.has(al)) byAlbumName.set(al,[]);
    byAlbumName.get(al).push(t);
  });
  allTracks.forEach(t=>{
    if(t._userModified) return;
    const ar=(t.artist||'').trim(), al=(t.album||'').trim();
    if(!ar||!al) return;
    const albT=byAlbumName.get(t.album)||[];
    const distinct=new Set(albT.map(x=>x.artist||'').filter(Boolean));
    if(_COMPI_RE.test(al.toLowerCase()) || distinct.size>=3) return;
    const k=ar+'||'+al;
    if(!byKey.has(k)) byKey.set(k,{artist:ar,album:al,paths:[],
      localYear:parseInt(t.year)||null, localGenre:t.genre||null});
    byKey.get(k).paths.push(t.path);
  });

  const GAP=5;
  let autoYear=0, autoYearAlbums=0, autoGenre=0, autoGenreAlbums=0;
  const albums=[];   // entrées de revue (au moins un souci non-auto)

  for(const [k,info] of byKey){
    const c=cache[k];
    if(!c) continue;

   // ── ANNÉE ──
    let yearProp=null;          // {value, trusted, gap, auto:bool}
    if(c.year){
      const cy=parseInt(c.year);
     if(!isJunkYear(cy) && info.localYear && cy!==info.localYear){
        const gap=info.localYear-cy;
        // ── FILTRE ANTI-RÉÉDITION ──────────────────────────────────
      // ── RÈGLE D'OR : COMPOSITION > RÉÉDITION ───────────────────
        // Si le cache propose une date PLUS RÉCENTE que le local (gap < 0,
        // de N'IMPORTE QUELLE AMPLEUR), c'est une réédition / compilation /
        // remaster. Le local porte déjà la date historique la plus correcte
        // qu'on a. On NE PROPOSE PAS le changement. Application mécanique
        // de la philosophie produit.
        //
        // SEULE exception : Wikipedia a explicitement renvoyé un champ d'ŒUVRE
        // (Composed/Written/Premiered/Performed) qui légitime une date plus
        // récente que le local. Phase 2 : élargi depuis 'Wikipedia (composed)'
        // strict à toute la famille des champs historiques.
        let _skip = false;
        if (gap < 0) {
          const dbg = c._debug || {};
          const isWikiHistorical = /^Wikipedia \((composed|written|premiered|performed)\)$/.test(dbg.yearSource || '');
          if (!isWikiHistorical) _skip = true;
        }
        if (!_skip) {
          // Décision de fiabilité unifiée via la cascade _decideYearTrust.
          const _td = _decideYearTrust(c, info);
          const _yTrusted = _td.trusted;
          // AUTO si fiable. La cascade a déjà tranché qu'un signal fort
          // justifie l'écriture. Pas de gap minimum.
          const auto = _yTrusted;
          yearProp={ value:cy, trusted:_yTrusted, gap, auto, _trustReason:_td.reason };
        }
      }
    }
    // ── GENRE ── (toujours bucket-à-bucket via clientMapGenre)
    let genreProp=null;         // {value(bucket), trusted, auto:bool}
    if(c.genre){
      const cacheBucket=clientMapGenre(c.genre);
      if(cacheBucket){
        const localBucket = info.localGenre ? clientMapGenre(info.localGenre) : null;
        const localJunk = isJunkGenre(info.localGenre);
        if(localJunk || !localBucket){
          // Champ vide/junk = remplissage → AUTO même si incertain (choix assumé :
          // moins de revue). Annulable + visible dans "Corrigé" avec le détail.
          const auto = true;
          genreProp={ value:cacheBucket, trusted:!!c.genreTrusted, auto, kind:'fill' };
        } else if(localBucket !== cacheBucket){
          // CONFLIT : une valeur valide DIFFÉRENTE existe déjà → jamais d'écrasement
          // silencieux, on demande à l'user (c'est le SEUL vrai cas INCERTAIN).
          genreProp={ value:cacheBucket, trusted:!!c.genreTrusted, auto:false, kind:'conflict' };
        }
      }
    }

    if(!yearProp && !genreProp) continue;

    // Applique tout de suite la partie AUTO (sûre)
    let leftoverYear=yearProp, leftoverGenre=genreProp;
    if(yearProp?.auto){
      const n=_applyYearToPaths(info.paths, yearProp.value);
      if(n>0){ autoYear+=n; autoYearAlbums++; }
      leftoverYear=null;   // traité, pas en revue
    }
    if(genreProp?.auto){
      const n=_applyGenreToPaths(info.paths, genreProp.value);
      if(n>0){ autoGenre+=n; autoGenreAlbums++; }
      leftoverGenre=null;
    }

    // Ce qui reste (non-auto) part en revue
    if(leftoverYear || leftoverGenre){
      albums.push({
        key:k, artist:info.artist, album:info.album, paths:info.paths,
        localYear:info.localYear, localGenre:info.localGenre||'(vide)',
        yearProp:leftoverYear, genreProp:leftoverGenre
      });
    }
  }

  if(autoYear>0 || autoGenre>0){
    scheduleMetaSave();
    if(typeof renderVirtual==='function') renderVirtual();
  }
  // tri : albums avec proposition année d'abord (souvent plus impactant), gros écart devant
  albums.sort((a,b)=>{
    const ga=a.yearProp?Math.abs(a.yearProp.gap):0;
    const gb=b.yearProp?Math.abs(b.yearProp.gap):0;
    return gb-ga;
  });
  return { albums, autoYear, autoYearAlbums, autoGenre, autoGenreAlbums };
}

// Point d'entrée du bouton toolbar.
async function runMetaReview(){
  // Si l'analyse de fond tourne encore, le cache est INCOMPLET. On ne bloque
  // plus (frustrant sur 1500+ albums) : on autorise la revue partielle, mais
  // on prévient explicitement. Les FIABLE s'appliquent quand même, et les
  // nouveaux résultats arriveront au prochain clic « Vérifier les infos ».
  if(_warmingMetaCache){
    if(typeof toast==='function')
      toast('⏳ Analyse en cours — résultats PARTIELS. Re-clique « Vérifier » plus tard pour le complément.', 4500);
  } else {
    if(typeof toast==='function') toast('Analyse des métadonnées…');
  }
  const res=await buildMetaDiffs();
  const autoMsg=[];
  if(res.autoYearAlbums) autoMsg.push(`${res.autoYearAlbums} année(s)`);
  if(res.autoGenreAlbums) autoMsg.push(`${res.autoGenreAlbums} genre(s)`);
  if(autoMsg.length && typeof toast==='function') toast(`✓ Auto : ${autoMsg.join(' + ')} corrigé(s)`);

  // Synchro badge split-button : douteux + manquants à jour
  if (typeof refreshReviewBadge === 'function') refreshReviewBadge();

  // On ouvre la modale dès qu'UNE des 3 sections a du contenu — pas seulement
  // si buildMetaDiffs (album-level) a trouvé des divergences. Sinon le badge
  // peut dire "71 à vérifier" (propositions track-level) alors que la modale
  // dirait "tout concorde". On teste les propositions + corrigés + sans-info.
  const tracks = Array.isArray(allTracks) ? allTracks : [];
  const hasProposed  = tracks.some(t => t && !t._userModified && !t._ignored && t._autoOutcome==='proposed' && t._autoProposal);
  const hasCorrected = tracks.some(t => t && t._autoFixed && !t._ignored);
  const hasNoinfo    = tracks.some(t => t && !t._ignored && !t._userModified && _trackIsMissing(t) && (t._autoOutcome==='empty'||t._autoOutcome==='refused'||t._autoOutcome==='error'));
  if(res.albums.length || hasProposed || hasCorrected || hasNoinfo){
    openMetaReview(res.albums);
  } else if(typeof toast==='function'){
    const _pending = (typeof countTracksToReview==='function') ? countTracksToReview() : 0;
    toast(_pending > 0
      ? `Analyse en cours — ${_pending} morceau${_pending>1?'x':''} pas encore enrichi${_pending>1?'s':''}, réessaie dans un instant`
      : 'Toutes les infos concordent ✓');
  }
}

// ── MODALE UNIFIÉE ───────────────────────────────────────────────
let _metaReviewData=[];
// Normalise les tracks "proposed" (enrichQueue) vers la forme album-entry, en
// dédupliquant contre les albums déjà couverts (l'album prime — décision validée).
function _mrCollectProposed(covered){
  const out=[]; const tracks=Array.isArray(allTracks)?allTracks:[];
  tracks.forEach(t=>{
    if(!t || t._userModified || t._ignored) return;
    if(t._autoOutcome!=='proposed' || !t._autoProposal) return;
    if(covered.has(t.path)) return;
    const ap=t._autoProposal;
    let yearProp=null, genreProp=null;
    if(ap.year && ap.year.value){
      const cy=parseInt(ap.year.value);
      if(!isJunkYear(cy) && parseInt(t.year)!==cy) yearProp={ value:cy, trusted:!!ap.year.trusted, _trustReason:(ap.year.source||'') };
    }
    if(ap.genre && ap.genre.value){
      const bucket=(typeof clientMapGenre==='function')?clientMapGenre(ap.genre.value):ap.genre.value;
      const localBucket=t.genre?((typeof clientMapGenre==='function')?clientMapGenre(t.genre):t.genre):null;
      if(bucket && bucket!==localBucket) genreProp={ value:bucket, trusted:!!ap.genre.trusted };
    }
    if(yearProp || genreProp){
      out.push({ key:'trk::'+t.path, artist:t.artist||'', album:t.album||t.title||(t.path?t.path.split('/').pop():''),
        paths:[t.path], localYear:(parseInt(t.year)||'(vide)'), localGenre:(t.genre||'(vide)'), yearProp, genreProp });
    }
  });
  return out;
}
function openMetaReview(albums){
  _metaReviewData=albums.slice();
  // Fusion : ajoute les propositions track-level non déjà couvertes par un album.
  try {
    const covered=new Set(); _metaReviewData.forEach(e=>(e.paths||[]).forEach(p=>covered.add(p)));
    const extra=_mrCollectProposed(covered);
    if(extra.length) _metaReviewData=_metaReviewData.concat(extra);
  } catch(e){ /* silent */ }
  // Expose pour diagnostic console : window._lastMetaReview.albums[*]._trustReason
  window._lastMetaReview = { albums, when: Date.now() };
  // Raccourcis clavier : Espace=OK, Suppr=Skip, P=Play, A=Accept all, Esc=ferme
  _mrAttachKeys();
  let ov=document.getElementById('metaReviewOv');
  if(!ov){
    ov=document.createElement('div');
    ov.className='batch-ov'; ov.id='metaReviewOv';
    ov.addEventListener('click',e=>{ if(e.target===ov) closeMetaReview(); });
    document.body.appendChild(ov);
  }
  _mrActiveTab = _mrActiveTab || 'pending';
  ov.innerHTML=`
    <div class="batch-box" style="width:900px;max-width:94vw;max-height:84vh">
      <div class="batch-hd">
        <div>
          <div class="batch-title">Réviser les métadonnées</div>
          <div id="mrSub" style="font-size:11px;color:var(--t3);margin-top:2px"></div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="batch-btn ok" onclick="mrAcceptAllProps()" title="Applique d'un coup toutes les propositions de l'onglet « En attente » (annulable depuis « Corrigé »)">Tout accepter (en attente)</button>
          <button class="batch-cls" onclick="closeMetaReview()">✕</button>
        </div>
      </div>
      <div class="mr-tabs" style="padding:0 16px">
        <button class="mr-tab" data-mr-tab="pending" onclick="_mrSwitchTab('pending')">En attente <span class="mr-tab-n" id="mrN-pending">0</span></button>
        <button class="mr-tab" data-mr-tab="corrected" onclick="_mrSwitchTab('corrected')">Corrigé <span class="mr-tab-n" id="mrN-corrected">0</span></button>
        <button class="mr-tab" data-mr-tab="noinfo" onclick="_mrSwitchTab('noinfo')">Aucune info <span class="mr-tab-n" id="mrN-noinfo">0</span></button>
      </div>
      <div class="batch-body" style="padding:14px 16px;overflow-y:auto;display:flex;flex-direction:column;gap:8px">
        <div id="mrSecPending" class="mr-sec"></div>
        <div id="mrSecCorrected" class="mr-sec"></div>
        <div id="mrSecNoinfo" class="mr-sec"></div>
      </div>
    </div>`;
  _mrRenderAll();
  requestAnimationFrame(()=>ov.classList.add('on'));
}

// Onglet actif courant (persiste entre les re-renders d'une même session modale).
let _mrActiveTab = 'pending';
function _mrSwitchTab(tab){
  _mrActiveTab = tab;
  document.querySelectorAll('.mr-tab').forEach(b=>b.classList.toggle('on', b.getAttribute('data-mr-tab')===tab));
  document.getElementById('mrSecPending').classList.toggle('on', tab==='pending');
  document.getElementById('mrSecCorrected').classList.toggle('on', tab==='corrected');
  document.getElementById('mrSecNoinfo').classList.toggle('on', tab==='noinfo');
}
// Rend les 3 sections + compteurs d'onglets, puis applique l'onglet actif.
function _mrRenderAll(){
  if(typeof _mrCollectExtras==='function') _mrCollectExtras();
  _renderMetaReviewList();
  _renderMetaReviewCorrected();
  _renderMetaReviewNoinfo();
  const nP=_metaReviewData.length, nC=_mrCorrected.length, nN=_mrNoinfo.length;
  const setN=(id,n)=>{ const el=document.getElementById(id); if(el) el.textContent=n; };
  setN('mrN-pending',nP); setN('mrN-corrected',nC); setN('mrN-noinfo',nN);
  const sub=document.getElementById('mrSub');
  if(sub) sub.textContent = `${nP} à examiner · le reste géré tout seul`;
  _mrSwitchTab(_mrActiveTab);
}

function _genreOptions(selected){
  let html='<option value="">— garder l\'actuel —</option>';
  GENRE_15_LIST.forEach(p=>{
    const kids=(typeof CHILDREN_BY_PARENT!=='undefined' && CHILDREN_BY_PARENT[p])?CHILDREN_BY_PARENT[p]:[];
    html+=`<optgroup label="${esc(p)}">`;
    html+=`<option value="${esc(p)}"${p===selected?' selected':''}>${esc(p)} — tout</option>`;
    kids.forEach(c=>{
      html+=`<option value="${esc(c)}"${c===selected?' selected':''}>· ${esc(c)}</option>`;
    });
    html+='</optgroup>';
  });
  return html;
}

// Petite pastille ronde de couleur du genre (charte _GENRE_COLOR_MAP)
function _genreDot(genre){
  const c = (typeof getGenreColor==='function') ? getGenreColor(genre) : '#AEACA6';
  return `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${c};flex-shrink:0;box-shadow:0 0 0 1px rgba(0,0,0,.3)"></span>`;
}

// Badge fiable / incertain, plus lisible (vert = fiable, ambré sourd = incertain).
// `reason` (optionnel) = code de la cascade _decideYearTrust, affiché en tooltip
// pour comprendre POURQUOI un cas est classé fiable/incertain sans encombrer.
function _mrBadge(trusted, reason){
  const t = reason ? ` title="${esc(String(reason))}"` : '';
  return trusted
    ? `<span${t} style="font-size:8px;font-weight:600;background:rgba(76,175,80,.18);color:#6FCF77;padding:2px 6px;border-radius:4px;letter-spacing:.04em;white-space:nowrap;cursor:help">✓ FIABLE</span>`
    : `<span${t} style="font-size:8px;font-weight:600;background:rgba(232,168,124,.14);color:#E8A87C;padding:2px 6px;border-radius:4px;letter-spacing:.04em;white-space:nowrap;cursor:help">? INCERTAIN</span>`;
}

function _renderMetaReviewList(){
  const list=document.getElementById('mrSecPending');
  if(!list) return;
  if(!_metaReviewData.length){
    list.innerHTML='<div class="mr-empty">Rien à réviser 🎉</div>';
    return;
  }
  list.innerHTML=_metaReviewData.map((e,i)=>{
    // — bloc année —
    let yearBlock='<div style="font-size:10px;color:var(--t3);align-self:center">—</div>';
    if(e.yearProp){
      const yp=e.yearProp;
      yearBlock=`
        <div style="display:flex;flex-direction:column;gap:6px;font-size:11px">
          <div style="display:flex;align-items:center;gap:6px">
            <span style="color:var(--t2)">${e.localYear}</span>
            <span style="color:var(--t3)">→</span>
            <span style="color:var(--acc);font-weight:700">${yp.value}</span>
            ${_mrBadge(yp.trusted, yp._trustReason)}
          </div>
          <div style="display:flex;align-items:center;gap:6px">
            <input type="number" value="${yp.value}" data-mr-year="${i}"
                   style="width:62px;background:rgba(0,0,0,.4);border:.5px solid var(--ln);border-radius:5px;color:var(--t1);font-size:11px;padding:4px 6px" />
            <button class="batch-btn ok" onclick="mrApplyYear(${i})" style="padding:4px 9px;min-height:0" title="Appliquer cette année">✓</button>
          </div>
        </div>`;
    }
    // — bloc genre — (pastilles couleur charte + dropdown coloré)
    let genreBlock='<div style="font-size:10px;color:var(--t3);align-self:center">—</div>';
    if(e.genreProp){
      const gp=e.genreProp;
      const propColor=(typeof getGenreColor==='function')?getGenreColor(gp.value):'#AEACA6';
      genreBlock=`
        <div style="display:flex;flex-direction:column;gap:6px;font-size:11px">
          <div style="display:flex;align-items:center;gap:6px;min-width:0">
            ${_genreDot(e.localGenre)}
            <span style="color:var(--t2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px">${esc(e.localGenre)}</span>
            <span style="color:var(--t3)">→</span>
            ${_mrBadge(gp.trusted)}
          </div>
          <div style="display:flex;align-items:center;gap:6px">
            ${_genreDot(gp.value)}
            <select data-mr-genre="${i}" onchange="_mrGenreDotUpdate(${i},this.value)"
                    style="flex:1;min-width:0;background:rgba(0,0,0,.4);border:.5px solid ${propColor}66;border-radius:5px;color:var(--t1);font-size:11px;padding:4px 6px;max-width:190px">
              ${_genreOptions(gp.value)}
            </select>
            <button class="batch-btn ok" onclick="mrApplyGenre(${i})" style="padding:4px 9px;min-height:0" title="Appliquer ce genre">✓</button>
          </div>
          <div style="display:flex;align-items:center;gap:6px;font-size:10.5px">
            <input data-mr-newchild="${i}" placeholder="+ nouveau sous-genre…" oninput="_mrNewChildInput(${i})"
                   style="flex:1;min-width:0;max-width:150px;background:rgba(0,0,0,.3);border:.5px solid var(--ln);border-radius:5px;color:var(--t1);font-size:10.5px;padding:3px 6px" />
            <select data-mr-newparent="${i}" title="Parent de ce sous-genre"
                    style="display:none;background:rgba(0,0,0,.4);border:.5px solid var(--ln);border-radius:5px;color:var(--t1);font-size:10.5px;padding:3px 6px;max-width:130px">
              ${_parentOptions('')}
            </select>
            <span data-mr-newhint="${i}" style="color:var(--t3);font-size:9.5px"></span>
            <button class="batch-btn" onclick="_mrAddNewChild(${i})" style="padding:3px 8px;min-height:0" title="Créer ce sous-genre et l'appliquer">+</button>
          </div>
        </div>`;
    }
    return `
    <div class="mr-row" style="display:grid;grid-template-columns:minmax(170px,1.1fr) minmax(170px,.9fr) minmax(230px,1.2fr) auto;gap:12px;align-items:start;border:.5px solid var(--ln);border-radius:9px;padding:10px 12px;background:rgba(255,255,255,.012)">
      <div style="min-width:0;display:flex;flex-direction:column;gap:6px">
        <div>
          <div style="font-size:12.5px;color:var(--t1);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(_displayAlbum(e.album))}</div>
          <div style="font-size:10px;color:var(--t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(e.artist)} · ${e.paths.length} morceau(x)</div>
        </div>
        <button class="batch-btn" onclick="mrPlayFirst(${i})" style="padding:4px 8px;min-height:0;background:transparent;border-color:var(--ln);align-self:flex-start;display:inline-flex;align-items:center;gap:5px" title="Écouter le 1er morceau (vérification à l'oreille)">
          <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor" style="display:block"><path d="M8 5v14l11-7z"/></svg><span style="font-size:9.5px">Écouter</span>
        </button>
      </div>
      ${yearBlock}
      ${genreBlock}
      <div style="display:flex;flex-direction:column;gap:5px;align-items:stretch">
        <button class="batch-btn ok" onclick="mrAcceptAllForArtist(${i})" style="padding:4px 8px;min-height:0;white-space:nowrap;font-size:10px" title="Accepter d'un coup toutes les propositions de cet artiste (chaque album garde son genre)">✓ tout l'artiste</button>
        <button class="batch-btn" onclick="mrIgnoreLine(${i})" style="padding:4px 8px;min-height:0;font-size:10px" title="Ne plus vérifier">Ignorer</button>
        <button class="batch-btn" onclick="mrReject(${i})" style="padding:4px 8px;min-height:0;font-size:10px" title="Passer (ne pas toucher)">Passer</button>
      </div>
    </div>`;
  }).join('');
  // Barre d'outils + en-têtes de colonnes AU-DESSUS de la liste
  list.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:2px">
      <button class="batch-btn ok" onclick="mrAcceptAllTrustedYears()" style="padding:5px 10px;min-height:0" title="Applique d'un coup toutes les ANNÉES marquées ✓ FIABLE (les incertaines restent à examiner)">✓ Toutes années fiables</button>
      <button class="batch-btn ok" onclick="mrAcceptAllTrustedGenres()" style="padding:5px 10px;min-height:0" title="Applique d'un coup tous les GENRES marqués ✓ FIABLE (les incertains restent à examiner)">✓ Tous genres fiables</button>
      <span style="margin-left:auto;font-size:9.5px;color:var(--t3)">n'applique que les propositions ✓ FIABLE</span>
    </div>
    <div style="display:grid;grid-template-columns:minmax(170px,1.1fr) minmax(170px,.9fr) minmax(230px,1.2fr) auto;gap:12px;padding:0 12px;font-size:9px;font-weight:700;letter-spacing:.06em;color:var(--t3);text-transform:uppercase">
      <span>Album</span><span>Année</span><span>Genre</span><span style="min-width:92px"></span>
    </div>` + list.innerHTML;
}

// Met à jour la pastille couleur quand on change le genre dans le dropdown
function _mrGenreDotUpdate(idx, value){
  const sel=document.querySelector(`[data-mr-genre="${idx}"]`);
  if(!sel) return;
  const dot=sel.parentElement.querySelector('span');  // la pastille précède le select
  const c=(typeof getGenreColor==='function')?getGenreColor(value):'#AEACA6';
  if(dot) dot.style.background=c;
  sel.style.borderColor=c+'66';
}

// Options <option> des 16 parents (pour le sélecteur de parent d'un nouvel enfant).
function _parentOptions(selected){
  let html='<option value="">— parent ? —</option>';
  GENRE_15_LIST.forEach(p=>{ html+=`<option value="${esc(p)}"${p===selected?' selected':''}>${esc(p)}</option>`; });
  return html;
}
// À chaque frappe dans le champ "nouveau sous-genre" : tente de résoudre le parent
// automatiquement. Si trouvé → on l'affiche et on cache le sélecteur manuel. Sinon
// → on révèle le sélecteur de parent (choix obligatoire avant création).
function _mrNewChildInput(idx){
  const inp=document.querySelector(`[data-mr-newchild="${idx}"]`);
  const psel=document.querySelector(`[data-mr-newparent="${idx}"]`);
  const hint=document.querySelector(`[data-mr-newhint="${idx}"]`);
  if(!inp||!psel||!hint) return;
  const v=inp.value.trim();
  if(!v){ psel.style.display='none'; hint.textContent=''; return; }
  const auto=(typeof resolveChildParent==='function') ? resolveChildParent(v) : null;
  if(auto){
    psel.style.display='none';
    hint.textContent='→ '+auto;
    hint.style.color='var(--t3)';
  } else {
    psel.style.display='';
    hint.textContent='parent requis';
    hint.style.color='var(--acc)';
  }
}
// Crée le sous-genre saisi et l'applique aux morceaux de la ligne. Garantit un
// parent (auto-résolu, sinon celui choisi dans le sélecteur). Refuse si aucun.
function _mrAddNewChild(idx){
  const e=_metaReviewData[idx]; if(!e) return;
  const inp=document.querySelector(`[data-mr-newchild="${idx}"]`);
  const psel=document.querySelector(`[data-mr-newparent="${idx}"]`);
  if(!inp) return;
  const child=inp.value.trim();
  if(!child){ if(typeof toast==='function') toast('Tape un sous-genre'); return; }
  let parent=(typeof resolveChildParent==='function') ? resolveChildParent(child) : null;
  if(!parent && psel) parent=psel.value;
  if(!parent){ if(typeof toast==='function') toast('Choisis un parent pour « '+child+' »'); if(psel) psel.style.display=''; return; }
  if(typeof setChildParent==='function') setChildParent(child, parent);
  let changed=0;
  if(typeof _applyGenreToPaths==='function') changed=_applyGenreToPaths(e.paths, parent, child);
  if(changed>0){ if(typeof scheduleMetaSave==='function') scheduleMetaSave(); if(typeof renderVirtual==='function') renderVirtual(); }
  if(typeof toast==='function') toast('« '+child+' » → '+parent);
  _mrRemove(idx);
}

function _mrRefreshSub(){
  const sub=document.getElementById('mrSub');
  if(sub) sub.textContent=`${_metaReviewData.length} à examiner · le reste géré tout seul`;
  const setN=(id,n)=>{ const el=document.getElementById(id); if(el) el.textContent=n; };
  setN('mrN-pending', _metaReviewData.length);
  setN('mrN-corrected', (_mrCorrected||[]).length);
  setN('mrN-noinfo', (_mrNoinfo||[]).length);
}
function _mrRemove(idx){ _metaReviewData.splice(idx,1); _renderMetaReviewList(); _mrRefreshSub(); }

// ── Acceptation en masse PAR CHAMP, limitée aux propositions ✓ FIABLE ──
// Les incertaines restent listées : on automatise le sûr, on garde l'humain
// pour le douteux (philosophie). Parcours descendant : les splices ne
// décalent pas les index restants.
function mrAcceptAllTrustedYears(){
  let applied = 0, lines = 0;
  for (let i = _metaReviewData.length - 1; i >= 0; i--) {
    const e = _metaReviewData[i];
    if (!e || !e.yearProp || !e.yearProp.trusted) continue;
    const y = parseInt(e.yearProp.value);
    if (!isJunkYear(y)) { applied += _applyYearToPaths(e.paths, y); lines++; }
    e.yearProp = null;
    if (!e.genreProp) _metaReviewData.splice(i, 1);
  }
  if (applied > 0) { scheduleMetaSave(); if (typeof renderVirtual === 'function') renderVirtual(); }
  _mrRenderAll();
  if (typeof refreshReviewBadge === 'function') refreshReviewBadge();
  if (typeof toast === 'function') toast(lines ? `✓ Années fiables appliquées : ${lines} album(s), ${applied} morceau(x)` : 'Aucune année ✓ FIABLE en attente');
}
function mrAcceptAllTrustedGenres(){
  let applied = 0, lines = 0;
  for (let i = _metaReviewData.length - 1; i >= 0; i--) {
    const e = _metaReviewData[i];
    if (!e || !e.genreProp || !e.genreProp.trusted) continue;
    const val = e.genreProp.value;
    if (val) {
      const isParent = (GENRE_15_LIST.indexOf(val) !== -1);
      if (isParent) { applied += _applyGenreToPaths(e.paths, val, ''); lines++; }
      else {
        const par = (typeof resolveChildParent === 'function') ? resolveChildParent(val) : null;
        if (par) { if (typeof setChildParent === 'function') setChildParent(val, par); applied += _applyGenreToPaths(e.paths, par, val); lines++; }
        else continue; // enfant sans parent résoluble : reste à examiner à la main
      }
    }
    e.genreProp = null;
    if (!e.yearProp) _metaReviewData.splice(i, 1);
  }
  if (applied > 0) { scheduleMetaSave(); if (typeof renderVirtual === 'function') renderVirtual(); }
  _mrRenderAll();
  if (typeof refreshReviewBadge === 'function') refreshReviewBadge();
  if (typeof toast === 'function') toast(lines ? `✓ Genres fiables appliqués : ${lines} album(s), ${applied} morceau(x)` : 'Aucun genre ✓ FIABLE en attente');
}

// ── Collecte des sections "Corrigé auto" et "Aucune info" depuis allTracks ──
let _mrCorrected = [];
let _mrNoinfo = [];
function _mrCollectExtras(){
  const tracks = Array.isArray(allTracks) ? allTracks : [];
  _mrCorrected = tracks.filter(t => t && t._autoFixed && !t._ignored && !t._autoFixSeen);
  _mrNoinfo = tracks.filter(t => t && !t._ignored && !t._userModified && _trackIsMissing(t) &&
    (t._autoOutcome==='empty' || t._autoOutcome==='refused' || t._autoOutcome==='error'));
}
// Section "Corrigé automatiquement" : info + Annuler par ligne.
function _renderMetaReviewCorrected(){
  const box=document.getElementById('mrSecCorrected');
  if(!box) return;
  if(!_mrCorrected.length){ box.innerHTML='<div class="mr-empty">Rien de corrigé automatiquement pour l’instant</div>'; return; }
  const _corrHdr=`<div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:8px">
      <button class="batch-btn" onclick="mrSeenAllCorrected()" style="padding:4px 9px;min-height:0" title="Marquer tout comme vu (retirer de la liste)">✓ Tout vu</button>
      <button class="batch-btn" onclick="mrUndoAllAuto()" style="padding:4px 9px;min-height:0" title="Annuler TOUTES les corrections auto (restaure les valeurs d'avant)">↩ Tout annuler</button>
    </div>`;
  // Regroupement par artiste PRINCIPAL (collabs rattachées, cf _corrGroupKey),
  // en gardant l'index d'origine de chaque morceau dans _mrCorrected.
  const _solo=_corrSoloKeys(_mrCorrected.slice(0,400));
  const _groups=[]; const _gmap=new Map();
  _mrCorrected.slice(0,400).forEach((t,i)=>{
    const gi=_corrGroupKey(t,_solo);
    let g=_gmap.get(gi.key);
    if(!g){ g={key:gi.key, name:gi.name||'Artiste inconnu', firstIndex:i, items:[]}; _gmap.set(gi.key,g); _groups.push(g); }
    g.items.push({t,i,feat:gi.feat});
  });
  const _row=(t,i,feat)=>{
    const fx=t._autoFix||{};
    const bits=[];
    if(feat) bits.push(`feat. ${esc(feat)}`);
    if(fx.year) bits.push(`année ${esc(String((fx.year.from)||'vide'))} → ${esc(String(fx.year.to))}`);
    if(fx.genre) bits.push(`genre ${esc(String((fx.genre.from)||'vide'))} → ${esc(String(fx.genre.to))}`);
    if(fx.album) bits.push(`album ${esc(String((fx.album.from)||'vide'))} → ${esc(String(fx.album.to))}`);
    if(fx.artist) bits.push(`artiste ${esc(String((fx.artist.from)||'vide'))} → ${esc(String(fx.artist.to))}`);
    return `<div style="border:.5px solid var(--ln);border-radius:8px;padding:7px 10px;display:flex;align-items:center;gap:6px;background:rgba(76,175,80,.05);margin:3px 0 3px 14px">
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;color:var(--t1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.title||(t.path?t.path.split('/').pop():''))}</div>
        <div style="font-size:10px;color:#6FCF77;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${bits.join(' · ')||'corrigé'}</div>
      </div>
      <button class="batch-btn" onclick="mrPlayCorrected(${i})" style="padding:4px 7px;min-height:0" title="Écouter ce morceau" aria-label="Écouter">▶</button>
      <button class="batch-btn" onclick="mrEditCorrected(${i})" style="padding:4px 7px;min-height:0" title="Éditer (genre, année, titre, artiste, album, pochette + recherche)" aria-label="Éditer">✎</button>
      <button class="batch-btn" onclick="mrSeenCorrected(${i})" style="padding:4px 7px;min-height:0" title="Marquer comme vu (retirer de la liste)" aria-label="Vu">✓</button>
      <button class="batch-btn" onclick="mrUndoAuto(${i})" style="padding:4px 7px;min-height:0" title="Annuler cette correction automatique" aria-label="Annuler">↩</button>
      <button class="batch-btn" onclick="mrIgnoreCorrected(${i})" style="padding:4px 6px;min-height:0" title="Annuler et ne plus jamais proposer" aria-label="Ignorer">⊘</button>
    </div>`;
  };
  box.innerHTML=_corrHdr+_groups.map(g=>{
    const head=`<div style="display:flex;align-items:center;gap:8px;margin:10px 0 2px 0">
        <div style="flex:1;min-width:0;font-size:12px;font-weight:600;color:var(--t1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(g.name)} <span style="color:var(--t3);font-weight:400">· ${g.items.length} corrigé${g.items.length>1?'s':''}</span></div>
        <button class="batch-btn" onclick="mrSeenAllForArtist(${g.firstIndex})" style="padding:3px 9px;min-height:0;white-space:nowrap" title="Marquer « vu » tous les morceaux corrigés de cet artiste">✓ Vu l'artiste</button>
      </div>`;
    return head+g.items.map(({t,i,feat})=>_row(t,i,feat)).join('');
  }).join('');
}
// Section "Aucune info trouvée" : Éditer (modale Identifier) + ⊘ ignorer.
function _renderMetaReviewNoinfo(){
  const box=document.getElementById('mrSecNoinfo');
  if(!box) return;
  if(!_mrNoinfo.length){ box.innerHTML='<div class="mr-empty">Aucun morceau sans info</div>'; return; }
  box.innerHTML=_mrNoinfo.slice(0,400).map((t,i)=>{
    return `<div style="border:.5px solid var(--ln);border-radius:9px;padding:9px 12px;display:flex;align-items:center;gap:10px">
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;color:var(--t2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.title||(t.path?t.path.split('/').pop():''))}</div>
        <div style="font-size:10px;color:var(--t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.artist||'')} · ${esc(_displayAlbum(t.album))}</div>
      </div>
      <button class="batch-btn" onclick="mrPlayNoinfo(${i})" style="padding:4px 9px;min-height:0" title="Écouter ce morceau" aria-label="Écouter">▶</button>
      <button class="batch-btn" onclick="mrEditNoinfo(${i})" style="padding:4px 9px;min-height:0" title="Éditer à la main">✎ Éditer</button>
      <button class="batch-btn" onclick="mrIgnoreNoinfo(${i})" style="padding:4px 8px;min-height:0" title="Ne plus vérifier" aria-label="Ne plus vérifier">⊘</button>
    </div>`;
  }).join('');
}
// Annule une correction auto (restaure les valeurs d'avant, rouvre à la revue).
function mrUndoAuto(i){
  const t=_mrCorrected[i]; if(!t) return;
  const fx=t._autoFix||{};
  if(fx.year && typeof fx.year.from!=='undefined') t.year=fx.year.from;
  if(fx.genre && typeof fx.genre.from!=='undefined') t.genre=fx.genre.from;
  if(fx.album && typeof fx.album.from!=='undefined'){ t.album=fx.album.from; t._clearAlbumOverride=true; }
  if(fx.artist && typeof fx.artist.from!=='undefined'){ t.artist=fx.artist.from; t._clearArtistOverride=true; }
  delete t._autoFixed; delete t._autoFix; t._userModified=false;
  const noG=!t.genre || (typeof isJunkGenre==='function' && isJunkGenre(t.genre));
  const noY=!t.year || (typeof isJunkYear==='function' && isJunkYear(t.year));
  if(noG||noY) t._incomplete=true; else delete t._incomplete;
  if(typeof scheduleMetaSave==='function') scheduleMetaSave();
  if(typeof renderVirtual==='function') renderVirtual();
  if(typeof refreshReviewBadge==='function') refreshReviewBadge();
  _mrCollectExtras(); _renderMetaReviewCorrected(); _mrRefreshSub();
}
// Marque une correction auto comme « vue » → la retire de la liste « Corrigé ».
// Vue de session : la correction est déjà appliquée et persistée, c'est un simple
// acquittement visuel (aucun tag modifié). _autoFixSeen vit en mémoire de session.
function mrSeenCorrected(i){
  const t=_mrCorrected[i]; if(!t) return;
  t._autoFixSeen=true;
  _mrCollectExtras(); _renderMetaReviewCorrected(); _mrRefreshSub();
}
function mrSeenAllCorrected(){
  (_mrCorrected||[]).forEach(t=>{ if(t) t._autoFixSeen=true; });
  _mrCollectExtras(); _renderMetaReviewCorrected(); _mrRefreshSub();
}
// Marque « vu » tous les morceaux corrigés du MÊME artiste (acquittement de
// session, aucun tag touché) → décider une fois par artiste dans « Corrigé ».
function mrSeenAllForArtist(i){
  const ref=_mrCorrected[i]; if(!ref) return;
  const solo=_corrSoloKeys(_mrCorrected);
  const k=_corrGroupKey(ref,solo).key;
  (_mrCorrected||[]).forEach(t=>{ if(t && _corrGroupKey(t,solo).key===k) t._autoFixSeen=true; });
  _mrCollectExtras(); _renderMetaReviewCorrected(); _mrRefreshSub();
}
// Ouvre l'éditeur complet ("Identifier le morceau") sur un morceau corrigé, pour
// rectifier à la main n'importe quel champ (genre/année/titre/artiste/album/cover).
function mrEditCorrected(i){
  const t=_mrCorrected[i]; if(!t) return;
  if(typeof openOmniEditor==='function'){ closeMetaReview(); openOmniEditor([t]); }
  else if(typeof toast==='function') toast('Éditeur indisponible');
}
// Ignorer depuis « Corrigé » : la correction auto était fausse (ex. Pasaca) →
// on ANNULE d'abord le genre/année posés, puis on marque ignoré (persisté).
// Combiné au skip dans _processItem, le morceau ne sera plus jamais re-proposé.
function mrIgnoreCorrected(i){
  const t=_mrCorrected[i]; if(!t) return;
  const fx=t._autoFix||{};
  if(fx.year  && typeof fx.year.from!=='undefined')  t.year =fx.year.from;
  if(fx.genre && typeof fx.genre.from!=='undefined') t.genre=fx.genre.from;
  if(fx.album && typeof fx.album.from!=='undefined'){ t.album=fx.album.from; t._clearAlbumOverride=true; }
  if(fx.artist && typeof fx.artist.from!=='undefined'){ t.artist=fx.artist.from; t._clearArtistOverride=true; }
  delete t._autoFixed; delete t._autoFix;
  const noG=!t.genre || (typeof isJunkGenre==='function' && isJunkGenre(t.genre));
  const noY=!t.year  || (typeof isJunkYear==='function'  && isJunkYear(t.year));
  if(noG||noY) t._incomplete=true; else delete t._incomplete;
  if(typeof setIgnoredForReview==='function') setIgnoredForReview([t], true);
  if(typeof renderVirtual==='function') renderVirtual();
  _mrCollectExtras(); _renderMetaReviewCorrected(); _mrRefreshSub();
}
// Ouvre la modale d'édition existante ("Identifier le morceau") sur le morceau.
function mrEditNoinfo(i){
  const t=_mrNoinfo[i]; if(!t) return;
  if(typeof openOmniEditor==='function'){ closeMetaReview(); openOmniEditor([t]); }
  else if(typeof toast==='function') toast('Éditeur indisponible');
}
// Pose _ignored sur un morceau "aucune info" et le retire de la section.
function mrIgnoreNoinfo(i){
  const t=_mrNoinfo[i]; if(!t) return;
  if(typeof setIgnoredForReview==='function') setIgnoredForReview([t], true);
  _mrCollectExtras(); _renderMetaReviewNoinfo(); _mrRefreshSub();
}
// Ignore une ligne "en attente" (pose _ignored sur tous ses morceaux).
function mrIgnoreLine(idx){
  const e=_metaReviewData[idx]; if(!e) return;
  const ts=(e.paths||[]).map(p=>allTracks.find(x=>x.path===p)).filter(Boolean);
  if(typeof setIgnoredForReview==='function') setIgnoredForReview(ts, true);
  _mrRemove(idx);
}
// Accept par champ : applique UNIQUEMENT l'année de la ligne.
function mrApplyYear(idx){
  const e=_metaReviewData[idx]; if(!e || !e.yearProp) return;
  const yIn=document.querySelector(`[data-mr-year="${idx}"]`);
  const y=yIn?parseInt(yIn.value):e.yearProp.value;
  let changed=0;
  if(!isJunkYear(y)) changed+=_applyYearToPaths(e.paths, y);
  if(changed>0){ scheduleMetaSave(); if(typeof renderVirtual==='function') renderVirtual(); }
  e.yearProp=null;
  if(!e.genreProp){ _mrRemove(idx); } else { _renderMetaReviewList(); _mrRefreshSub(); }
}
// Accept par champ : applique UNIQUEMENT le genre (parent OU enfant via garant).
function mrApplyGenre(idx){
  const e=_metaReviewData[idx]; if(!e || !e.genreProp) return;
  const gSel=document.querySelector(`[data-mr-genre="${idx}"]`);
  const val=gSel?gSel.value:e.genreProp.value;
  let changed=0;
  if(val){
    const isParent=(GENRE_15_LIST.indexOf(val)!==-1);
    if(isParent){ changed+=_applyGenreToPaths(e.paths, val, ''); }
    else {
      const par=(typeof resolveChildParent==='function')?resolveChildParent(val):null;
      if(par){ if(typeof setChildParent==='function') setChildParent(val,par); changed+=_applyGenreToPaths(e.paths, par, val); }
      else { if(typeof toast==='function') toast('Choisis un parent pour « '+val+' »'); return; }
    }
  }
  if(changed>0){ scheduleMetaSave(); if(typeof renderVirtual==='function') renderVirtual(); }
  e.genreProp=null;
  if(!e.yearProp){ _mrRemove(idx); } else { _renderMetaReviewList(); _mrRefreshSub(); }
}

// Applique ce qui est affiché dans les champs de la ligne (année input + genre select)
function mrApply(idx){
  const e=_metaReviewData[idx]; if(!e) return;
  let changed=0;
  const yIn=document.querySelector(`[data-mr-year="${idx}"]`);
  if(yIn){
    const y=parseInt(yIn.value);
    if(!isJunkYear(y)) changed+=_applyYearToPaths(e.paths, y);
  }
  const gSel=document.querySelector(`[data-mr-genre="${idx}"]`);
  if(gSel && gSel.value){
    const val=gSel.value;
    // val est soit un PARENT (un des 16), soit un ENFANT. On garantit toujours
    // un couple parent+enfant cohérent via le garant universel.
    const isParent = (GENRE_15_LIST.indexOf(val) !== -1);
    if(isParent){
      changed+=_applyGenreToPaths(e.paths, val, '');
    } else {
      const par=(typeof resolveChildParent==='function') ? resolveChildParent(val) : null;
      if(par){
        if(typeof setChildParent==='function') setChildParent(val, par);
        changed+=_applyGenreToPaths(e.paths, par, val);
      } else {
        // indécidable : on n'attribue pas d'orphelin. Toast + on garde la ligne.
        if(typeof toast==='function') toast('Choisis un parent pour « '+val+' »');
        return;
      }
    }
  }
  if(changed>0){ scheduleMetaSave(); if(typeof renderVirtual==='function') renderVirtual(); }
  _mrRemove(idx);
}
function mrReject(idx){ _mrRemove(idx); }

// Joue le 1er morceau de l'album pour validation à l'oreille — le filet humain
// ultime quand la cascade hésite. Pas de toast spécifique (playGroup en pose
// déjà un), la modale reste ouverte au-dessus du player.
function mrPlayFirst(idx){
  const e = _metaReviewData[idx]; if(!e) return;
  const path = e.paths && e.paths[0]; if(!path) return;
  const track = (typeof allTracks!=='undefined' ? allTracks : []).find(t => t.path === path);
  if(!track){ if(typeof toast==='function') toast('Morceau introuvable sur le disque'); return; }
  if(typeof playGroup==='function'){
    playGroup([track], 'album', `${e.album} (vérif)`);
  }
}
// Lecture d'un morceau isolé depuis les sections « Aucune info » / « Corrigé ».
function _mrPlayTrackObj(t){
  if(!t || !t.path){ if(typeof toast==='function') toast('Morceau introuvable sur le disque'); return; }
  if(typeof playGroup==='function') playGroup([t], 'album', `${t.artist||''} — vérif`);
}
function mrPlayNoinfo(i){ _mrPlayTrackObj((_mrNoinfo||[])[i]); }
function mrPlayCorrected(i){ _mrPlayTrackObj((_mrCorrected||[])[i]); }

// ── Raccourcis clavier dans la modale ──────────────────────────────
// Espace = OK sur la 1re entrée · Suppr/Backspace = Skip · P = Play
// A = Accept all trusted · Esc = ferme. On agit toujours sur l'index 0
// (l'entrée la plus haute) parce qu'après chaque OK/Skip le tableau se
// décale, donc la prochaine devient la 1re. Simple et sans état curseur.
let _mrKeyHandlerRef = null;
function _mrKeyHandler(ev){
  const ov = document.getElementById('metaReviewOv');
  if(!ov || !ov.classList.contains('on')) return;
  // Ne pas voler les touches si l'utilisateur édite un champ
  const ae = document.activeElement;
  if(ae && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return;
  // Laisser passer les modificateurs (cmd+R, etc.)
  if(ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const k = ev.key;
  if(k === ' ')                         { ev.preventDefault(); if(_metaReviewData[0]){ if(_metaReviewData[0].yearProp) mrApplyYear(0); else if(_metaReviewData[0].genreProp) mrApplyGenre(0); } }
  else if(k === 'Delete' || k === 'Backspace') { ev.preventDefault(); mrReject(0); }
  else if(k === 'p' || k === 'P')       { ev.preventDefault(); mrPlayFirst(0); }
 else if(k === 'a' || k === 'A')       { ev.preventDefault(); mrAcceptAllTrusted(); }
  else if(k === 'y' || k === 'Y')       { ev.preventDefault(); mrAcceptAllYears(); }
  else if(k === 'Escape')               { ev.preventDefault(); closeMetaReview(); }
}
function _mrAttachKeys(){
  if(_mrKeyHandlerRef) return;
  _mrKeyHandlerRef = _mrKeyHandler;
  document.addEventListener('keydown', _mrKeyHandlerRef);
}
function _mrDetachKeys(){
  if(!_mrKeyHandlerRef) return;
  document.removeEventListener('keydown', _mrKeyHandlerRef);
  _mrKeyHandlerRef = null;
}

// N'applique QUE les propositions fiables (year trusted + genre trusted),
// avec leurs valeurs proposées (pas les éditions manuelles non confirmées).
// Bouton "Toutes les années" : force l'application de TOUTES les yearProp
// (fiables ET incertaines), sans toucher aux genres. C'est la stratégie de
// double vérification : on automatise les années en masse (le filtre anti-
// réédition en amont a déjà bloqué les fausses corrections), puis on garde
// les genres en revue manuelle pour un futur système plus précis.
// Les entries qui n'avaient QUE du year disparaissent de la modale ; celles
// avec un genreProp restant restent affichées, mais sans le year désormais.
function mrAcceptAllYears(){
  let fixed=0; const remaining=[];
  _metaReviewData.forEach(e=>{
    if(e.yearProp){
      const n = _applyYearToPaths(e.paths, e.yearProp.value);
      if(n>0) fixed += n;
    }
    // Conserve l'entry SEULEMENT si elle a un genre à valider
    if(e.genreProp){
      remaining.push({...e, yearProp:null});
    }
  });
  if(fixed>0){ scheduleMetaSave(); if(typeof renderVirtual==='function') renderVirtual(); }
  if(typeof toast==='function') toast(`✓ ${fixed} année(s) appliquée(s) — genres restent à vérifier`);
  _metaReviewData=remaining;
  _renderMetaReviewList(); _mrRefreshSub();
}

function mrAcceptAllTrusted(){
  let fixed=0; const remaining=[];
  _metaReviewData.forEach(e=>{
    let touched=false;
    if(e.yearProp?.trusted){ const n=_applyYearToPaths(e.paths,e.yearProp.value); if(n>0){fixed+=n;touched=true;} }
    if(e.genreProp?.trusted){ const n=_applyGenreToPaths(e.paths,e.genreProp.value); if(n>0){fixed+=n;touched=true;} }
    // si l'album avait UNIQUEMENT des props fiables → résolu ; sinon il reste
    const stillHas = (e.yearProp && !e.yearProp.trusted) || (e.genreProp && !e.genreProp.trusted);
    if(stillHas){
      // retire la part déjà appliquée pour ne pas la reproposer
      remaining.push({...e,
        yearProp: e.yearProp && !e.yearProp.trusted ? e.yearProp : null,
        genreProp: e.genreProp && !e.genreProp.trusted ? e.genreProp : null});
    }
  });
  if(fixed>0){ scheduleMetaSave(); if(typeof renderVirtual==='function') renderVirtual(); }
  if(typeof toast==='function') toast(`✓ ${fixed} correction(s) fiable(s) appliquée(s)`);
  _metaReviewData=remaining;
  _renderMetaReviewList(); _mrRefreshSub();
}
// Accepte d'un coup TOUTES les propositions en attente du MÊME artiste. Chaque
// album garde SA proposition → respecte les artistes multi-genres (Piazzolla =
// Latin ET Classical). On décide une fois par artiste, plus album par album.
function mrAcceptAllForArtist(idx){
  const ref = _metaReviewData[idx]; if(!ref) return;
  const art = (ref.artist || '').toLowerCase().trim();
  // Sans artiste : ne cibler que CET item (évite d'appliquer d'un coup toutes les
  // propositions à artiste vide). Avec artiste : tous les items du même artiste.
  const _match = art ? (e => (e.artist || '').toLowerCase().trim() === art) : (e => e === ref);
  let fixed = 0;
  for(const e of _metaReviewData.slice()){
    if(!_match(e)) continue;
    if(e.yearProp){ const n=_applyYearToPaths(e.paths, e.yearProp.value); if(n>0) fixed+=n; }
    if(e.genreProp){ const n=_applyGenreToPaths(e.paths, e.genreProp.value); if(n>0) fixed+=n; }
  }
  _metaReviewData = _metaReviewData.filter(e => !_match(e));
  if(fixed>0){ if(typeof scheduleMetaSave==='function') scheduleMetaSave(); if(typeof renderVirtual==='function') renderVirtual(); }
  if(typeof toast==='function') toast(`✓ ${fixed} morceau(x) de ${ref.artist||'?'} appliqué(s)`);
  _renderMetaReviewList(); _mrRefreshSub();
  if(typeof refreshReviewBadge==='function') refreshReviewBadge();
}

// Applique TOUTES les propositions en attente (fiables + incertaines) d'un clic.
// L'utilisateur garde le contrôle total : tout reste annulable depuis "Corrigé".
function mrAcceptAllProps(){
  let fixed=0;
  (_metaReviewData||[]).forEach(e=>{
    if(e.yearProp){ const n=_applyYearToPaths(e.paths,e.yearProp.value); if(n>0) fixed+=n; }
    if(e.genreProp){ const n=_applyGenreToPaths(e.paths,e.genreProp.value); if(n>0) fixed+=n; }
  });
  if(fixed>0){ if(typeof scheduleMetaSave==='function') scheduleMetaSave(); if(typeof renderVirtual==='function') renderVirtual(); }
  if(typeof toast==='function') toast(`✓ ${fixed} proposition(s) appliquée(s)`);
  _metaReviewData=[];
  _renderMetaReviewList(); _mrRefreshSub();
  if(typeof refreshReviewBadge==='function') refreshReviewBadge();
}

// Annule EN MASSE toutes les corrections auto de l'onglet "Corrigé" (restaure les
// valeurs d'avant). Pour repartir propre après un auto-remplissage trop large.
function mrUndoAllAuto(){
  const list=(_mrCorrected||[]).slice();
  if(!list.length) return;
  let undone=0;
  list.forEach(t=>{
    if(!t) return;
    const fx=t._autoFix||{};
    if(fx.year  && typeof fx.year.from!=='undefined')  t.year =fx.year.from;
    if(fx.genre && typeof fx.genre.from!=='undefined') t.genre=fx.genre.from;
    if(fx.album && typeof fx.album.from!=='undefined'){ t.album=fx.album.from; t._clearAlbumOverride=true; }
    if(fx.artist && typeof fx.artist.from!=='undefined'){ t.artist=fx.artist.from; t._clearArtistOverride=true; }
    delete t._autoFixed; delete t._autoFix; t._userModified=false;
    const noG=!t.genre || (typeof isJunkGenre==='function' && isJunkGenre(t.genre));
    const noY=!t.year  || (typeof isJunkYear==='function'  && isJunkYear(t.year));
    if(noG||noY) t._incomplete=true; else delete t._incomplete;
    undone++;
  });
  if(typeof scheduleMetaSave==='function') scheduleMetaSave();
  if(typeof renderVirtual==='function') renderVirtual();
  if(typeof refreshReviewBadge==='function') refreshReviewBadge();
  if(typeof _mrCollectExtras==='function') _mrCollectExtras();
  _renderMetaReviewCorrected(); _mrRefreshSub();
  if(typeof toast==='function') toast(`↩ ${undone} correction(s) annulée(s)`);
}

function closeMetaReview(){
  const ov=document.getElementById('metaReviewOv');
  if(ov) ov.classList.remove('on');
  _mrDetachKeys();
}

// ── HARMONISATION AUTOMATIQUE ───────────────────────────────────
function enrichSetStatus(state, text){
  const pill=document.getElementById('enrichPill');
  const span=document.getElementById('enrichStatus');
  if(!pill) return;
  pill.classList.remove('running','done','has-unidentified');
  if(state==='running') pill.classList.add('running');
  else if(state==='done') pill.classList.add('done');
  // If we're idle and unidentified tracks exist → show the bucket affordance
  if(state === 'idle' && Array.isArray(allTracks)){
    const n = allTracks.filter(t => t._unidentified).length;
    if(n > 0) pill.classList.add('has-unidentified');
  }
  if(span && text) span.textContent = text;
}

// Build album groups from tracks needing enrichment
function buildAlbumGroups(){
  // First pass: bucket tracks by album+artist (regular albums) or album-only (compilations).
  // For compilations we group by album name alone so MB query gets the release tracklist
  // rather than per-artist false negatives.
  const albumMap = new Map();          // key → {album, artist, paths, isCompilation, perTrackQueries}
  const albumByName = new Map();       // album-name only → tracks (for compilation detection)
  allTracks.forEach(t => {
    const al = t.album || '';
    if(!al) return;
    if(!albumByName.has(al)) albumByName.set(al, []);
    albumByName.get(al).push(t);
  });

  allTracks.forEach(t => {
    if(t._userModified) return;
    if(t.genre && t.year) return;
    const al = t.album || ''; const ar = t.artist || '';
    if(!al) return;

    // Detect compilation/soundtrack from album name pattern OR from artist diversity within the album
    const albTracks = albumByName.get(al) || [];
    const distinctArtists = new Set(albTracks.map(x => x.artist || '').filter(Boolean));
    const isCompi = _COMPI_RE.test(al.toLowerCase()) || distinctArtists.size >= 3;

    if(isCompi){
      // One group per album (not per artist). Each track's per-track query stays distinct.
      const k = '__COMPI__||' + al;
      if(!albumMap.has(k)){
        albumMap.set(k, {album: al, artist: 'Various Artists', paths: [], isCompilation: true});
      }
      albumMap.get(k).paths.push(t.path);
    } else {
      // Regular album: group by artist+album as before.
      const k = ar + '||' + al;
      if(!albumMap.has(k)){
        albumMap.set(k, {album: al, artist: ar, paths: [], isCompilation: false});
      }
      albumMap.get(k).paths.push(t.path);
    }
  });
  return [...albumMap.values()];
}

// Core harmonisation: runs silently in background
async function runHarmonisation(albumGroups){
  if(!albumGroups.length) return 0;
  enrichSetStatus('running', `Complétion… (${albumGroups.length})`);
  let updated=0;
  // Track which paths were lookup attempts and which got real data back
  const allAttemptedPaths = new Set();
  albumGroups.forEach(g => (g.paths || []).forEach(p => allAttemptedPaths.add(p)));
  try{
    const results=await window.wt.fetchOnlineMeta(albumGroups);

    // ── DIAGNOSTIC TEMPORAIRE ──
    if (results && results.__error) {
      console.error('[runHarmonisation] CRASH côté main.js :', results.__error);
      delete results.__error;
    }
    let _diagEmpty = 0, _diagGenreOnly = 0, _diagYearOnly = 0, _diagBoth = 0, _diagTotal = 0;
    const _diagSamples = [];
    Object.entries(results).forEach(([path, meta]) => {
      _diagTotal++;
      const hasG = !!meta.genre, hasY = !!meta.year;
      if (!hasG && !hasY) _diagEmpty++;
      else if (hasG && hasY) _diagBoth++;
      else if (hasG) _diagGenreOnly++;
      else if (hasY) _diagYearOnly++;
      if (_diagSamples.length < 5) {
        _diagSamples.push({ path: path.split('/').pop(), genre: meta.genre || '∅', year: meta.year || '∅', gT: meta.genreTrusted, yT: meta.yearTrusted });
      }
    });
    console.log(`[runHarmonisation] fetchOnlineMeta retour : ${_diagTotal} résultats — vides:${_diagEmpty} genre-seul:${_diagGenreOnly} année-seule:${_diagYearOnly} les-deux:${_diagBoth}`);
    console.log(`[runHarmonisation] échantillon retours :`, _diagSamples);
    // ── FIN DIAGNOSTIC ──

    Object.entries(results).forEach(([path,meta])=>{
      const t=allTracks.find(x=>x.path===path);
      if(!t || t._userModified) return; // user wins
      // ── GENRE — overwrite when:
      //   • current empty/junk
      //   • OR consensus is high-confidence AND disagrees with current
      if(meta.genre){
        const curJunk = isJunkGenre(t.genre);
        const shouldOverwrite = curJunk || (meta.genreTrusted && t.genre !== meta.genre);
        if(shouldOverwrite && t.genre !== meta.genre){
          t.genre = meta.genre;
          updated++;
        }
      }
      // ── YEAR — same logic. Extra rule: existing year > 2018 + new year < 2010
      //   ⇒ digital re-release vs original recording, replace.
      if(meta.year){
        const curJunk = isJunkYear(t.year);
        const looksLikeReissue = !curJunk && parseInt(t.year) >= 2018 && parseInt(meta.year) < 2010;
        const shouldOverwrite = curJunk || looksLikeReissue || (meta.yearTrusted && t.year !== meta.year);
        if(shouldOverwrite && t.year !== meta.year){
          t.year = meta.year;
          updated++;
        }
      }
    });
    // Mark tracks that got a lookup but no usable data → "unidentified"
    // (allows user to filter and resolve them manually in the editor).
    allAttemptedPaths.forEach(path => {
      const t = allTracks.find(x => x.path === path);
      if(!t || t._userModified) return;
      const got = results[path];
      const stillMissing = !t.genre || !t.year;
      if(stillMissing && (!got || (!got.genre && !got.year))){
        t._unidentified = true;
      } else {
        delete t._unidentified;
      }
    });
    if(updated>0){ renderVirtual(); scheduleMetaSave(); }
  }catch(e){
    console.warn('[harmonisation]',e);
    enrichSetStatus('idle','Compléter les infos');
    return 0;
  }
  // Count outcomes for user feedback. Use refreshEnrichPill so the baseline
  // (_lastEnrichCount) is set — next user edit will animate.
  const unidentified = allTracks.filter(t => t._unidentified).length;
  const stillMissing = allTracks.filter(t => !t.genre || !t.year).length;
  if(unidentified > 0){
    if(typeof refreshEnrichPill === 'function') refreshEnrichPill();
    toast(`${updated > 0 ? `✓ ${updated} mis à jour · ` : ''}${unidentified} à compléter (cliquer la pastille)`);
  } else if(stillMissing > 0){
    enrichSetStatus('idle', `${stillMissing} introuvables`);
    _lastEnrichCount = 0;  // baseline so next change animates
  } else {
    enrichSetStatus('done', 'Collection complète ✓');
    _lastEnrichCount = 0;
    setTimeout(()=>enrichSetStatus('idle','Compléter les infos'), 4000);
  }
  return updated;
}
// Called by main.js event after get-library + by the auto-boot timer
// ════════════════════════════════════════════════════════════════════════
// PHASE 1 — Détection des tracks _incomplete (chat 6, refonte lazy)
// ────────────────────────────────────────────────────────────────────────
// Un track est _incomplete si :
//   - genre absent ou poubelle (isJunkGenre)
//   - OU année absente ou poubelle (isJunkYear)
//   - OU le cache MB le contredit (via buildMetaDiffs en dry-run)
// _userModified et _unidentified sont préservés (jamais marqués _incomplete).
// Cette fonction est PURE : ne fait aucun fetch, lit seulement le cache.
// Retourne le nombre total de tracks _incomplete.
// ════════════════════════════════════════════════════════════════════════
function markAllIncomplete() {
  if (!Array.isArray(allTracks)) return 0;
  let n = 0;
  // 1. Critères locaux (rapide) : junk genre, junk year
  allTracks.forEach(t => {
    if (t._userModified) { delete t._incomplete; return; }
    const noG = !t.genre || (typeof isJunkGenre === 'function' && isJunkGenre(t.genre));
    const noY = !t.year || (typeof isJunkYear === 'function' && isJunkYear(t.year));
    if (noG || noY) {
      t._incomplete = true;
      n++;
    } else {
      delete t._incomplete;
    }
  });
  // 2. Conflit cache (détection erronés) : on lance buildMetaDiffs en dry-run
  //    et on flag les tracks des albums dont le cache contredit le tag local.
  //    Note : buildMetaDiffs auto-applique déjà les trusted en interne ; on
  //    récupère les albums "douteux" et on flag leurs tracks.
  // Cet appel est sync ne pas attendre — on l'a déjà fait au boot via Phase 4.
  return n;
}

// Async variant : intègre la détection des erronés via cache.
async function markAllIncompleteWithCache() {
  let n = markAllIncomplete();
  try {
    const diffs = await buildMetaDiffs();
    const douteuxAlbums = diffs?.albums || [];
    for (const alb of douteuxAlbums) {
      for (const p of (alb.paths || [])) {
        const t = allTracks.find(x => x.path === p);
        if (!t || t._userModified) continue;
        if (!t._incomplete) {
          t._incomplete = true;
          n++;
        }
      }
    }
  } catch (e) {
    console.warn('[markAllIncomplete] cache diff échec:', e);
  }
  return n;
}

// ════════════════════════════════════════════════════════════════════════
// PHASE 2+3 — enrichQueue : enrichissement à la volée (chat 6)
// ────────────────────────────────────────────────────────────────────────
// Queue centrale qui traite les tracks _incomplete en arrière-plan.
// Paramètres : 3 fetches concurrents max, batches de 10 avec pause 30s entre
// batches pour respirer le réseau (anti rate-limit MB/Discogs).
//
// Triggers :
//   • Au boot, après 5s d'idle : enfourne les 10 premiers _incomplete
//   • Quand l'user playIdx() un track _incomplete : TOP priorité
//   • Quand l'user addToQueue() un track _incomplete : priorité normale
//
// Stratégie d'écriture :
//   • UNIQUEMENT si le tag existant est vide/junk (jamais d'overwrite auto)
//   • Les conflits cache (tag présent mais discordant) → restent _incomplete,
//     l'user doit passer par la modale "Revue des métadonnées".
//
// Source de vérité : fetchConsolidatedMeta (renderer, le même code que la
// modale Édition Rechercher). Pas de duplication.
// ════════════════════════════════════════════════════════════════════════

// Rafraîchissement d'affichage throttlé après chaque enrichissement background :
// redessine la liste (genre/année/couleur + data-genre du hover) et, si le
// fullscreen est ouvert (_fsActive), met à jour ses champs. Throttlé 1.5s.
let _enrichRefreshPending = false;
function _scheduleEnrichUiRefresh() {
  if (_enrichRefreshPending) return;
  _enrichRefreshPending = true;
  setTimeout(() => {
    _enrichRefreshPending = false;
    try { if (typeof renderVirtual === 'function') renderVirtual(); } catch(e) {}
    try { if (typeof _fsActive !== 'undefined' && _fsActive && typeof _fsRefresh === 'function') _fsRefresh(); } catch(e) {}
    // Le player aussi : si le morceau en cours vient d'être enrichi (genre/année/
    // album corrigés), l'overlay au hover de la cover se met à jour tout seul.
    try {
      if (typeof qi !== 'undefined' && typeof queue !== 'undefined' && queue[qi] && typeof _refreshPlayerOverlay === 'function') {
        _refreshPlayerOverlay(queue[qi]);
      }
    } catch(e) {}
  }, 1500);
}

const enrichQueue = {
  _queue: [],
  _inflight: 0,
  _MAX_CONCURRENT: 3,
  _BATCH_SIZE: 10,
  _BATCH_PAUSE_MS: 30000,
  _seen: new Set(),
  _processedInBatch: 0,
  _paused: false,
  _syncPaused: false,  // pause externe pendant un transfert de fichiers (priorité au sync)

  add(track, opts = {}) {
    if (!track || !track.path) return;
    if (track._userModified || track._unidentified) return;
    if (!track._incomplete) return;
    if (this._seen.has(track.path)) return;
    this._seen.add(track.path);
    const item = { track, priority: opts.priority || 0 };
    if (opts.priority > 0) this._queue.unshift(item);
    else this._queue.push(item);
    this._tick();
  },

  addMany(tracks, opts = {}) {
    for (const t of tracks) this.add(t, opts);
  },

  // Re-traitement FORCÉ (clic « Compléter les infos ») : contourne le filtre
  // "déjà complet" + le cache _seen, mais respecte TOUJOURS _userModified/_ignored.
  // item.force=true autorise l'écriture de l'album (album vide uniquement).
  addForce(tracks, opts = {}) {
    const list = Array.isArray(tracks) ? tracks : [tracks];
    for (const track of list) {
      if (!track || !track.path) continue;
      // C203 : fillOnly ouvre la porte aux _userModified (champs vides seulement)
      if ((track._userModified && !opts.fillOnly) || track._ignored) { delete track._verifying; continue; }
      this._seen.delete(track.path);
      this._seen.add(track.path);
      const item = { track, priority: opts.priority || 5, force: true, fillOnly: !!opts.fillOnly };
      if (item.priority > 0) this._queue.unshift(item); else this._queue.push(item);
    }
    this._tick();
  },

  pauseForSync() {
    if (!this._syncPaused) { this._syncPaused = true; console.log('[enrichQueue] pause (transfert en cours)'); }
  },
  resumeAfterSync() {
    if (this._syncPaused) { this._syncPaused = false; console.log('[enrichQueue] reprise (transfert terminé)'); this._tick(); }
  },

  // Bilan de fin de vérification auto : nombre de corrections faites (et le
  // détail des autres issues), affiché en toast quand la file se vide.
  _runStats: {},
  // Total des corrections auto de LA SESSION, affiché en continu à côté du
  // bouton Vérifier (le « 1 corrigé » du bilan disparaissait avec le toast).
  _sessionFixed: 0,
  _bumpSessionFixed() {
    this._sessionFixed++;
    let el = document.getElementById('wtSessionFixed');
    if (!el) {
      const host = document.getElementById('wtMetaSplit');
      if (host && host.parentElement) {
        el = document.createElement('span');
        el.id = 'wtSessionFixed';
        el.title = 'Corrections automatiques appliquées cette session';
        el.style.cssText = 'font-size:10px;color:var(--acc);font-weight:700;margin-left:6px;font-family:var(--font-mono);white-space:nowrap';
        host.parentElement.insertBefore(el, host.nextSibling);
      }
    }
    if (el) el.textContent = '✓ ' + this._sessionFixed;
  },
  _reportRun() {
    const s = this._runStats;
    this._runStats = {};
    const total = Object.values(s).reduce((a, b) => a + b, 0);
    if (!total) return;
    const parts = [];
    if (s.corrected) parts.push(`${s.corrected} corrigé${s.corrected > 1 ? 's' : ''}`);
    if (s.proposed)  parts.push(`${s.proposed} à revoir`);
    if (s.refused)   parts.push(`${s.refused} refusé${s.refused > 1 ? 's' : ''}`);
    if (s.empty)     parts.push(`${s.empty} sans info`);
    if (s.error)     parts.push(`${s.error} erreur${s.error > 1 ? 's' : ''}`);
    console.log('[enrichQueue] bilan du run :', JSON.stringify(s));
    if (typeof toast === 'function') toast(`✓ Vérification auto terminée — ${parts.join(', ')}`);
  },

  async _tick() {
    if (this._syncPaused) return;
    while (this._inflight < this._MAX_CONCURRENT && this._queue.length > 0) {
      // COUPE-FILE : la vérif du morceau JOUÉ (priority >= 15) passe même
      // pendant la pause inter-batch — l'user attend son résultat à l'écran.
      // Sans ça, « recherche en cours… » pouvait traîner 30 s et plus.
      const _headPrio = !!(this._queue[0] && this._queue[0].priority >= 15);
      if (this._paused && !_headPrio) return;
      if (!_headPrio && this._processedInBatch >= this._BATCH_SIZE) {
        console.log(`[enrichQueue] batch de ${this._BATCH_SIZE} traité, pause ${this._BATCH_PAUSE_MS / 1000}s avant la suite (queue: ${this._queue.length})`);
        this._paused = true;
        setTimeout(() => {
          this._processedInBatch = 0;
          this._paused = false;
          this._tick();
        }, this._BATCH_PAUSE_MS);
        return;
      }
      const item = this._queue.shift();
      this._inflight++;
      this._processedInBatch++;
      if (typeof setMetaSplitRunning === 'function') setMetaSplitRunning(true);
      this._processItem(item).finally(() => {
        this._inflight--;
        // Comptage du run (pour le bilan de fin)
        const _o = (item.track && item.track._autoProcessed) ? item.track._autoOutcome : null;
        if (_o) this._runStats[_o] = (this._runStats[_o] || 0) + 1;
        if (_o === 'corrected') this._bumpSessionFixed(); // total session, en temps réel
        // Transparence + cooldown : horodatage de vérification (persisté), fin
        // de l'état « recherche en cours », notification si c'est le morceau
        // en cours de lecture. Pas d'horodatage sur erreur → nouvel essai possible.
        if (item.track) {
          delete item.track._verifying;
          if (_o && _o !== 'error') {
            item.track._playCheckedAt = Date.now();
            item.track._playCheckedRev = _PV_LOGIC_REV; // C196
            if (typeof scheduleMetaSave === 'function') scheduleMetaSave();
          }
          // Les entrées de queue sont des COPIES : on reflète l'issue sur la
          // copie EN LECTURE, sinon l'affichage garde « recherche en cours… »
          // et des valeurs périmées alors que l'original est déjà corrigé.
          const _qc = (typeof queue !== 'undefined' && queue[qi] && queue[qi] !== item.track
                       && queue[qi].path === item.track.path) ? queue[qi] : null;
          if (_qc) {
            delete _qc._verifying;
            _qc._autoProcessed = item.track._autoProcessed;
            _qc._autoOutcome = item.track._autoOutcome;
            if (item.track.year) _qc.year = item.track.year;
            if (item.track.genre) _qc.genre = item.track.genre;
            if (item.track.genreChild) _qc.genreChild = item.track.genreChild;
          }
          if (typeof _notifyPlayCheckResult === 'function') _notifyPlayCheckResult(item.track, _o);
        }
        // Reprise du bulk mis en pause pour la vérif du morceau joué
        if (window._bulkPausedForPlay && item.priority >= 15) {
          window._bulkPausedForPlay = false;
          try { window.autoResolve && window.autoResolve.bulk && window.autoResolve.bulk.resume(); } catch(e) {}
        }
        if (this._queue.length === 0 && this._inflight === 0) {
          if (typeof setMetaSplitRunning === 'function') setMetaSplitRunning(false);
          this._reportRun();
        }
        this._tick();
      });
    }
  },

  async _processItem(item) {
    const t = item.track;
    // C203 : fillOnly = recherche autorisée sur un _userModified, écriture
    // limitée aux champs VIDES plus bas. _ignored reste absolu.
    if (!t || (t._userModified && !item.fillOnly) || t._ignored) return;
    // COOLDOWN : un morceau déjà vérifié récemment n'est pas re-cherché par les
    // passes automatiques (boot/lazy). Les chemins FORCÉS (clic « Compléter les
    // infos », play→auto, « Tout re-vérifier ») passent outre.
    if (!item.force && t._playCheckedAt && (Date.now() - t._playCheckedAt) < 7 * 24 * 3600 * 1000) return;
    try {
      if (typeof fetchConsolidatedMeta !== 'function') return;
      const consolidated = await fetchConsolidatedMeta(t);
      if (!consolidated) return;

      // ── SANITY CHECK : refus si le match consolidé semble être un faux positif ──
      // Logique : si l'artiste local matche le consolidé (chevauchement de mots),
      // on accepte — peu importe si l'album diffère (cas légitime quand la 2e
      // query "artist+title" ramène l'album-single du titre au lieu de l'album-
      // conteneur). Si l'artiste ne matche PAS, on regarde l'album : si lui non
      // plus, on refuse.
      const localArtist = (t.artist || '').toLowerCase().trim();
      const localAlbum = (t.album || '').toLowerCase().trim();
      const consoArtist = (consolidated.artist?.value || '').toLowerCase().trim();
      const consoAlbum = (consolidated.album?.value || '').toLowerCase().trim();

      // Test chevauchement de mots significatifs (>= 4 lettres) entre 2 strings.
      // Plus tolérant que includes : "Micheal Hurley" matche "Michael Hurley"
      // si au moins 1 mot significatif est commun (ici "Hurley").
      const wordOverlap = (a, b) => {
        if (!a || !b) return false;
        // Neutralise les accents : tag fichier "Los Lideres" ≈ source "Los Líderes".
        // Sans ça, l'ancrage artiste échoue sur toute la musique latine et le
        // garde-fou refuse à tort des matchs légitimes.
        const norm = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        a = norm(a); b = norm(b);
        if (a === b || a.includes(b) || b.includes(a)) return true;
        const wa = new Set(a.split(/[\s,&._-]+/).filter(w => w.length >= 4));
        const wb = new Set(b.split(/[\s,&._-]+/).filter(w => w.length >= 4));
        for (const w of wa) if (wb.has(w)) return true;
        return false;
      };

      // Le bon signal n'est PAS la valeur artiste/album (la consolidation
      // renvoie le tag local tel quel quand rien n'est trouvé → comparer
      // "pasaca" à "pasaca" matche toujours), mais sa SOURCE : 'local-tag' =
      // AUCUNE source en ligne ne connaît ce morceau.
      const _aSrc = (consolidated.artist && consolidated.artist.source) || '';
      const _bSrc = (consolidated.album  && consolidated.album.source)  || '';
      const artistOnline = !!_aSrc && _aSrc !== 'local-tag';   // une source a renvoyé un artiste
      const albumOnline  = !!_bSrc && _bSrc !== 'local-tag';   // une source a renvoyé un album

      // (1) Aucune corroboration en ligne (ni artiste ni album) → le genre vient
      //     d'un homonyme de titre via une source sans artiste (Wikipedia /
      //     Wikidata / Last.fm). On refuse plutôt qu'inventer un genre pour un
      //     artiste non répertorié (morceaux perso type Pasaca).
      let suspicious = !(artistOnline || albumOnline);

      // (2) Corroboration présente mais qui ne chevauche PAS le tag local
      //     (faux positif d'homonyme) : on exige qu'au moins l'artiste corroboré
      //     OU l'album corroboré recoupe réellement le tag local.
      if (!suspicious) {
        const artistAnchors = artistOnline && localArtist && wordOverlap(localArtist, consoArtist);
        const albumAnchors  = albumOnline  && localAlbum  && wordOverlap(localAlbum,  consoAlbum);
        if ((localArtist || localAlbum) && !artistAnchors && !albumAnchors) suspicious = true;
      }

      if (suspicious) {
        // ── Sauvetage ANNÉE pour compils / best-of / B.O. ───────────────────
        // Le garde-fou refuse à juste titre le MATCH (artiste/album restent le tag
        // local — on ne disperse pas une compil). MAIS l'année d'ORIGINE vient,
        // elle, d'une vraie recherche par titre en ligne. On la récupère — SANS
        // toucher au genre (qui reste protégé). Annulable + visible dans « Corrigé ».
        // Même détecteur de compil que fetchConsolidatedMeta → on ne récupère que
        // les années que ce chemin a réellement produites.
        const _yr      = consolidated.year;
        const _yOnline = !!(_yr && _yr.value && _yr.source && _yr.source !== 'local-tag');
        const _albCompil =
              (t.path && /\/Compilations\//i.test(t.path)) ||
              /various|compilation|soundtrack|bande originale|\bost\b|greatest hits|best of|the very best|collection|anthology|\blive\b|en concert|en vivo/i
                .test((t.album || '') + ' ' + (t.artist || ''));
        const _yv    = _yOnline ? parseInt(_yr.value) : null;
        const _curY  = t.year ? parseInt(t.year) : null;
        const _yEmpty = !t.year || (typeof isJunkYear === 'function' && isJunkYear(t.year));
        // Corroboré : album bien taggué (non-compil) dont la recherche par titre a
        // CONFIRMÉ l'artiste (ou année trusted Wikipédia/convergence) → on comble
        // une année VIDE sans risque (ex. live « Coma Divine »). Cf. [corroboré].
        const _yCorrob = _yOnline && (/\[corrobor[eé]\]/i.test(_yr.source || '') || _yr.trusted === true);
        // C203 : en fillOnly (_userModified), seule une année VIDE peut être
        // comblée — jamais de correction d'une valeur existante.
        const _umOk = !t._userModified || (item.fillOnly && _yEmpty);
        // Applique si : (compil → vide OU origine + ancienne) OU (corroboré → vide).
        if (_yv && _umOk && (
              (_albCompil && (_yEmpty || (_curY && _yv < _curY)))
           || (_yCorrob && _yEmpty)
            )) {
          const _from = t.year || '';
          t.year = _yv;
          try {
            if (window.wt?.applyTrackMetaToMain)
              window.wt.applyTrackMetaToMain({ path: t.path, year: t.year, source: 'compil-origine' });
          } catch (e) { /* silent */ }
          t._autoFixed = true;
          t._autoFix = { genre: null, year: { from: _from, to: _yv }, album: null, source: (_yr.source || 'compil-origine'), ts: Date.now() };
          if (typeof recordAutoFix === 'function') recordAutoFix(t, t._autoFix);
          if (typeof scheduleMetaSave === 'function') scheduleMetaSave();
          // _incomplete recalculé : l'année est posée, le genre peut rester manquant.
          const _noG = !t.genre || (typeof isJunkGenre === 'function' && isJunkGenre(t.genre));
          if (_noG) t._incomplete = true; else delete t._incomplete;
          t._autoProcessed = true;
          t._autoOutcome = 'corrected';
          console.log(`[enrichQueue] année ${_albCompil ? 'compil' : 'album'} récupérée (match refusé) "${t.title || t.path.split('/').pop()}" : ${_from || '∅'} → ${_yv}`);
          if (typeof refreshReviewBadge === 'function') refreshReviewBadge();
          if (typeof _scheduleEnrichUiRefresh === 'function') _scheduleEnrichUiRefresh();
          return;
        }
        // Sinon : refus classique (rien d'exploitable à récupérer). Le log dit la
        // VRAIE raison : soit aucune source en ligne ne connaît le morceau (la
        // consolidation renvoie alors le tag local tel quel — afficher les valeurs
        // donnait des chaînes identiques, trompeuses), soit un homonyme sans
        // rapport avec le tag.
        const _why = !(artistOnline || albumOnline)
          ? `aucune source en ligne ne connaît ce morceau (le tag local est conservé)`
          : `résultat en ligne sans rapport avec le tag — tag(${localArtist || '∅'}/${localAlbum || '∅'}) vs en-ligne(${consoArtist || '∅'}/${consoAlbum || '∅'})`;
        console.log(`[enrichQueue] REFUS (garde-fou) pour "${t.title || t.path.split('/').pop()}" — ${_why}`);
        // Refus → le track reste _incomplete (honnêteté envers l'user, il
        // pourra réessayer plus tard ou compléter manuellement).
        t._autoProcessed = true;
        t._autoOutcome = 'refused';
        if (typeof refreshReviewBadge === 'function') refreshReviewBadge();
        return;
      }

      let applied = false;
      const _fix = { genre: null, year: null, album: null };

      // Genre : on REMPLIT un champ vide/junk même si la valeur est incertaine
      // (source unique comme Deezer). Ça ne détruit rien, c'est annulable, et c'est
      // VISIBLE dans "Corrigé" (détail vide→X). Choix assumé : moins de revue,
      // quitte à corriger après coup. On n'écrase jamais une valeur valide.
      const g = consolidated.genre;
      const genreEmpty = (!t.genre || (typeof isJunkGenre === 'function' && isJunkGenre(t.genre)));
      if (g?.value && genreEmpty) {
        _fix.genre = { from: t.genre || '', to: g.value };
        t.genre = g.value;
        // capture l'enfant si le brut le révèle (ne jamais écraser un enfant posé)
        if (!t.genreChild && typeof clientMapChild === 'function') {
          const _c = clientMapChild(g.source === 'local-tag' ? g.value : (g.raw || g.value));
          if (_c) t.genreChild = _c;
        }
        applied = true;
      }

      // Year : on remplit un trou (toute année trouvée). En PLUS, on CORRIGE une
      // année déjà présente mais NON modifiée par l'user si la source est FIABLE et
      // PLUS ANCIENNE (l'originale prime sur la réédition — ex. 1985 → 1958).
      const y = consolidated.year;
      const yearEmpty = (!t.year || (typeof isJunkYear === 'function' && isJunkYear(t.year)));
      const _yv = y?.value ? parseInt(y.value) : null;
      const _curY = t.year ? parseInt(t.year) : null;
      const _fixReissue = _yv && !yearEmpty && !t._userModified && y.trusted && _curY && _yv < _curY;
      // ÉTAGE 1 (fausses infos certaines) : sur une COMPILATION, une année
      // existante PLUS RÉCENTE que l'origine corroborée par l'artiste est un
      // artefact de pressage (« Granada » taggé 2013 = l'année de la compil,
      // origine ~1957). L'écraser relève d'« automatiser le certain » —
      // _userModified reste intouchable, et c'est annulable depuis « Corrigé ».
      const _albCompilFix = (t.path && /\/Compilations\//i.test(t.path))
        || /various|compilation|soundtrack|bande originale|\bost\b|greatest hits|best of|the very best|billboard|top\s*\d{2,}|collection|anthology|mejores|éxitos|exitos/i
             .test((t.album || '') + ' ' + (t.artist || ''));
      const _yCorrobSrc = /\[corrobor/i.test(String((y && y.source) || ''));
      const _fixCompilYear = _yv && !yearEmpty && !t._userModified && _albCompilFix && _yCorrobSrc && _curY && _yv < _curY;
      if (_fixCompilYear && !_fixReissue) console.log(`[enrichQueue] année de compil corrigée vers l'origine corroborée : ${_curY} → ${_yv} (${t.title || ''})`);
      if (_yv && (yearEmpty || _fixReissue || _fixCompilYear)) {
        _fix.year = { from: t.year || '', to: _yv };
        t.year = _yv;
        applied = true;
      }

      // Album : UNIQUEMENT en recherche FORCÉE (clic « Compléter les infos »), et
      // seulement pour combler un album VIDE/junk ("[Unknown Album]"). On n'écrase
      // jamais un album valide. Annulable + visible dans « Corrigé ».
      const b = consolidated.album;
      const _albJunk = s => { const v = String(s || '').trim(); return !v || /^\[?\s*(unknown|inconnu|untitled|sans titre|various|va)(\s+(album|artists?))?\s*\]?$/i.test(v); };
      if (item.force && !item.fillOnly && b?.value && albumOnline && _albJunk(t.album) && wordOverlap(localArtist, consoArtist)) {
        _fix.album = { from: t.album || '', to: b.value };
        t.album = b.value;
        applied = true;
      }

      // ── C213 : POCHETTE AUTOMATIQUE ──────────────────────────────────
      // Le pipeline consolidait déjà `consolidated.cover` (validée : l'album du
      // candidat matche le tag local ET qualité ≥ 500) puis la JETAIT —
      // _processItem n'écrivait que genre / année / album. On l'applique enfin.
      // Garde-fous : jamais d'écrasement d'une pochette existante (custom ou déjà
      // trouvée) ; uniquement une candidate `trusted`. La purge de pochette vide
      // customCovers[path] et relance une recherche : ce chemin la sert aussi.
      const _cv = consolidated.cover;
      if (_cv && _cv.value && _cv.trusted
          && typeof customCovers !== 'undefined' && !customCovers[t.path]) {
        customCovers[t.path] = _cv.value;
        if (typeof scheduleSave === 'function') scheduleSave();
        if (typeof schedulePropagateTrackUpdate === 'function') schedulePropagateTrackUpdate(t);
        // Une pochette vaut pour TOUT l'album (hors compilation).
        if (typeof propagateAlbumMeta === 'function') propagateAlbumMeta(t, { cover: _cv.value });
        // Temps réel : rafraîchit l'affichage si c'est le morceau en cours.
        if (typeof nowPath !== 'undefined' && nowPath === t.path) {
          if (typeof updateArtDisplay === 'function') updateArtDisplay(_cv.value);
          if (typeof _refreshFullscreenArt === 'function') _refreshFullscreenArt();
        }
        console.log(`[enrichQueue] pochette : « ${t.album || t.title} » (${_cv.source})`);
      }

      if (applied) {
        delete t._needsPersistPurge;   // un correctif a été écrit → ne pas purger ce morceau
        try {
          if (window.wt?.applyTrackMetaToMain) {
            window.wt.applyTrackMetaToMain({ path: t.path, genre: t.genre, year: t.year, album: t.album, source: 'lazy-auto' });
          }
        } catch (e) { /* silent */ }
        // Journal des corrections auto : trace AVANT→APRÈS pour que l'user puisse
        // revoir (et corriger) ce que l'outil a touché en arrière-plan.
        t._autoFixed = true;
        t._autoFix = { genre: _fix.genre, year: _fix.year, album: _fix.album, source: (consolidated.source || 'lazy-auto'), ts: Date.now() };
        if (typeof recordAutoFix === 'function') recordAutoFix(t, t._autoFix);
        if (typeof scheduleMetaSave === 'function') scheduleMetaSave();
        console.log(`[enrichQueue] enrichi : ${t.title || t.path.split('/').pop()}`);
        // C208 : l'album partage UNE année et UN genre → les pistes voisines
        // héritent de ce qui vient d'être trouvé (vide seulement, hors compil).
        if (typeof propagateAlbumMeta === 'function') {
          propagateAlbumMeta(t, {
            year:  _fix.year  ? _fix.year.to  : null,
            genre: _fix.genre ? _fix.genre.to : null
          });
        }
      }

     // Recalcul du flag _incomplete : un track est complet si genre ET year sont valides
      const noG = !t.genre || (typeof isJunkGenre === 'function' && isJunkGenre(t.genre));
      const noY = !t.year || (typeof isJunkYear === 'function' && isJunkYear(t.year));
      if (noG || noY) t._incomplete = true;
      else delete t._incomplete;

     // Outcome précis. On distingue 4 cas — ne plus mentir avec "sans résultat" :
      //   corrected : une valeur trusted a été écrite automatiquement
      //   proposed  : le moteur a TROUVÉ une valeur (trusted non-applicable car
      //               champ déjà rempli, OU non-trusted comme Deezer seul) → à
      //               valider par l'user. On garde la proposition sur le track.
      //   empty     : vraiment rien d'exploitable n'est revenu
      const propG = (consolidated.genre && consolidated.genre.value &&
                     (!consolidated.genre.source || consolidated.genre.source !== 'local-tag'))
                    ? { value: consolidated.genre.value, trusted: !!consolidated.genre.trusted, source: consolidated.genre.source } : null;
      const propY = (consolidated.year && consolidated.year.value &&
                     (!consolidated.year.source || consolidated.year.source !== 'local-tag'))
                    ? { value: parseInt(consolidated.year.value), trusted: !!consolidated.year.trusted, source: consolidated.year.source } : null;
      const foundSomething = !!(propG || propY);
      t._autoProcessed = true;
      if (applied) {
        t._autoOutcome = 'corrected';
      } else if (foundSomething) {
        t._autoOutcome = 'proposed';
        // Conserve la proposition pour la revue (valeur + si trusted + source).
        t._autoProposal = { genre: propG, year: propY, ts: Date.now() };
      } else {
        t._autoOutcome = 'empty';
      }

      // Log d'issue : quand rien n'est ÉCRIT, dire pourquoi — sinon impossible de
      // comprendre depuis la console pourquoi une année reste vide après lecture.
      if (!applied) {
        const _tn = t.title || t.path.split('/').pop();
        if (t._autoOutcome === 'proposed') {
          console.log(`[enrichQueue] "${_tn}" : trouvé mais non écrit → « À vérifier » (année: ${propY ? propY.value + (propY.trusted ? ' fiable' : ' non-fiable') : '∅'}, genre: ${propG ? propG.value : '∅'})`);
        } else {
          console.log(`[enrichQueue] "${_tn}" : aucune info exploitable trouvée en ligne`);
        }
      }

      // COMPTEUR VIVANT : un track "proposed" est en attente de revue même si
      // ses deux champs sont remplis (cas conflit genre présent-mais-divergent,
      // invisible pour _incomplete). On pose un flag léger que le badge compte,
      // pour qu'il s'actualise tout seul sans attendre l'ouverture de la revue.
      if (t._autoOutcome === 'proposed' && !t._userModified) t._reviewPending = true;
      else delete t._reviewPending;

      // ── C215 : SCORE DE CONFIANCE — MODE OBSERVATION ────────────────────
      // On calcule ce que le modèle pondéré DÉCIDERAIT, sans rien changer au
      // comportement actuel. Objectif : voir ses verdicts sur le VRAI catalogue
      // avant de lui confier l'écriture — on ne met pas en production une règle
      // de décision non calibrée sur 1 500 albums quand la règle d'or est
      // « ne jamais écrire une fausse donnée ».
      // Le score est stocké sur la proposition (exploitable par la modale de revue).
      try {
        const _scY = (typeof _confidenceYear === 'function') ? _confidenceYear(consolidated.year?.candidates) : null;
        const _scG = (typeof _confidenceScore === 'function') ? _confidenceScore(consolidated.genre?.candidates, 'genre') : null;
        if (_scY || _scG) {
          const _tn = t.title || t.path.split('/').pop();
          const _f = (lbl, r) => !r ? '' :
            ` | ${lbl} ${r.value} → ${_scoreVerdict(r)}`
            + ` (consensus ${(r.confidence * 100).toFixed(0)}%`
            + ` · masse ${r.mass.toFixed(2)}`
            + ` · marge ${(r.margin * 100).toFixed(0)}%`
            + ` · ${r.n} source${r.n > 1 ? 's' : ''}${r.strong ? ' · FORTE' : ' · faibles'})`
            + ` [${r.sources.join(' + ')}]`;
          console.log(`[score] « ${_tn} » (réel : ${t._autoOutcome})` + _f('année', _scY) + _f('genre', _scG));
        }
        if (t._autoProposal) {
          if (_scY && t._autoProposal.year)  t._autoProposal.year.confidence  = _scY.confidence;
          if (_scG && t._autoProposal.genre) t._autoProposal.genre.confidence = _scG.confidence;
        }

        // ── C222 : DÉTECTION DES DONNÉES EXISTANTES FAUSSES ─────────────────
        // Angle mort historique : le pipeline ne regardait que les champs VIDES.
        // Un genre présent mais faux n'était JAMAIS corrigé, ni même signalé —
        // personne ne le regardait. Le score, lui, sait mesurer le DÉSACCORD
        // (masse + marge). On l'utilise pour SIGNALER, jamais pour écrire :
        // le morceau bascule dans « À vérifier » avec un AVANT → APRÈS.
        // Seuils volontairement PLUS SÉVÈRES que pour combler un vide :
        // contredire une donnée existante exige plus de preuve que remplir un trou.
        const CONFLICT_GATE = { consensus: 0.85, mass: 2.00, margin: 0.50 };
        const _confl = r => !!r && r.strong
          && r.confidence >= CONFLICT_GATE.consensus
          && r.mass       >= CONFLICT_GATE.mass
          && r.margin     >= CONFLICT_GATE.margin;
        if (!t._userModified && !t._ignored) {
          let _cG = null, _cY = null;
          // GENRE — jamais corrigé automatiquement à ce jour : c'est ici que le
          // gain est le plus grand.
          if (_confl(_scG) && !genreEmpty && _scG.value !== t.genre) {
            _cG = { value: _scG.value, trusted: false, source: 'score de confiance',
                    from: t.genre, conflict: true, confidence: _scG.confidence };
          }
          // ANNÉE — on ne signale QUE si l'année trouvée est PLUS ANCIENNE.
          // Proposer une année plus RÉCENTE contredirait la philosophie n°1
          // (l'origine prime sur la réédition) et c'est le piège des albums live :
          // « Satch Boogie », tag 2006, enregistrement d'origine 1987 — la bonne
          // valeur dépend de ce qu'on veut dater, et ça ne s'automatise pas.
          const _curYr = t.year ? parseInt(t.year) : null;
          if (_confl(_scY) && !yearEmpty && _curYr && _scY.value < _curYr) {
            _cY = { value: _scY.value, trusted: false, source: 'score de confiance',
                    from: _curYr, conflict: true, confidence: _scY.confidence };
          }
          if (_cG || _cY) {
            const _prev = t._autoProposal || {};
            t._autoProposal = { genre: _cG || _prev.genre || null,
                                year:  _cY || _prev.year  || null,
                                conflict: true, ts: Date.now() };
            t._autoOutcome = 'proposed';
            t._reviewPending = true;
            console.log(`[conflit] « ${t.title || t.path.split('/').pop()} » — donnée EXISTANTE contredite :`
              + (_cG ? ` genre « ${_cG.from} » → « ${_cG.value} » (${(_cG.confidence * 100).toFixed(0)}%, masse ${_scG.mass.toFixed(2)})` : '')
              + (_cY ? ` année ${_cY.from} → ${_cY.value} (${(_cY.confidence * 100).toFixed(0)}%, masse ${_scY.mass.toFixed(2)})` : '')
              + ' — PROPOSITION, aucune écriture');
            if (typeof scheduleMetaSave === 'function') scheduleMetaSave();
            if (typeof refreshReviewBadge === 'function') refreshReviewBadge();
          }
        }
      } catch (e) { /* observation seulement : ne doit JAMAIS casser l'enrichissement */ }

      // Badge recompté via la source de vérité unique
      if (typeof refreshReviewBadge === 'function') refreshReviewBadge();
      // Rafraîchit l'affichage (liste + fullscreen) au fil de l'eau, throttlé.
      if (typeof _scheduleEnrichUiRefresh === 'function') _scheduleEnrichUiRefresh();
      // Rafraîchit l'affichage (liste + fullscreen) au fil de l'eau, throttlé.
      _scheduleEnrichUiRefresh();
    } catch (e) {
      console.warn('[enrichQueue] échec pour', t?.path?.split('/').pop(), ':', e?.message);
      // Tenté mais erreur réseau (ex : MB 503) → traité, source indisponible.
      if (t) { t._autoProcessed = true; t._autoOutcome = 'error'; }
      if (typeof refreshReviewBadge === 'function') refreshReviewBadge();
    }
  },

  // Status pour debug
  status() {
    return {
      queueLength: this._queue.length,
      inflight: this._inflight,
      processedInBatch: this._processedInBatch,
      paused: this._paused,
      seen: this._seen.size,
    };
  },
};

if (typeof window !== 'undefined') {
  window.enrichQueue = enrichQueue;
}

// Trigger : au boot après 5s d'idle, enfourner les premiers _incomplete
function enrichBootKickoff() {
  setTimeout(() => {
    if (!Array.isArray(allTracks)) return;
    // Tous les _incomplete, sans exclure _unidentified — la queue elle-même
    // dédoublonne via _seen, donc un track déjà tenté ne sera pas re-tenté
    // dans la même session. Le re-kickoff périodique vide _seen pour permettre
    // une retentative à intervalles réguliers.
    const candidates = allTracks.filter(t => t._incomplete && !t._userModified && !t._ignored);
    if (candidates.length === 0) return;
    console.log(`[enrichQueue] boot kickoff : ${candidates.length} _incomplete détectés, enfournement progressif`);
    enrichQueue.addMany(candidates);
  }, 5000);

  // Re-kickoff toutes les 15 min : vide _seen pour autoriser une nouvelle
  // tentative sur les tracks restés incomplets (MB peut être revenu, etc.).
  // Approche modeste : on n'ajoute QUE les tracks qui sont encore _incomplete
  // après tout ce qui s'est passé. Pas de risque de boucle infinie tant que
  // la queue dédoublonne via _seen entre les kickoffs.
  if (!window._enrichRekickoffTimer) {
    window._enrichRekickoffTimer = setInterval(() => {
      if (!Array.isArray(allTracks)) return;
      const stillIncomplete = allTracks.filter(t => t._incomplete && !t._userModified && !t._ignored);
      if (stillIncomplete.length === 0) {
        console.log('[enrichQueue] re-kickoff : rien à faire, tout est complet');
        return;
      }
      // Vide la mémoire des tracks déjà tentés pour permettre une 2e chance
      if (typeof enrichQueue !== 'undefined' && enrichQueue._seen) {
        enrichQueue._seen.clear();
      }
      console.log(`[enrichQueue] re-kickoff périodique : ${stillIncomplete.length} restants — retentative`);
      enrichQueue.addMany(stillIncomplete);
    }, 15 * 60 * 1000); // 15 min
  }
}

async function startAutoEnrich(){
  if(_autoGenreRunning) return;
  _autoGenreRunning = true;

  // Compteur AVANT pour mesurer ce qui a vraiment été fait
  const _before = allTracks.filter(t => !t._userModified && (!t.genre || !t.year)).length;
  console.log(`[startAutoEnrich] DÉMARRAGE — ${_before} manquants à traiter`);

  autoFillLocal();
  console.log(`[startAutoEnrich] après autoFillLocal — ${allTracks.filter(t => !t._userModified && (!t.genre || !t.year)).length} manquants`);

  const groups=buildAlbumGroups();
  console.log(`[startAutoEnrich] buildAlbumGroups → ${groups.length} groupes à fetch`);
  if (groups.length > 0) {
    console.log(`[startAutoEnrich] échantillon premiers groupes :`, groups.slice(0, 3).map(g => `${g.artist || '∅'} - ${g.album}`));
  }

  if(groups.length){
    try {
      const updated = await runHarmonisation(groups);
      console.log(`[startAutoEnrich] runHarmonisation TERMINÉ — ${updated} tracks mis à jour`);
    } catch (e) {
      console.error('[startAutoEnrich] runHarmonisation ÉCHEC :', e);
    }
  } else {
    console.log('[startAutoEnrich] aucun groupe à traiter (rien à compléter)');
    enrichSetStatus('done','Collection complète ✓');
    setTimeout(()=>enrichSetStatus('idle','Compléter les infos'),3000);
  }
  _autoGenreRunning=false;

  const _after = allTracks.filter(t => !t._userModified && (!t.genre || !t.year)).length;
  console.log(`[startAutoEnrich] FIN — manquants passés de ${_before} à ${_after} (delta ${_before - _after})`);

  // ── AUTO-APPLY des corrections trusted DÉJÀ dans le cache ──
  setTimeout(async () => {
    if (typeof setMetaSplitRunning === 'function') setMetaSplitRunning(false);
    try {
      const diffs = await buildMetaDiffs();
      const auto = (diffs?.autoYear || 0) + (diffs?.autoGenre || 0);
      const douteux = diffs?.albums?.length || 0;
      const manquants = allTracks.filter(t => !t._userModified && (!t.genre || !t.year)).length;
      console.log(`[autoApply] ${auto} corrections auto-appliquées · ${douteux} douteux · ${manquants} manquants restants`);
      if (typeof refreshReviewBadge === 'function') refreshReviewBadge();
    } catch (e) { console.warn('[autoApply] échec:', e); }
  }, 1500);
}

// Pilote l'état visuel du bouton "Vérifier les infos" selon l'avancée du warm-up.
// state: 'warming' (analyse en cours) | 'ready' (cache prêt, clique) | 'idle'.
// Styles inline → aucune dépendance CSS externe.
// Injecte une seule fois le keyframes du spinner (pas de dépendance style.css).
function _ensureSpinnerCSS(){
  if(document.getElementById('wtSpinnerCSS')) return;
  const s=document.createElement('style');
  s.id='wtSpinnerCSS';
  s.textContent='@keyframes wtspin{to{transform:rotate(360deg)}}'+
    '.wt-spin{display:inline-block;width:9px;height:9px;border:1.5px solid currentColor;'+
    'border-top-color:transparent;border-radius:50%;animation:wtspin .7s linear infinite;'+
    'vertical-align:middle;margin-right:4px}';
  document.head.appendChild(s);
}

// Pilote l'état visuel du bouton "Vérifier les infos" selon l'avancée du warm-up.
// state: 'warming' (spinner + compteur) | 'ready' (pulse vert + ✓) | 'idle'.
function setVerifyButtonState(state, progressText){
  const btn=document.getElementById('btnMetaReview');
  if(!btn) return;
  _ensureSpinnerCSS();
  // Reconstruit le contenu : [svg check] [zone dynamique]. On garde le 1er enfant (svg).
  const svg=btn.querySelector('svg');
  if(state==='warming'){
    btn.style.opacity='0.7';
    btn.style.pointerEvents='none';
    btn.style.cursor='progress';
    btn.title='Analyse des métadonnées en cours… patiente avant de vérifier.';
    btn.innerHTML = (svg?svg.outerHTML:'') +
      `<span class="wt-spin"></span>${progressText||'Analyse…'}`;
 } else if(state==='ready'){
    btn.style.opacity='1';
    btn.style.pointerEvents='';
    btn.style.cursor='';
    btn.style.transition='box-shadow .3s';
    // progressText porte ici le NOMBRE de corrections à revoir (ou 0 / vide).
    const nb = parseInt(progressText) || 0;
    if(nb > 0){
      // Il y a du travail : badge PERMANENT « Vérifier (N) » + liseré vert qui reste.
      btn.title=`${nb} correction(s) proposée(s) — clique pour les revoir.`;
      btn.innerHTML = (svg?svg.outerHTML:'') + ` Vérifier (${nb})`;
      btn.style.boxShadow='0 0 0 1.5px rgba(61,179,127,.7)';
    } else {
      // Rien à revoir : message apaisé qui s'estompe.
      btn.title='Analyse terminée — tout est à jour.';
      btn.innerHTML = (svg?svg.outerHTML:'') + ' Tout est à jour ✓';
      btn.style.boxShadow='0 0 0 1.5px rgba(61,179,127,.7)';
      setTimeout(()=>{
        btn.style.boxShadow='';
        const sv=btn.querySelector('svg');
        btn.innerHTML = (sv?sv.outerHTML:'') + ' Vérifier les infos';
      }, 4000);
    }
  } else { // idle
    btn.style.opacity='1';
    btn.style.pointerEvents='';
    btn.style.cursor='';
    btn.style.boxShadow='';
    btn.title='Vérifie et corrige les années / genres déjà présents mais douteux. Te soumet les cas incertains en revue.';
    btn.innerHTML = (svg?svg.outerHTML:'') + ' Vérifier les infos';
  }
}

// Fetch en arrière-plan des albums complets dans la zone réédition (≥ minYear),
// uniquement ceux ABSENTS du cache, par petits paquets pour ne pas saturer.
// Ne modifie rien à l'écran : il ne fait que REMPLIR le cache méta côté main.
let _warmingMetaCache=false;
// Re-vérification COMPLÈTE : re-fetch tous les albums en ignorant le cache.
// Sert après une mise à jour (logique de fetch améliorée) ou en dev. Tourne en
// arrière-plan ; la progression s'affiche sur le bouton « Vérifier ».
async function forceRecheckAll(){
  if(_warmingMetaCache){ if(typeof toast==='function') toast('⏳ Analyse déjà en cours…'); return; }
  // Disclaimer honnête : le re-fetch d'une grosse bibliothèque (>1000 albums)
  // peut prendre PLUSIEURS HEURES à cause des rate-limits (MusicBrainz ~1 req/s,
  // Wikipedia idem). L'estimation initiale "quelques minutes" était fausse.
  const _ok = confirm(
    'Re-vérifier TOUTE la bibliothèque ?\n\n' +
    '⚠ Cette analyse peut prendre plusieurs heures selon la taille de ta bibliothèque ' +
    '(limites des serveurs MusicBrainz / Wikipedia : ~1 album par seconde).\n\n' +
    '✓ Elle tourne en arrière-plan : tu peux continuer à écouter, naviguer, fermer la ' +
    'modale. La progression s\'affiche sur le bouton « Vérifier ».\n\n' +
    'ℹ Certains albums resteront en INCERTAIN après analyse — c\'est normal, ça veut ' +
    'dire qu\'aucun signal fort n\'a permis de trancher, et ils méritent un coup d\'œil.'
  );
  if(!_ok) return;
  if(typeof toast==='function') toast('🔄 Re-vérification complète lancée (arrière-plan)…');
  await warmMetaCacheBackground({ forceAll:true });
  if(typeof toast==='function') toast('✓ Re-vérification terminée — clique « Vérifier » pour revoir.');
}

async function warmMetaCacheBackground(opts={}){
  if(_warmingMetaCache) return;
  if(!window.wt?.fetchOnlineMeta || !window.wt?.getMetaCache) return;
  const forceAll  = !!opts.forceAll;          // re-vérifie TOUT, ignore le cache
  const minYear   = opts.minYear ?? (forceAll ? 0 : 2000);  // forceAll → aucun filtre d'année
  const batchSize = opts.batchSize ?? 25;     // albums par paquet
 _warmingMetaCache=true;
  try{
    // Albums complets candidats (année locale ≥ minYear), non déjà en cache.
    const cache = await window.wt.getMetaCache();
    const all   = buildYearRecheckGroups({ minYear });        // déjà : exclut compils, junk, _userModified
    // À faire = absents du cache OU périmés. En mode forceAll → TOUS les albums.
    const todo  = forceAll ? all : all.filter(g => {
      const entry = cache[`${g.artist}||${g.album}`];
      return !entry || entry.stale;
    });
    if(!todo.length){
      console.log('[warmMetaCache] cache déjà complet pour ≥'+minYear);
      // Cache déjà prêt → on compte les albums à revoir pour l'afficher sur le bouton.
      let _nb = 0;
      try {
        const diffs = await buildMetaDiffs();
        _nb = (diffs && Array.isArray(diffs.albums)) ? diffs.albums.length : 0;
      } catch(e){ console.warn('[warmMetaCache] comptage initial échoué:', e); }
      setVerifyButtonState('ready', String(_nb));   // « Vérifier (96) » si N>0
      return;
    }

    console.log(`[warmMetaCache] ${todo.length} albums ≥${minYear} à mettre en cache (paquets de ${batchSize})…`);
    let done=0;
    for(let i=0;i<todo.length;i+=batchSize){
      const batch=todo.slice(i,i+batchSize);
      // Affiche la progression sur le bouton (X / total albums analysés).
      setVerifyButtonState('warming', `Analyse… ${done}/${todo.length}`);
      // fetchOnlineMeta met chaque album en cache côté main (voir handler).
      // On ignore le retour : l'harmonisation des trous a déjà appliqué les
      // changements visibles ; ici on ne veut QUE peupler le cache.
      // En mode forceAll, on marque chaque groupe force:true → le handler ignore
      // le cache et re-fetche avec la logique à jour (MB-RG corrigé, Wikipedia…).
      await window.wt.fetchOnlineMeta(forceAll ? batch.map(g => ({...g, force:true})) : batch);
      done+=batch.length;
    }
   console.log('[warmMetaCache] terminé — "Vérifier les infos" voit maintenant ces albums.');
    // Compte les corrections en attente pour les afficher sur le bouton.
    let _nbReview = 0;
    try {
     const diffs = await buildMetaDiffs();
      _nbReview = (diffs && Array.isArray(diffs.albums)) ? diffs.albums.length : 0;
    } catch(e){ console.warn('[warmMetaCache] comptage diffs échoué:', e); }
    setVerifyButtonState('ready', String(_nbReview));   // badge « Vérifier (N) » si N>0
  } catch(e){
    console.warn('[warmMetaCache] échec:', e);
    setVerifyButtonState('idle');      // en cas d'échec, on débloque le bouton
  } finally {
    _warmingMetaCache=false;
  }
}

// Click handler: if there are unidentified tracks, show them; otherwise re-run harmonisation.
function onEnrichPillClick(){
  // Robustesse : on considère "à compléter" SOIT le flag _unidentified (posé par
  // l'harmonisation), SOIT un trou réel (genre/année manquant), car les flags
  // peuvent être perdus après un re-render / reload sans nouveau run.
  const flagged    = allTracks.filter(t => t._unidentified);
  const incomplete = allTracks.filter(t => !t._userModified && (!t.genre || !t.year));
  if(flagged.length > 0 || incomplete.length > 0){
    // Reposer le flag sur les trous réels pour que le bucket les capture tous.
    incomplete.forEach(t => { t._unidentified = true; });
    showUnidentifiedBucket();
  } else {
    // Rien d'incomplet → on (re)lance un passage, avec retour visible.
    toast('Collection complète — relance d\u2019un passage…');
    forceEnrich();
  }
}

// Filter the library to show only tracks that came back empty from harmonisation.
// User can mass-edit, hit "Identifier" individually, or fill manually.
function showUnidentifiedBucket(){
  const ts = allTracks.filter(t => t._unidentified);
  if(!ts.length){
    toast('Aucune info à compléter');
    return;
  }
  // Switch to flat (Titres) view + sidebar to library.
  // showAll() bascule déjà en vue plate (setViewMode('flat')) ; l'ancien
  // setMode('flat') visait par erreur la fonction connexion WiFi/Firebase
  // (collision de nom) → crash classList null. On le corrige proprement.
 if(typeof showAll === 'function') showAll();
  else if(typeof setViewMode === 'function') setViewMode('flat');
  curPl = -1;
  filtered = ts;
  _inCompleteBucket = true;   // ← on est dans la vue filtrée « à compléter »
  if(typeof applySortToFiltered === 'function') applySortToFiltered();
  if(typeof renderVirtual === 'function') renderVirtual();
  if(typeof updateBreadcrumb === 'function') updateBreadcrumb();
  toast(`${ts.length} morceaux à compléter — éditer ou utiliser "Identifier"`);
}

// Vue filtrée des corrections appliquées automatiquement par l'outil. L'user
// scanne genre/année et corrige à la main ce qui est faux ; l'édition pose
// _userModified, ce qui retire le morceau de cette liste de contrôle.
function showAutoFixBucket(){
  const ts = allTracks.filter(t => t._autoFixed);
  if(!ts.length){
    toast('Aucune correction auto à revoir');
    return;
  }
  if(typeof showAll === 'function') showAll();
  else if(typeof setViewMode === 'function') setViewMode('flat');
  curPl = -1;
  filtered = ts;
  _inCompleteBucket = true;
  if(typeof applySortToFiltered === 'function') applySortToFiltered();
  if(typeof renderVirtual === 'function') renderVirtual();
  if(typeof updateBreadcrumb === 'function') updateBreadcrumb();
  toast(`${ts.length} corrections auto — vérifie genre/année, édite si c'est faux`);
}

// Vue « Fichiers traités » : tout ce que la queue a tenté. Les corrigés d'abord
// (genre/année posés auto), puis ceux où rien n'a été trouvé (source vide,
// refus, ou erreur réseau) → l'user sait qu'ils ont été vus et qu'il doit les
// faire lui-même, plutôt que de rester bloqué sans signal.
function showProcessedBucket(){
  const all = allTracks.filter(t => t._autoProcessed);
  if(!all.length){
    toast('Aucun fichier traité pour l\'instant');
    return;
  }
  const rank = { corrected:0, proposed:1, empty:2, refused:2, error:3 };
  const ts = all.slice().sort((a,b)=>(rank[a._autoOutcome]??3)-(rank[b._autoOutcome]??3));
  if(typeof showAll === 'function') showAll();
  else if(typeof setViewMode === 'function') setViewMode('flat');
  curPl = -1;
  filtered = ts;
  _inCompleteBucket = true;
  if(typeof applySortToFiltered === 'function') applySortToFiltered();
  if(typeof renderVirtual === 'function') renderVirtual();
  if(typeof updateBreadcrumb === 'function') updateBreadcrumb();
 const corrected = all.filter(t=>t._autoOutcome==='corrected').length;
  const proposed  = all.filter(t=>t._autoOutcome==='proposed').length;
  toast(`${all.length} traités · ${corrected} corrigés · ${proposed} proposition${proposed!==1?'s':''} à valider · ${all.length-corrected-proposed} sans résultat`);
}

// Force a manual run (pill click)
function forceEnrich(){
  if(_autoGenreRunning){ toast('Harmonisation déjà en cours…'); return; }
  if(!allTracks.length){ toast('Aucune bibliothèque chargée'); return; }
  // ✅ Forcer le run même si buildAlbumGroups retourne vide — on le signale
  _autoGenreRunning=true;
  autoFillLocal();
  const groups=buildAlbumGroups();
  if(!groups.length){
    enrichSetStatus('done','Collection complète ✓');
    toast('Collection déjà harmonisée ✓');
    setTimeout(()=>enrichSetStatus('idle','Compléter les infos'),3000);
    _autoGenreRunning=false;
    return;
  }
  runHarmonisation(groups).finally(()=>{ _autoGenreRunning=false; });
}

// Listen for startAutoEnrich signal from main.js (after scan).
// Mode lazy : on ne déclenche plus l'ancien batch. À la place, on re-flag
// les _incomplete (nouveaux tracks scannés peuvent avoir des manquants).
if (window.wt && typeof window.wt.on === 'function') {
  window.wt.on('startAutoEnrich', () => {
    setTimeout(async () => {
      if (typeof markAllIncompleteWithCache === 'function') {
        await markAllIncompleteWithCache();
      } else if (typeof markAllIncomplete === 'function') {
        markAllIncomplete();
      }
      if (typeof refreshReviewBadge === 'function') refreshReviewBadge();
    }, 1000);
  });
}

async function autoDetectGenresByAlbum(force=false){
  if(_autoGenreRunning) return;
  // Skip tracks already complete or user-modified
  const needWork=allTracks.filter(t=>
    !t._userModified && (force ? true : (!t.genre||!t.year))
  );
  if(!needWork.length) return;

  // Use IPC path if available (main.js — no CSP restrictions)
  if(window.wt?.fetchOnlineMeta){
    // Delegate to startEnrich logic silently (background auto-run)
    const albumMap=new Map();
    needWork.forEach(t=>{
      const k=(t.artist||'')+'||'+(t.album||'');
      if(!albumMap.has(k)) albumMap.set(k,{album:t.album||'',artist:t.artist||'',paths:[]});
      albumMap.get(k).paths.push(t.path);
    });
    const groups=[...albumMap.values()].slice(0,80);
    _autoGenreRunning=true;
    try{
      const results=await window.wt.fetchOnlineMeta(groups);
      let updated=0;
      Object.entries(results).forEach(([path,meta])=>{
        const t=allTracks.find(x=>x.path===path);
        if(!t || t._userModified) return;
        if(meta.genre){
          const curJunk = isJunkGenre(t.genre);
          const shouldOverwrite = curJunk || (meta.genreTrusted && t.genre !== meta.genre);
          if(shouldOverwrite && t.genre !== meta.genre){ t.genre = meta.genre; updated++; }
        }
        if(meta.year){
          const curJunk = isJunkYear(t.year);
          const looksLikeReissue = !curJunk && parseInt(t.year) >= 2018 && parseInt(meta.year) < 2010;
          const shouldOverwrite = curJunk || looksLikeReissue || (meta.yearTrusted && t.year !== meta.year);
          if(shouldOverwrite && t.year !== meta.year){ t.year = meta.year; updated++; }
        }
      });
      if(updated>0){ renderVirtual(); scheduleMetaSave(); }
    }catch(e){ console.warn('[autoDetect]',e); }
    _autoGenreRunning=false;
    return;
  }

  // Fallback: browser fetch (may be blocked by CSP in some configs)
  _autoGenreRunning=true;
  let updated=0;
  const albums=new Map();
  needWork.forEach(t=>{
    const k=(t.artist||'')+'||'+(t.album||'');
    if(!albums.has(k)) albums.set(k,{album:t.album||'',artist:t.artist||'',tracks:[]});
    albums.get(k).tracks.push(t);
  });
  for(const [,{album,artist,tracks}] of [...albums.entries()].slice(0,40)){
    const {genre,year}=await fetchAlbumMeta(album,artist);
    tracks.forEach(t=>{
      if(t._userModified) return;
      // Browser-fetch fallback path: low-trust, fill-empty only.
      if(genre && isJunkGenre(t.genre)){ t.genre=genre; updated++; }
      if(year && isJunkYear(t.year)){ t.year=year; updated++; }
    });
    await new Promise(r=>setTimeout(r,220));
  }
  _autoGenreRunning=false;
  if(updated>0){ renderVirtual(); scheduleMetaSave(); }
}

async function autoDetectGenres(){
  // Keep for backward compat (sidebar button still works if user wants to force)
  await autoDetectGenresByAlbum(false);
  toast('✓ Genres détectés par album');
}

// ── SIDEBAR ───────────────────────────────────────
function _ensurePlSplitCss(){
  if(document.getElementById('wt-pl-split-style')) return;
  const css = `
.pl-art-split{position:relative;overflow:hidden;}
.pl-art-split .plc-layer{position:absolute;inset:0;z-index:1;}
.pl-art-split .plc-b{clip-path:polygon(100% 0,100% 100%,0 100%);z-index:2;}
.pl-art-split .plc-layer img{width:100%;height:100%;object-fit:cover;display:block;border-radius:0 !important;}
.pl-art-split .plc-seam{position:absolute;inset:0;z-index:3;pointer-events:none;background:linear-gradient(135deg,transparent calc(50% - 2px),rgba(0,0,0,.45) calc(50% - 2px),rgba(255,255,255,.95) 50%,rgba(0,0,0,.45) calc(50% + 2px),transparent calc(50% + 2px));}
.pl-art-split .plc-ph{position:absolute;inset:0;margin:auto;z-index:0;}
`;
  const st=document.createElement('style'); st.id='wt-pl-split-style'; st.textContent=css; document.head.appendChild(st);
}
function renderSidebar(){
  // Count now shown in breadcrumb — no sidebar badge needed
  const el=document.getElementById('sbLists');
  if(!allLists.length){
    el.innerHTML='<div style="padding:10px;font-family:var(--font-body);font-size:11px;color:var(--t3);line-height:1.7">Clique sur "iTunes / Music"<br>ou sur <strong>+</strong> pour créer une playlist</div>';
    return;
  }
  // Separate custom/smart/merged from iTunes playlists
  const customLists=allLists.filter(l=>l.custom||l.smart||l.merged);
  const itunesLists=allLists.filter(l=>!l.custom&&!l.smart&&!l.merged);

 function renderPlItem(l,i){
    // Patch N.3 : Favoris (system) — icône étoile, pas de drag, pas de dblclick play auto
    if (l.system && l.name === FAVORITES_LIST_NAME) {
      return `<div class="pl-item${i===curPl?' on':''} pl-system" 
               onclick="showPlaylist(${i})" 
               ondblclick="playPlaylistNow(${i})" 
               oncontextmenu="showCtxMenu(event,${i})" 
               id="pli${i}"
               draggable="true"
               ondragstart="plDragStart(event,${i})"
               ondragover="plDragOver(event,${i})"
               ondragleave="plDragLeave(event,${i})"
               ondrop="plDrop(event,${i})">
        <div class="pl-art pl-art-fav"><svg width="14" height="14" viewBox="0 0 24 24" fill="#C85A45" stroke="#C85A45" stroke-width="1.5" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></div>
        <div class="pl-txt">
          <div class="pl-name" id="pln${i}">${esc(l.name)}</div>
          <div class="pl-ct">${l.count} morceau${l.count!==1?'x':''} · Smart</div>
        </div>
      </div>`;
    }
    return `<div class="pl-item${i===curPl?' on':''}" onclick="showPlaylist(${i})" ondblclick="playPlaylistNow(${i})" oncontextmenu="showCtxMenu(event,${i})" id="pli${i}" draggable="true" ondragstart="plDragStart(event,${i})" ondragover="plDragOver(event,${i})" ondragleave="plDragLeave(event,${i})" ondrop="plDrop(event,${i})">
      <div class="pl-art pl-art-split" id="pa${i}"><div class="plc-layer plc-a" id="pa${i}a"></div><div class="plc-layer plc-b" id="pa${i}b"></div><span class="plc-seam"></span><svg class="plc-ph" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>
      <div class="pl-txt">
        <div class="pl-name" id="pln${i}">${esc(l.name)}</div>
        <div class="pl-ct">${l.count} morceau${l.count!==1?'x':''}${l.merged?' · Fusionnée':l.smart?' · Smart':''}</div>
      </div>
    </div>`;
  }

  let html='';
  if(customLists.length){
    html+=`<div class="sb-section-label">Wave Tune</div>`;
    html+=customLists.map((l)=>{const i=allLists.indexOf(l);return renderPlItem(l,i);}).join('');
    if(itunesLists.length) html+=`<div class="sb-pl-sep"></div>`;
  }
  if(itunesLists.length){
    if(customLists.length) html+=`<div class="sb-section-label">iTunes / Music</div>`;
    html+=itunesLists.map((l)=>{const i=allLists.indexOf(l);return renderPlItem(l,i);}).join('');
  }
  el.innerHTML=html;
  _ensurePlSplitCss();
  allLists.forEach((l,i)=>{
    const tr = l.tracks;
    if(!tr || !tr.length) return;
    // Couche A = 1re pochette dispo (depuis le début), couche B = dernière dispo
    // (depuis la fin) → 2 pochettes souvent distinctes, choix déterministe/stable.
    // fetchPlArt marche en repli jusqu'à trouver une pochette dans la liste.
    fetchPlArt(tr[0], `pa${i}a`, tr, 0);
    const rev = tr.slice().reverse();
    fetchPlArt(rev[0], `pa${i}b`, rev, 0);
  });
}

// ── CONTEXT MENU ──────────────────────────────────
function showCtxMenu(e,i){
  e.preventDefault(); e.stopPropagation();
  ctxPlIdx=i;
  const menu=document.getElementById('ctxMenu');
  menu.classList.add('on');
  let x=e.clientX, y=e.clientY;
  // Keep within viewport — hauteur RÉELLE, pas estimée
  const mw=menu.offsetWidth||190, mh=menu.offsetHeight||180;
  if(x+mw>window.innerWidth) x=window.innerWidth-mw-8;
  if(y+mh>window.innerHeight) y=window.innerHeight-mh-8;
  if(x<8) x=8; if(y<8) y=8;
  menu.style.left=x+'px'; menu.style.top=y+'px';
}
function hideCtxMenu(){document.getElementById('ctxMenu').classList.remove('on');ctxPlIdx=-1;}
document.addEventListener('click',()=>hideCtxMenu());
document.addEventListener('keydown',e=>{if(e.key==='Escape')hideCtxMenu();});

// ══ MERGE PLAYLISTS ══════════════════════════════════
let _mSrc=-1, _mSel=new Set();

function normPl(n){
  return (n||'').toLowerCase().replace(/\s+\d+(\s+\d+)*\s*$/,'').replace(/[\s\-_.]+/g,' ').trim();
}
function openMergeModal(i){
  _mSrc=i; _mSel=new Set();
  document.getElementById('mergeSrcName').textContent=allLists[i].name;
  document.getElementById('mergeNewName').value=normPl(allLists[i].name).replace(/\w/g,c=>c.toUpperCase());
  renderMergeList();
  document.getElementById('ovMerge').classList.add('on');
}
function closeMergeModal(){
  document.getElementById('ovMerge').classList.remove('on');
  _mSrc=-1; _mSel.clear();
}
function renderMergeList(){
  const src=allLists[_mSrc];
  const srcKey=normPl(src.name);
  const others=allLists.map((l,i)=>({l,i})).filter(({i})=>i!==_mSrc);
  others.sort((a,b)=>{
    const ak=normPl(a.l.name), bk=normPl(b.l.name);
    const as=(ak===srcKey||ak.includes(srcKey)||srcKey.includes(ak))?0:1;
    const bs=(bk===srcKey||bk.includes(srcKey)||srcKey.includes(bk))?0:1;
    if(as!==bs) return as-bs;
    return a.l.name.localeCompare(b.l.name,'fr');
  });
  const el=document.getElementById('mergeList');
  el.innerHTML=others.map(({l,i})=>{
    const sim=(()=>{const k=normPl(l.name);return k===srcKey||k.includes(srcKey)||srcKey.includes(k);})();
    const sel=_mSel.has(i);
    return `<div class="mi${sel?' on':''}" onclick="toggleMergeSel(${i})" style="${sim?'background:rgba(200,90,69,.05)':''}">
      <div class="mc">${sel?'✓':''}</div>
      <div class="mn">${esc(l.name)}${sim?' <span style="color:var(--acc);font-size:9px;margin-left:5px">similaire</span>':''}</div>
      <div class="mct">${l.count} morceaux</div>
    </div>`;
  }).join('')||'<div style="padding:20px;text-align:center;color:var(--t3);font-family:var(--font-body)">Aucune autre playlist</div>';
  const n=_mSel.size;
  document.getElementById('mergeCt').textContent=n+' sélectionnée'+(n!==1?'s':'');
  document.getElementById('mergeOkBtn').disabled=n===0;
}
function toggleMergeSel(i){_mSel.has(i)?_mSel.delete(i):_mSel.add(i);renderMergeList();}
function applyMerge(){
  if(_mSrc<0||!_mSel.size) return;
  const src=allLists[_mSrc];
  let tracks=[src,...[..._mSel].map(i=>allLists[i])].flatMap(l=>l.tracks||[]);
  if(document.getElementById('mergeDedup').checked){
    const seen=new Set(); tracks=tracks.filter(t=>{if(seen.has(t.path))return false;seen.add(t.path);return true;});
  }
  const name=document.getElementById('mergeNewName').value.trim()||src.name;
  if(document.getElementById('mergeDeleteSrc').checked){
    const rem=new Set([_mSrc,..._mSel]);
    const before=curPl;
    allLists=allLists.filter((_,i)=>!rem.has(i));
    if(rem.has(before)) curPl=-1;
    else curPl=allLists.findIndex(l=>l===allLists[before]);
  }
  allLists.push({name,tracks,count:tracks.length,custom:true,merged:true});
  closeMergeModal(); renderSidebar(); scheduleSave();
  toast(`✓ "${name}" · ${tracks.length} morceaux`);
}
document.getElementById('ovMerge').addEventListener('click',e=>{if(e.target===document.getElementById('ovMerge'))closeMergeModal();});

// Drag-to-merge in sidebar
let _plDrag=-1;
function plDragStart(ev,i){
  _plDrag=i;
  ev.dataTransfer.effectAllowed='copyMove';
  try{ ev.dataTransfer.setData('text/x-wt-pl-idx', String(i)); }catch(_){}
}

// Drop sur le header "Mes Playlists Wave Tune" : copier une playlist iTunes
// en playlist custom Wave Tune (coexiste avec la fusion qui se fait quand on
// drop sur un autre pl-item).
function plHeaderDragOver(ev){
  if(_plDrag < 0) return;
  const pl = allLists[_plDrag];
  if(!pl || pl.custom || pl.smart || pl.merged) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'copy';
  document.getElementById('sbPlHeader')?.classList.add('drag-over');
}
function plHeaderDragLeave(){
  document.getElementById('sbPlHeader')?.classList.remove('drag-over');
}
function plHeaderDrop(ev){
  ev.preventDefault();
  document.getElementById('sbPlHeader')?.classList.remove('drag-over');
  const src = _plDrag; _plDrag = -1;
  if(src < 0) return;
  const srcPl = allLists[src];
  if(!srcPl || srcPl.custom || srcPl.smart || srcPl.merged) return;
  let baseName = srcPl.name;
  let name = baseName;
  let n = 2;
  while(allLists.some(l => l.name === name)){ name = `${baseName} (${n++})`; }
  const clone = {
    name,
    tracks: [...(srcPl.tracks||[])],
    count: srcPl.count || (srcPl.tracks||[]).length,
    custom: true,
    coverUrl: srcPl.coverUrl || null,
  };
  const firstItunesIdx = allLists.findIndex(l => !l.custom && !l.smart && !l.merged);
  if(firstItunesIdx >= 0) allLists.splice(firstItunesIdx, 0, clone);
  else allLists.push(clone);
  renderSidebar();
  scheduleSave();
  toast(`✓ "${srcPl.name}" copiée dans Wave Tune`);
}
function plDragOver(ev, i){
  // Cas 1 : drag d'une playlist (fusion) — comportement original
  if (_plDrag >= 0 && _plDrag !== i) {
    ev.preventDefault();
    document.getElementById('pli' + i)?.classList.add('drag-over');
    return;
  }
  // Cas 2 : drag d'un morceau — accepter le drop si dataTransfer contient
  // un track payload. Note : sur dragover on ne peut pas lire les data
  // (sécurité navigateur), donc on accepte par défaut et plDrop décide.
  if (ev.dataTransfer && (ev.dataTransfer.types.includes('track') || ev.dataTransfer.types.includes('tracks'))) {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
    document.getElementById('pli' + i)?.classList.add('drag-over');
  }
}
function plDragLeave(ev,i){document.getElementById('pli'+i)?.classList.remove('drag-over');}
function plDrop(ev,i){
  ev.preventDefault();
  ev.stopPropagation();
  document.querySelectorAll('.pl-item').forEach(el=>el.classList.remove('drag-over'));

  // Cas 1 : drag d'une PLAYLIST sur une autre (fusion existante)
  const src = _plDrag; _plDrag = -1;
  if (src >= 0 && src !== i) {
    _mSrc = src; _mSel = new Set([i]);
    document.getElementById('mergeSrcName').textContent = allLists[src].name;
    document.getElementById('mergeNewName').value = normPl(allLists[src].name).replace(/\w/g, c => c.toUpperCase());
    renderMergeList();
    document.getElementById('ovMerge').classList.add('on');
    return;
  }

  // Cas 2 : drag de MORCEAUX (depuis la queue, la biblio, ou ailleurs).
  // On lit dataTransfer pour récupérer la charge.
  let tracks = null;
  try {
    const tj = ev.dataTransfer.getData('tracks') || ev.dataTransfer.getData('track');
    if (tj) {
      const v = JSON.parse(tj);
      tracks = Array.isArray(v) ? v : [v];
    }
  } catch(_) {}

  if (!tracks || !tracks.length) return;

  const pl = allLists[i];
  if (!pl) return;

  // Refus si playlist smart/system (Favoris, etc.) — on ne peut pas ajouter
  // manuellement à une vue calculée. Toast informatif.
  if (pl.smart || pl.system) {
    toast(`"${pl.name}" est une playlist calculée — ajout manuel impossible`);
    return;
  }

  // Ajoute les morceaux à la playlist sans doublons
  pl.tracks = pl.tracks || [];
  const existingPaths = new Set(pl.tracks.map(t => t.path));
  let added = 0;
  for (const t of tracks) {
    if (t?.path && !existingPaths.has(t.path)) {
      pl.tracks.push(t);
      existingPaths.add(t.path);
      added++;
    }
  }

  if (added === 0) {
    toast(`Déjà dans "${pl.name}"`);
    return;
  }

  // Si la playlist est synced, propage vers Firestore pour mise à jour mobile
  if (pl._sync && typeof _syncPushPlaylistToFirestore === 'function') {
    _syncPushPlaylistToFirestore(pl);
  }

  // Persiste, refresh UI
  if (typeof scheduleListSave === 'function') scheduleListSave();
  renderSidebar();
  if (curPl === i && typeof showPlaylist === 'function') showPlaylist(i);

  toast(added === 1
    ? `+ "${tracks[0].title}" → ${pl.name}`
    : `+ ${added} morceaux → ${pl.name}`);
}
function ctxAction(action){
  const i=ctxPlIdx; if(i<0)return; hideCtxMenu();
  const pl=allLists[i];
  if(action==='play'){showPlaylist(i);if(pl.tracks.length){queue=[...pl.tracks].map(t=>({...t,url:pathToUrl(t.path)}));playIdx(0);};}
  else if(action==='sync'){
    pl.tracks?.forEach(t=>{if(t.path)syncSel.add(t.path)});
    _syncPushPlaylistToFirestore(pl);  // Patch D : push la playlist Firestore (= visible côté mobile)
    toast(`✓ "${pl.name}" → Sync`);
  }
  else if(action==='merge'){openMergeModal(i);}
  else if(action==='cover'){openPlaylistCoverEdit(i);}
  else if(action==='rename'){startRename(i);}
  else if(action==='duplicate'){
    const clone={...pl,name:pl.name+' (copie)',custom:true};
    allLists.splice(i+1,0,clone);
    renderSidebar(); toast(`✓ "${pl.name}" dupliquée`);
  }
  else if(action==='delete'){
    const wasSynced = pl._sync && pl._syncFirestoreId;
    const trackCount = pl.tracks?.length || 0;
    const message = wasSynced
      ? `Supprimer "${pl.name}" ?\n\nLes ${trackCount} morceau(x) seront retirés du Sync mobile, sauf ceux qui sont aussi dans une autre playlist synchronisée ou ajoutés à la main.`
      : `Supprimer "${pl.name}" ?`;

    if(confirm(message)){
      // Patch J : si la playlist était synced, on retire son lien sur chaque morceau.
      // Si un morceau n'a plus aucun lien (ni manuel, ni autre playlist), il sort du Sync.
      if (wasSynced && window.WT?.firebase && window.WT?.user) {
        const playlistId = pl._syncFirestoreId;

        // 1. Pour chaque morceau de la playlist, retire le lien playlist
        (pl.tracks || []).forEach(t => {
          if (!t || !t.path) return;
          _syncLinkRemove(t, { playlist: playlistId });
        });

        // 2. Supprime le doc playlist Firestore
        const { db, doc, deleteDoc } = window.WT.firebase;
        const uid = window.WT.user.uid;
        deleteDoc(doc(db, 'users', uid, 'syncPlaylists', playlistId))
          .then(() => {
            if (typeof _syncedPlaylistHashes !== 'undefined') {
              _syncedPlaylistHashes.delete(playlistId);
            }
            console.log(`[deletePlaylist] retiré "${pl.name}" de Firestore (${trackCount} liens nettoyés)`);
          })
          .catch(e => console.warn('[deletePlaylist] failed:', e));
      }

      // 3. Met à jour syncSel localement (pour rafraîchir le panneau Sync immédiatement)
      // Les morceaux qui ne sont plus dans aucune playlist synced ni en manuel doivent
      // sortir de syncSel. On vérifie via _pushedTrackPaths après _syncLinkRemove
      // (qui purge l'index si le doc est supprimé).
      setTimeout(() => {
        if (typeof window._pushedTrackPaths !== 'undefined') {
          [...syncSel].forEach(p => {
            if (!window._pushedTrackPaths.has(p)) {
              syncSel.delete(p);
            }
          });
          renderSyncQueue();
        }
      }, 1000);  // petit délai pour laisser le temps à _syncLinkRemove d'updater l'index

      allLists.splice(i,1);
      if(curPl===i){showAll();}else if(curPl>i){curPl--;}
      renderSidebar(); scheduleSave(); toast('✓ Playlist supprimée');
    }
  }
}

// ── PLAYLIST COVER EDIT ───────────────────────────
let plCoverEditIdx=-1;

function openPlaylistCoverEdit(i){
  plCoverEditIdx=i;
  const pl=allLists[i];
  const existing=document.getElementById(`pa${i}`)?.querySelector('img');
  const currentCover=pl.coverUrl||existing?.src||null;
  window.wt.openCoverWindow({
    path: `__playlist__${i}`,
    title: pl.name,
    artist: `${pl.count} morceau${pl.count!==1?'x':''}`,
    album: '',
    currentCover,
    isPlaylist: true,
    plIndex: i,
  });
}

function closePlCoverEdit(){document.getElementById('ovPlCover')?.classList.remove('on');}

function startRename(i){
  const el=document.getElementById('pln'+i);
  if(!el)return;
  const cur=allLists[i].name;
  el.innerHTML=`<input class="pl-rename-in" id="renIn" value="${esc(cur)}" onclick="event.stopPropagation()">`;
  const inp=document.getElementById('renIn');
  inp.focus(); inp.select();
  const done=()=>{
    const v=inp.value.trim()||cur;
    if(v === cur){
      // Pas de changement, juste sortir de l'input
      renderSidebar();
      return;
    }
    allLists[i].name=v;
    renderSidebar();
    scheduleSave();
    // Patch : rafraîchir le panneau Sync pour que l'accordéon affiche le nouveau nom
    if(typeof renderSyncQueue === 'function') renderSyncQueue();
    // Patch : log pour vérifier que _syncFirestoreId est bien stable (= pas de duplicata Firestore)
    console.log(`[rename] "${cur}" → "${v}"`, allLists[i]._syncFirestoreId ? `(Firestore: ${allLists[i]._syncFirestoreId})` : '(non sync)');
  };
  inp.addEventListener('blur',done);
  inp.addEventListener('keydown',e=>{if(e.key==='Enter')inp.blur();if(e.key==='Escape'){inp.value=cur;inp.blur();}});
}

// ── Propagation automatique des modifications de tracks (NOUVEAU, Patch B) ──
// Quand l'user modifie un morceau dans le coffre-fort (titre, album, cover,
// genre, etc.), on push automatiquement la mise à jour vers Firestore
// SI ce morceau est déjà sur le mobile (= dans _pushedTrackIds).
//
// Le debounce 5s évite de spammer Firestore quand l'user fait plusieurs
// modifs d'affilée : seule la dernière version est poussée.

const _trackUpdateTimers = new Map();  // path → timeoutId

function _slugifyTrackPropagate(s) {
  return (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0, 60);
}

function schedulePropagateTrackUpdate(track) {
  if (!track || !track.path) return;
  if (!window.WT?.firebase || !window.WT?.user) return;
  if (!window._pushedTrackPaths) return;

  // On utilise le PATH (stable, ne change jamais) plutôt que le trackId
  // dérivé du titre/artiste (qui change quand l'user édite). C'est le seul
  // moyen de retrouver le morceau sur Firestore après une modif de titre.
  const oldTrackId = window._pushedTrackPaths.get(track.path);
  if (!oldTrackId) {
    console.log('[propagateTrackUpdate] skip (pas sur mobile):', track.title, '→ path:', track.path);
    return;
  }

  // Le NOUVEAU trackId (peut être différent si titre/artiste a changé).
  // Utilise _trackIdFor (= id canonique du doc, avec repli __h<hash> si titre
  // vide), sinon divergence avec l'id réel du doc sur les morceaux sans titre.
  const newTrackId = _trackIdFor(track);
  if (!newTrackId || newTrackId === '__') return;

  // Annule le timer précédent (debounce)
  if (_trackUpdateTimers.has(track.path)) {
    clearTimeout(_trackUpdateTimers.get(track.path));
  }

  console.log('[propagateTrackUpdate] scheduled (5s) for:', track.title);

  const timer = setTimeout(async () => {
    _trackUpdateTimers.delete(track.path);
    try {
      const { db, doc, getDoc, setDoc, deleteDoc } = window.WT.firebase;
      const uid = window.WT.user.uid;

      // Track le plus à jour
      const t = (typeof allTracks !== 'undefined')
        ? allTracks.find(x => x.path === track.path) || track
        : track;

      // Recalcule le trackId au cas où le titre/artiste a changé entre-temps
      const updatedTrackId = _trackIdFor(t);

      // Résout la cover
      const coverUrl = (typeof resolveCoverForTrack === 'function')
        ? (await resolveCoverForTrack(t) || null)
        : null;

      if (updatedTrackId === oldTrackId) {
        // Cas simple : titre/artiste pas changé, juste métadonnées (album, genre, cover)
        // → on met à jour le doc existant avec merge:true (les autres champs
        // url/status/filename/size restent intacts)
        await setDoc(
          doc(db, 'users', uid, 'syncQueue', updatedTrackId),
          {
            title: t.title || '',
            artist: t.artist || '',
            album: t.album || '',
            year: t.year || null,
            genre: t.genre || null,
            albumArtUrl: coverUrl,
          },
          { merge: true }
        );
        console.log('[propagateTrackUpdate] pushed update for:', t.title);
      } else {
        // Cas trackId changé : on doit MIGRER le doc.
        // 1. Lire l'ancien doc complet (pour récupérer url/status/filename/size
        //    qui sont nécessaires côté mobile pour identifier le fichier déjà
        //    téléchargé)
        // 2. Créer le NOUVEAU doc avec les anciennes valeurs + nouvelles métadonnées
        // 3. Supprimer l'ancien doc
        let oldData = {};
        try {
          const oldSnap = await getDoc(doc(db, 'users', uid, 'syncQueue', oldTrackId));
          if (oldSnap.exists()) {
            oldData = oldSnap.data() || {};
          }
        } catch (e) {
          console.warn('[propagateTrackUpdate] read old doc failed:', e);
        }

        // Crée le nouveau doc avec FUSION ancienne données + nouvelles métadonnées
        await setDoc(
          doc(db, 'users', uid, 'syncQueue', updatedTrackId),
          {
            ...oldData,                       // size, addedAt, receivedAt...
            title: t.title || '',             // métadonnées modifiées
            artist: t.artist || '',
            album: t.album || '',
            year: t.year || null,
            genre: t.genre || null,
            albumArtUrl: coverUrl,
            // Phase 2 : l'URL doit pointer sur le NOUVEAU trackId (le serveur ne
            // sert plus l'ancien). Et comme le mobile élague le fichier de
            // l'ancien id (suppression locale), on repasse en 'pending' → il
            // re-télécharge sous le nouvel id depuis la bonne URL.
            url: `http://${myIP}:${myPort}/f/${updatedTrackId}`,
            filename: ((t.path || '').split('/').pop()) || oldData.filename || `${updatedTrackId}.mp3`,
            status: 'pending',
            errorMessage: '',
          }
          // pas de merge:true ici : on veut que le nouveau doc ait TOUS les
          // champs (la fusion est faite manuellement avec ...oldData)
        );

        // Supprime l'ancien doc
        try {
          await deleteDoc(doc(db, 'users', uid, 'syncQueue', oldTrackId));
        } catch (e) {
          console.warn('[propagateTrackUpdate] delete old doc failed:', e);
        }

        // Met à jour les indexes locaux
        window._pushedTrackIds.delete(oldTrackId);
        window._pushedTrackIds.add(updatedTrackId);
        window._pushedTrackPaths.set(track.path, updatedTrackId);
        // Rafraîchit l'index du serveur HTTP pour que /f/<updatedTrackId> résolve
        if (typeof _ensureHttpServed === 'function') _ensureHttpServed();
        console.log(`[propagateTrackUpdate] trackId migré: ${oldTrackId} → ${updatedTrackId}`);
      }
    } catch (e) {
      console.warn('[propagateTrackUpdate] failed:', e);
    }
  }, 5000);

  _trackUpdateTimers.set(track.path, timer);
}

// ── SYNC ──────────────────────────────────────────
// ── Listener Firestore syncQueue (NOUVEAU) ─────────────────────────────
// Le desktop écoute en temps réel la collection syncQueue de Firestore.
// Quand le mobile supprime un morceau (via removeFromSync), le doc
// disparaît, et ce listener met à jour syncSel localement + re-render
// le panneau Sync. Ainsi le panneau desktop reflète toujours l'état réel
// du mobile sans intervention manuelle.
//
// Logique :
//   - On reçoit la liste complète des docs Firestore
//   - On regarde quels paths du desktop correspondent (via slugify miroir)
//   - On retire de syncSel tout path qui n'a plus de doc Firestore associé
//   - On NE retire QUE les morceaux qui ont déjà été poussés (status existe).
//     Les morceaux fraichement glissés mais pas encore syncés gardent leur
//     présence dans syncSel — ils seront poussés au prochain clic Sync.

// Migration : ajoute le champ linkedTo aux docs syncQueue qui ne l'ont pas.
// Calcule l'état initial à partir des playlists synced existantes.
// S'exécute une fois au démarrage, idempotent (skip les docs déjà migrés).
async function _migrateLinkedTo(uid) {
  if (!window.WT?.firebase) return;
  const { db, collection, getDocs, doc, setDoc } = window.WT.firebase;

  try {
    // 1. Lire toutes les playlists synced pour savoir quel trackId est où
    const playlistsSnap = await getDocs(collection(db, 'users', uid, 'syncPlaylists'));
    const trackIdToPlaylists = new Map();  // trackId → ['pl_workout', ...]

    playlistsSnap.forEach(plDoc => {
      const plData = plDoc.data();
      const plId = plDoc.id;
      (plData.trackIds || []).forEach(tid => {
        if (!trackIdToPlaylists.has(tid)) trackIdToPlaylists.set(tid, []);
        trackIdToPlaylists.get(tid).push(plId);
      });
    });

    // 2. Lire tous les docs syncQueue et migrer ceux qui n'ont pas linkedTo
    const queueSnap = await getDocs(collection(db, 'users', uid, 'syncQueue'));
    let migrated = 0;

    for (const trackDoc of queueSnap.docs) {
      const data = trackDoc.data();
      if (data.linkedTo) continue;  // déjà migré

      const trackId = trackDoc.id;
      const linkedPlaylists = trackIdToPlaylists.get(trackId) || [];
      const linkedTo = {
        manual: linkedPlaylists.length === 0,  // si pas dans une playlist, c'est manuel
        playlists: linkedPlaylists,
      };

      await setDoc(trackDoc.ref, { linkedTo }, { merge: true });
      migrated++;
    }

    if (migrated > 0) {
      console.log(`[migrate linkedTo] ${migrated} doc(s) migré(s)`);
    }
  } catch (e) {
    console.warn('[migrate linkedTo] error:', e);
  }
}
// Patch N : migration des favoris depuis l'ancienne playlist system_favorites
// vers le nouveau champ isFavorite sur le doc syncQueue.
// Idempotent : skip les morceaux déjà migrés.
async function _migrateFavoritesFromPlaylist(uid) {
  if (!window.WT?.firebase) return;
  const { db, doc, getDoc, setDoc, deleteDoc } = window.WT.firebase;

  try {
    // 1. Lire la playlist system_favorites si elle existe encore
    const favRef = doc(db, 'users', uid, 'syncPlaylists', 'system_favorites');
    const favSnap = await getDoc(favRef);

    if (!favSnap.exists()) {
      return;  // déjà migrée et supprimée
    }

    const favData = favSnap.data();
    const trackIds = favData.trackIds || [];

    if (trackIds.length === 0) {
      // Playlist vide, on peut juste la supprimer
      await deleteDoc(favRef);
      console.log('[migrate favorites] ancienne playlist system_favorites vide, supprimée');
      return;
    }

    // 2. Pour chaque trackId, marquer le doc syncQueue avec isFavorite: true
    let migratedCount = 0;
    for (const trackId of trackIds) {
      try {
        const trackRef = doc(db, 'users', uid, 'syncQueue', trackId);
        await setDoc(trackRef, { isFavorite: true }, { merge: true });
        migratedCount++;
      } catch (e) {
        console.warn(`[migrate favorites] failed for ${trackId}:`, e);
      }
    }

    // 3. Supprimer la playlist obsolète
    await deleteDoc(favRef);

    console.log(`[migrate favorites] ${migratedCount} morceau(x) migré(s) vers isFavorite, ancienne playlist supprimée`);
  } catch (e) {
    console.warn('[migrate favorites] error:', e);
  }
}

let _syncQueueUnsubscribe = null;

// Reconstruit syncSel + _pushedTrackPaths depuis les ids Firestore, PUIS peuple
// le serveur HTTP local (_ensureHttpServed). Hoistée : appelable depuis le
// listener ET depuis bootLoad, quel que soit l'ordre de chargement. Exige
// allTracks déjà chargé (sinon 0 correspondance). Idempotente via le flag
// window._syncSelReconstructed.
function _reconstructSyncSelFromIds(ids) {
  if (!ids || ids.size === 0) return;
  if (typeof allTracks === 'undefined' || allTracks.length === 0) return;
  if (typeof syncSel === 'undefined') return;
  window._pushedTrackPaths = window._pushedTrackPaths || new Map();
  let mappedPaths = 0;
  allTracks.forEach(t => {
    if (!t.path) return;
    const tid = _trackIdFor(t);
    if (ids.has(tid)) {
      window._pushedTrackPaths.set(t.path, tid);
      syncSel.add(t.path);
      mappedPaths++;
    }
  });
  window._syncSelReconstructed = true;
  console.log(`[syncReconstruct] ${mappedPaths}/${ids.size} morceaux mappés, syncSel=${syncSel.size}`);
  // Bug A : peupler le serveur HTTP local (sinon /f/<id> → 404 toute la session).
  if (typeof _ensureHttpServed === 'function') _ensureHttpServed();
  if (typeof renderSyncQueue === 'function' && document.getElementById('syncView')?.classList.contains('on')) renderSyncQueue();
  if (typeof updateSyncStats === 'function') updateSyncStats(allTracks.filter(x => syncSel.has(x.path)));
}

function startSyncQueueListener() {
  if (_syncQueueUnsubscribe) {
    // Déjà actif — on cleanup avant de relancer
    try { _syncQueueUnsubscribe(); } catch {}
    _syncQueueUnsubscribe = null;
  }

  if (!window.WT?.firebase || !window.WT?.user) {
    console.warn('[syncQueue listener] Firebase pas pret, retry dans 2s');
    setTimeout(startSyncQueueListener, 2000);
    return;
  }

  const { db, collection, query, onSnapshot } = window.WT.firebase;
  const uid = window.WT.user.uid;

  console.log('[syncQueue listener] starting for uid:', uid);

  // Init des structures de tracking si pas déjà là
  window._pushedTrackIds = window._pushedTrackIds || new Set();
  window._pushedTrackPaths = window._pushedTrackPaths || new Map();

  const q = query(collection(db, 'users', uid, 'syncQueue'));
  // Migration linkedTo : enrichit les docs syncQueue existants qui n'ont pas
  // encore le champ linkedTo. Calcule l'état initial depuis syncPlaylists.
  _migrateLinkedTo(uid).catch(e => console.warn('[migrate linkedTo] failed:', e));
  _migrateFavoritesFromPlaylist(uid).catch(e => console.warn('[migrate favorites] failed:', e));
  _syncQueueUnsubscribe = onSnapshot(q, snap => {
    // Slugify déclaré AU DÉBUT du callback pour être disponible partout
    const _slugifyTrack = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0, 60);

    // Construit le set des trackIds présents dans Firestore
    // Patch N : propage aussi isFavorite des docs vers les tracks desktop locaux
    const firestoreIds = new Set();
    window._syncMirror = new Map();
    let favoritesChanged = false;

    snap.forEach(d => {
      firestoreIds.add(d.id);
      const _md = d.data();
      window._syncMirror.set(d.id, {
        id: d.id,
        title: _md.title || '',
        artist: _md.artist || '',
        album: _md.album || '',
        year: _md.year || null,
        genre: _md.genre || null,
        cover: _md.albumArtUrl || '',
        size: _md.size || 0,
        status: _md.status || 'pending',
        errorMessage: _md.errorMessage || '',
        filename: _md.filename || '',
        url: _md.url || '',
      });

      const data = d.data();
      if (typeof data.isFavorite !== 'boolean') return;

      // Cherche le track desktop correspondant (via path → trackId mapping)
      let track = null;
      if (window._pushedTrackPaths) {
        for (const [path, tid] of window._pushedTrackPaths) {
          if (tid === d.id) {
            track = (typeof allTracks !== 'undefined')
              ? allTracks.find(x => x.path === path)
              : null;
            break;
          }
        }
      }
      // Fallback : tente par slug si le mapping n'existe pas encore
      if (!track && typeof allTracks !== 'undefined') {
        track = allTracks.find(x => _trackIdFor(x) === d.id);
      }

      if (track && track.isFavorite !== data.isFavorite) {
        track.isFavorite = data.isFavorite;
        favoritesChanged = true;
        // Persister localement aussi (prefs.trackMeta) pour ne pas perdre au redémarrage
        if (window.wt?.setTrackFavorite && track.path) {
          window.wt.setTrackFavorite(track.path, data.isFavorite).catch(() => {});
        }
      }
    });

    if (favoritesChanged) {
      console.log('[syncQueue listener] favoris mis à jour depuis mobile');
      // Patch N.3.2 : rebuild la smart playlist Favoris + maj live si on est dessus
      if (typeof _injectOrRebuildFavoritesList === 'function') {
        const favIdx = _injectOrRebuildFavoritesList();
        if (curPl === favIdx && allLists[favIdx]) {
          filtered = [...allLists[favIdx].tracks];
          if (typeof applySortToFiltered === 'function') applySortToFiltered();
          if (typeof updateBreadcrumb === 'function') updateBreadcrumb();
        }
      }
      if (typeof renderVirtual === 'function') renderVirtual();
      if (typeof renderSidebar === 'function') renderSidebar();
    }

    // Réflexion mobile→desktop du flag no-play-in-shuffle : si le mobile a
    // (dé)marqué un morceau, on met à jour le _noShuffleSet local (indexé
    // par path) + persistance localStorage. Boucle DÉDIÉE pour ne pas
    // heurter le early-return de la boucle favoris ci-dessus.
    let _noShufChanged = false;
    snap.forEach(d => {
      const data = d.data();
      if (typeof data.noShuffle !== 'boolean') return;
      // Résout le path desktop (reverse _pushedTrackPaths, repli slug)
      let path = null;
      if (window._pushedTrackPaths) {
        for (const [p, tid] of window._pushedTrackPaths) {
          if (tid === d.id) { path = p; break; }
        }
      }
      if (!path && typeof allTracks !== 'undefined') {
        const t = allTracks.find(x => _trackIdFor(x) === d.id);
        if (t) path = t.path;
      }
      if (!path) return;
      const has = _noShuffleSet.has(path);
      if (data.noShuffle && !has) { _noShuffleSet.add(path); _noShufChanged = true; }
      else if (!data.noShuffle && has) { _noShuffleSet.delete(path); _noShufChanged = true; }
    });
    if (_noShufChanged) {
      try { localStorage.setItem('wt_no_shuffle', JSON.stringify([..._noShuffleSet])); } catch {}
      if (typeof _refreshNoShuffleBtn === 'function') _refreshNoShuffleBtn();
      if (typeof computeNext === 'function') computeNext();
      console.log('[syncQueue listener] noShuffle mis à jour depuis mobile');
    }

    // Au premier snapshot après démarrage, on peuple _pushedTrackIds,
    // _pushedTrackPaths ET syncSel depuis Firestore. Permet au listener
    // de connaître l'état initial (= ce qui est sur le mobile) après
    // redémarrage desktop, et de reconstruire le panneau Sync à l'identique.
    // Marque _pushedTrackIds dès le 1er snapshot (détection des suppressions ;
    // n'a pas besoin d'allTracks).
    if (window._pushedTrackIds.size === 0 && firestoreIds.size > 0) {
      firestoreIds.forEach(id => window._pushedTrackIds.add(id));
      console.log(`[syncQueue listener] init _pushedTrackIds avec ${firestoreIds.size} trackIds depuis Firestore`);
    }

    // Reconstruction syncSel + serveur HTTP, séparée du garde ci-dessus. Tant
    // qu'allTracks n'est pas chargé, on mémorise les ids (_pendingSyncIds) et on
    // retentera depuis bootLoad. Corrige la course au démarrage (Firestore prêt
    // avant le scan) qui laissait syncSel vide et le serveur jamais peuplé.
    // Priorité au transfert : si des docs sont encore 'pending' (mobile en
    // train de télécharger), on met l'enrichissement métadonnées en pause.
    if (typeof enrichQueue !== 'undefined') {
      let _anyPending = false;
      if (window._syncMirror) for (const m of window._syncMirror.values()) { if (m.status !== 'received' && m.status !== 'error') { _anyPending = true; break; } }
      if (_anyPending) enrichQueue.pauseForSync(); else enrichQueue.resumeAfterSync();
    }

    window._pendingSyncIds = firestoreIds;
    if (!window._syncSelReconstructed && firestoreIds.size > 0
        && typeof allTracks !== 'undefined' && allTracks.length > 0
        && typeof syncSel !== 'undefined') {
      _reconstructSyncSelFromIds(firestoreIds);
    }

    // Détecter les suppressions : path dans syncSel + trackId déjà poussé +
    // trackId absent de Firestore = suppression mobile à propager localement
    let removedCount = 0;
    const pathsToRemove = [];
    syncSel.forEach(path => {
      const t = allTracks.find(x => x.path === path);
      if (!t) return;
      const trackId = _trackIdFor(t);
      if (!trackId || trackId === '__') return;

      if (window._pushedTrackIds.has(trackId) && !firestoreIds.has(trackId)) {
        pathsToRemove.push(path);
        removedCount++;
      }
    });

    if (removedCount > 0) {
      pathsToRemove.forEach(p => {
        syncSel.delete(p);
        const t = allTracks.find(x => x.path === p);
        if (t) {
          const tid = _trackIdFor(t);
          window._pushedTrackIds.delete(tid);
          window._pushedTrackPaths.delete(p);
        }
      });
      console.log(`[syncQueue listener] retiré ${removedCount} morceau(x) du sync (suppression mobile)`);
      // Re-render si le panneau Sync est ouvert
      if (typeof renderSyncQueue === 'function' && document.getElementById('syncView')?.classList.contains('on')) {
        renderSyncQueue();
      }
      // Toast pour l'user
      if (typeof toast === 'function') {
        toast(`${removedCount} morceau${removedCount > 1 ? 'x' : ''} retiré${removedCount > 1 ? 's' : ''} (action mobile)`);
      }
    }

    // Phase 2 : le miroir vient d'être (re)peuplé. On marque l'état « prêt »
    // et on RE-REND systématiquement le panneau Sync s'il est ouvert. Sans ça,
    // le 1er snapshot peuplait _syncMirror mais ne déclenchait aucun render
    // (sauf suppression/favori) → compteur figé tant qu'on ne cliquait pas.
    window._syncMirrorReady = true;
    if (typeof renderSyncQueue === 'function' && document.getElementById('syncView')?.classList.contains('on')) {
      renderSyncQueue();
    }
    // Réparation one-shot des docs en erreur dont le fichier a dérivé
    if (typeof _repairSyncUrls === 'function') _repairSyncUrls().catch(() => {});
  }, err => {
    console.warn('[syncQueue listener] error:', err);
  });
}

// ── Listener Firestore syncPlaylists (Patch D) ───────────────────────────
// Écoute les playlists créées/modifiées/supprimées sur le mobile (et aussi
// celles du desktop poussées via _syncPushPlaylistToFirestore). Reflète les
// changements dans allLists desktop.
//
// Quand une playlist arrive sur Firestore :
//   - Si elle existe dans allLists (par nom), on met à jour son contenu
//   - Sinon, on l'ajoute comme nouvelle playlist desktop, marquée _sync=true
//
// Quand une playlist est supprimée de Firestore : on retire le flag _sync
// localement (la playlist desktop ne disparaît pas, mais sort du miroir).

let _syncPlaylistsUnsubscribe = null;

function startSyncPlaylistsListener() {
  if (_syncPlaylistsUnsubscribe) {
    try { _syncPlaylistsUnsubscribe(); } catch {}
    _syncPlaylistsUnsubscribe = null;
  }

  if (!window.WT?.firebase || !window.WT?.user) {
    console.warn('[syncPlaylists listener] Firebase pas pret, retry dans 2s');
    setTimeout(startSyncPlaylistsListener, 2000);
    return;
  }

  const { db, collection, query, onSnapshot } = window.WT.firebase;
  const uid = window.WT.user.uid;

  console.log('[syncPlaylists listener] starting for uid:', uid);

  const q = query(collection(db, 'users', uid, 'syncPlaylists'));
  _syncPlaylistsUnsubscribe = onSnapshot(q, snap => {
    let changes = 0;

    snap.docChanges().forEach(change => {
      const data = change.doc.data();
      const playlistId = change.doc.id;

      if (change.type === 'added' || change.type === 'modified') {
        // On cherche la playlist locale par son nom
        const existing = allLists.find(l => l.name === data.name);

        if (existing) {
          // Mise à jour : reconstruire les tracks à partir des trackIds Firestore
          // (= slug 'artist__title')
          const slugify = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0, 60);
          const newTracks = (data.trackIds || [])
            .map(slug => allTracks.find(t => _trackIdFor(t) === slug))
            .filter(Boolean);

          // On met à jour SEULEMENT si la modif vient du mobile (pour éviter
          // une boucle desktop → firestore → desktop)
          if (data.updatedBy === 'mobile') {
            existing.tracks = newTracks;
            existing.count = newTracks.length;
            existing._sync = true;
            existing._syncFirestoreId = playlistId;
            // Patch E : enregistrer le hash actuel pour ne pas re-pousser inutilement
            if (typeof _syncedPlaylistHashes !== 'undefined' && typeof _hashPlaylist === 'function') {
              _syncedPlaylistHashes.set(playlistId, _hashPlaylist(existing));
            }
            changes++;
            console.log(`[syncPlaylists listener] playlist "${data.name}" mise à jour depuis mobile (${newTracks.length} morceaux)`);
          } else {
            // Modif vient du desktop, on marque juste comme syncée
            existing._sync = true;
            existing._syncFirestoreId = playlistId;
            if (typeof _syncedPlaylistHashes !== 'undefined' && typeof _hashPlaylist === 'function') {
              _syncedPlaylistHashes.set(playlistId, _hashPlaylist(existing));
            }
          }
        } else if (data.updatedBy === 'mobile') {
          // Nouvelle playlist créée sur mobile : on l'ajoute à allLists
          const slugify = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0, 60);
          const tracks = (data.trackIds || [])
            .map(slug => allTracks.find(t => _trackIdFor(t) === slug))
            .filter(Boolean);

          const newPl = {
            name: data.name,
            tracks,
            count: tracks.length,
            custom: true,
            _sync: true,
            _syncFirestoreId: playlistId,
          };
          allLists.push(newPl);
          // Patch E : enregistrer le hash de la nouvelle playlist
          if (typeof _syncedPlaylistHashes !== 'undefined' && typeof _hashPlaylist === 'function') {
            _syncedPlaylistHashes.set(playlistId, _hashPlaylist(newPl));
          }
          changes++;
          console.log(`[syncPlaylists listener] nouvelle playlist mobile ajoutée: "${data.name}" (${tracks.length} morceaux)`);
        }
      }

      if (change.type === 'removed') {
        const existing = allLists.find(l => l._syncFirestoreId === playlistId);
        if (existing && existing._sync) {
          existing._sync = false;
          delete existing._syncFirestoreId;
          // Patch E : nettoyer le hash
          if (typeof _syncedPlaylistHashes !== 'undefined') {
            _syncedPlaylistHashes.delete(playlistId);
          }
          changes++;
          console.log(`[syncPlaylists listener] playlist "${existing.name}" sortie du sync`);
        }
      }
    });

    if (changes > 0) {
      // Re-render la sidebar et persister
      if (typeof renderSidebar === 'function') renderSidebar();
      if (typeof scheduleSave === 'function') scheduleSave();
    }
  }, err => {
    console.warn('[syncPlaylists listener] error:', err);
  });
}

function removeGroupFromSync(groupType, groupValue) {
  let tracksToRemove = [];

  if (groupType === 'artist') {
    tracksToRemove = allTracks.filter(t => (t.artist || 'Artiste inconnu') === groupValue);
  } else if (groupType === 'genre') {
    tracksToRemove = allTracks.filter(t => (t.genre || 'Non classé') === groupValue);
  } else if (groupType === 'year') {
    const year = groupValue === 'Année inconnue' ? null : parseInt(groupValue, 10);
    tracksToRemove = allTracks.filter(t => (t.year || null) === year);
  } else if (groupType === 'album') {
    const [artistNorm, albumNorm] = groupValue.split('||');
    const normalize = s => (s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    tracksToRemove = allTracks.filter(t => normalize(t.album) === albumNorm && (artistNorm === '' || normalize(t.artist) === artistNorm));
  } else if (groupType === 'playlist') {
    const playlist = allLists.find(p => p._syncFirestoreId === groupValue || p.name === groupValue);
    if (playlist && playlist.tracks) tracksToRemove = playlist.tracks;
  }

  if (!tracksToRemove.length) return;

  let removed = 0;
  tracksToRemove.forEach(t => {
    if (syncSel.has(t.path)) {
      syncSel.delete(t.path);
      _syncLinkRemove(t, { manual: true });
      removed++;
    }
  });

  _ensureHttpServed();
  renderSyncQueue();
  toast(`- ${removed} morceau${removed > 1 ? 'x' : ''} retiré${removed > 1 ? 's' : ''} du Sync`);
}

function _handleSyncRemove(e) {
  // Empêche la propagation : sinon le clic sur la croix d'un morceau dans
  // un accordéon ferme l'accordéon parent (le <summary> intercepterait).
  e.stopPropagation();
  e.preventDefault();
  const btn = e.currentTarget;
  const docId = btn.getAttribute('data-syncdoc');
  if (docId) { removeSyncByDocId(docId); return; }
  const path = btn.getAttribute('data-path');
  if (path) removeSync(path);
}

function _handleGroupRemove(e) {
  // Empêche la propagation : la croix du groupe est placée DANS un <summary>,
  // qui par défaut toggle l'accordéon au clic. On veut juste retirer le groupe,
  // pas refermer l'accordéon.
  e.stopPropagation();
  e.preventDefault();
  const btn = e.currentTarget;
  const groupType = btn.getAttribute('data-group-type');
  const groupValue = btn.getAttribute('data-group-value');
  if (groupType && groupValue) {
    if (confirm(`Retirer tous les morceaux de ce ${groupType} du Sync ?`)) {
      removeGroupFromSync(groupType, groupValue);
    }
  }
}

/**
 * Attache les listeners de croix × sur tous les boutons de l'élément cible.
 * Idempotent : on retire d'abord les listeners existants avant d'en remettre.
 * À appeler après TOUT rendu d'une vue Sync, y compris les re-renders
 * partiels (vue détail album, click "Retour", etc.) sinon les croix sont
 * inertes après un re-render.
 *
 * @param {HTMLElement} el Conteneur dans lequel chercher les boutons
 */
function _attachSyncListeners(el) {
  if (!el) return;

  // Suppression d'un morceau individuel
  el.querySelectorAll('.sync-tr-x').forEach(btn => {
    btn.removeEventListener('click', _handleSyncRemove);
    btn.addEventListener('click', _handleSyncRemove);
  });

  // Réessayer un transfert en erreur
  el.querySelectorAll('.sync-tr-retry').forEach(btn => {
    btn.removeEventListener('click', _handleSyncRetry);
    btn.addEventListener('click', _handleSyncRetry);
  });

  // Clic droit sur une ligne résolue → menu contextuel morceau (mêmes actions
  // que la bibliothèque : lire, modifier infos & pochette, afficher dans le
  // Finder, etc.). Pas de menu pour les lignes « fichier introuvable » (pas de
  // chemin local exploitable).
  el.querySelectorAll('.sync-tr-row[data-syncctxpath]').forEach(row => {
    row.removeEventListener('contextmenu', _handleSyncCtx);
    row.addEventListener('contextmenu', _handleSyncCtx);
  });

  // Bouton ⋮ « Plus d'options » → ouvre le même menu au clic gauche (affordance
  // visible, en plus du clic droit).
  el.querySelectorAll('.sync-tr-more').forEach(btn => {
    btn.removeEventListener('click', _handleSyncCtx);
    btn.addEventListener('click', _handleSyncCtx);
  });

  // Suppression d'un groupe (artiste, genre, année, album, playlist)
  el.querySelectorAll('.sync-group-x').forEach(btn => {
    btn.removeEventListener('click', _handleGroupRemove);
    btn.addEventListener('click', _handleGroupRemove);
  });

  // Split buttons ▶/🔀 : un seul délégateur sur le conteneur, qui route
  // les clics vers playGroup ou shuffleGroup selon data-wt-ps-action.
  // Le data-wt-ps-id porte le type et la valeur (ex. "artist:Pink Floyd").
  el.removeEventListener('click', _handleSyncSplitButton);
  el.addEventListener('click', _handleSyncSplitButton);
}

/**
 * Handler unique pour tous les clics de split button dans le panneau Sync.
 * Récupère le type/valeur via data-wt-ps-id sur le parent .wt-ps, et
 * l'action via data-wt-ps-action sur le bouton cliqué. Reconstruit la
 * liste de morceaux concernée et appelle playGroup/shuffleGroup.
 */
function _handleSyncSplitButton(e) {
  // On cherche le bouton .wt-ps-play ou .wt-ps-shuf cliqué (ou parent du clic)
  const btn = e.target.closest('.wt-ps-play, .wt-ps-shuf');
  if (!btn) return;

  // Empêche la propagation : sinon ouvre/ferme l'accordéon parent par exemple
  e.stopPropagation();
  e.preventDefault();

  const wrap = btn.closest('.wt-ps');
  if (!wrap) return;

  const id = wrap.getAttribute('data-wt-ps-id') || '';
  const action = btn.getAttribute('data-wt-ps-action') || 'play';

  // Décompose data-wt-ps-id : "type:value" → kind + label
  const sepIdx = id.indexOf(':');
  if (sepIdx < 0) {
    console.warn('[_handleSyncSplitButton] data-wt-ps-id invalide:', id);
    return;
  }
  const kind = id.slice(0, sepIdx);
  const value = id.slice(sepIdx + 1);

  // Reconstruit la liste de morceaux selon le type
  const tracks = _resolveSyncGroupTracks(kind, value);
  if (!tracks.length) {
    toast('Aucun morceau dans ce groupe');
    return;
  }

  // Lance la lecture
  if (action === 'shuffle') {
    shuffleGroup(tracks, kind, _prettyGroupLabel(kind, value));
  } else {
    playGroup(tracks, kind, _prettyGroupLabel(kind, value));
  }
}

// ============================================================
// COULEURS DE GENRES — helper centralisé
// ============================================================
// Mapping genre → variable CSS, cohérent avec les sélecteurs CSS
// .ag-row.genre-row[data-genre="..."] de la vue Genres biblio.
const _GENRE_COLOR_MAP = {
  'Blues, Roots & Gospel':       '#7BA9E0',
  'Jazz & Swing':                '#C7825F',
  'Soul, Funk & Disco':          '#D178D8',
  'Classic Rock & Hard Rock':    '#E8A87C',
  'Punk, Grunge & Alternative':  '#A39CFF',
  'Heavy Metal & Loud':          '#E84545',
  'Hip-Hop & Rap Culture':       '#FFD93D',
  'R&B, Pop & Dance':            '#FF6BAD',
  'Folk, Country & Americana':   '#D4B896',
  'Ambient, New Age & Chill':    '#9DC4B5',
  'Electronic, House & Techno':  '#5BA8FF',
  'Reggae, Dub & Ska':           '#5DBB63',
  'Latin, Caribbean, Flamenco, Tango':           '#F26B5E',
  'Afrobeat, African & World':   '#FF9F40',
  'Classical & Opera':           '#B3DEC1',
  'Soundtrack & Score':          '#6E5AA6',
  'Chanson & Variété':           '#3DAA9E',
  'Classical, Opera & Score':    '#B3DEC1',
};

/**
 * Retourne la couleur hex associée à un genre, ou la couleur par
 * défaut si genre inconnu / vide.
 */
function getGenreColor(genre) {
  if (!genre) return '#AEACA6';
  return _GENRE_COLOR_MAP[genre] || '#AEACA6';
}

/**
 * Retourne la même couleur sous forme rgba() avec opacité personnalisée.
 * Utilisé pour le dégradé d'ambiance fullscreen.
 */
function getGenreColorRgba(genre, alpha = 0.15) {
  const hex = getGenreColor(genre).replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ══════════════════════════════════════════════════════════════════════
// C220 — CLÉS DE GROUPE : SOURCE DE VÉRITÉ UNIQUE
// ══════════════════════════════════════════════════════════════════════
// L'accordéon et les boutons ▶/🔀 dérivaient l'appartenance à un groupe de deux
// façons différentes. Le délégateur des split buttons refaisait le calcul en
// parsant le LIBELLÉ affiché — d'où « Aucun morceau dans ce groupe » sur un
// groupe qui en contient 8057. Une seule fonction par dimension, désormais.
function wtYearBucket(yr) {
  if (!yr) return { key: 'unknown', label: 'Sans année', sortKey: -Infinity };
  if (yr >= 1910) {
    const dec = Math.floor(yr / 10) * 10;
    return { key: 'dec-' + dec, label: 'Années ' + dec, sortKey: dec };
  }
  const century = Math.floor((yr - 1) / 100) + 1;
  const roman = ['', 'Iᵉ', 'IIᵉ', 'IIIᵉ', 'IVᵉ', 'Vᵉ', 'VIᵉ', 'VIIᵉ', 'VIIIᵉ', 'IXᵉ', 'Xᵉ', 'XIᵉ', 'XIIᵉ', 'XIIIᵉ', 'XIVᵉ', 'XVᵉ', 'XVIᵉ', 'XVIIᵉ', 'XVIIIᵉ', 'XIXᵉ', 'XXᵉ'][century] || (century + 'ᵉ');
  return { key: 'cent-' + century, label: roman + ' siècle', sortKey: (century - 1) * 100 };
}
// Libellés EXACTEMENT ceux de l'accordéon (voir buildRows) — toute divergence
// ici casse silencieusement la lecture d'un groupe entier.
function wtYearLabel(t)   { return wtYearBucket(t.year || 0).label; }
function wtGenreLabel(t)  { return t.genre || '(Sans genre)'; }
function wtArtistLabel(t) {
  return (typeof _artistDisplayGroup === 'function' ? _artistDisplayGroup(t.artist) : t.artist) || '(Artiste inconnu)';
}

// C221 : bouton × de la barre de recherche. _searchClearSync affiche/masque le
// × selon que le champ est vide ; clearSearch le vide et relance la recherche.
function _searchClearSync(){
  const inp = document.getElementById('searchIn');
  const box = inp && inp.closest('.search-box');
  if (box) box.classList.toggle('has-q', !!(inp.value || '').length);
}
function clearSearch(){
  const inp = document.getElementById('searchIn');
  if (!inp) return;
  inp.value = '';
  _searchClearSync();
  if (typeof onSearch === 'function') onSearch();
  inp.focus();
}

/**
 * Délégateur biblio : un seul listener sur le conteneur de la liste virtual
 * scroll, qui route les clics split button vers playGroup/shuffleGroup.
 * Contrairement à _handleSyncSplitButton, ici on résout les tracks depuis
 * `filtered` (état biblio courant), pas depuis syncSel.
 */
function _handleLibSplitButton(e) {
  const btn = e.target.closest('.wt-ps-play, .wt-ps-shuf');
  if (!btn) return;
  e.stopPropagation();
  e.preventDefault();

  const wrap = btn.closest('.wt-ps');
  if (!wrap) return;

  const id = wrap.getAttribute('data-wt-ps-id') || '';
  const action = btn.getAttribute('data-wt-ps-action') || 'play';

  const sepIdx = id.indexOf(':');
  if (sepIdx < 0) return;
  const kind = id.slice(0, sepIdx);
  const value = id.slice(sepIdx + 1);

  // Reconstruit les tracks depuis `filtered` (biblio)
  let tracks = [];
  if (kind === 'all') {
    // Bouton "Tous les morceaux" : on prend allTracks (pas filtered, qui peut
    // être restreint à une playlist en cours)
    tracks = allTracks;
  } else if (kind === 'artist') {
    // C220 : l'accordéon regroupe les VARIANTES d'artiste (_artistDisplayGroup,
    // C159) — « Béla Fleck » et « Bela Fleck » sont une seule ligne. Le résolveur
    // comparait le tag brut → la ligne groupée ne retrouvait pas ses morceaux.
    tracks = filtered.filter(t => wtArtistLabel(t) === value);
  } else if (kind === 'album') {
    // value format possible : "artist||album" (de la rangée album) ou "label" (de la sous-rangée)
    if (value.includes('||')) {
      const [artistPart, albumPart] = value.split('||');
      tracks = filtered.filter(t =>
        (t.artist || '(Artiste inconnu)') === artistPart &&
        (t.album || '(Album inconnu)') === albumPart
      );
    } else {
      // Sous-rangée album : on filtre uniquement par nom d'album
      tracks = filtered.filter(t => (t.album || '(Album inconnu)') === value);
    }
  } else if (kind === 'genre') {
    // C220 : l'accordéon libelle « (Sans genre) », le résolveur cherchait
    // « Non classé » → le groupe sans genre ne trouvait jamais ses morceaux.
    tracks = filtered.filter(t => wtGenreLabel(t) === value);
  } else if (kind === 'year') {
    // C220 : `value` est le LIBELLÉ d'un bucket (« Sans année », « Années 1970 »,
    // « XVIIIᵉ siècle »), PAS une année. parseInt('Sans année') → NaN, et
    // `x === NaN` est TOUJOURS faux → zéro morceau sur TOUS les groupes année,
    // y compris celui qui en contient 8057. On rejoue le bucket de l'accordéon.
    tracks = filtered.filter(t => wtYearLabel(t) === value);
  } else if (kind === 'track') {
    tracks = filtered.filter(t => t.path === value);
  }

  if (!tracks.length) {
    toast('Aucun morceau dans ce groupe');
    return;
  }

  if (action === 'shuffle') {
    shuffleGroup(tracks, kind, value);
  } else {
    playGroup(tracks, kind, value);
  }
}

// Listener global sur la zone biblio. On installe une seule fois au boot
// (ou lazy au premier rendu) sur le conteneur de la liste virtuelle.
// Comme `lw` est rebuilt à chaque renderVirtual, on attache à un parent stable.
function _ensureLibSplitButtonDelegate() {
  // Cible : le conteneur stable de la zone biblio (parent du virtual scroll).
  // On utilise document comme fallback ultime : sûr, et le filtre `.wt-ps`
  // dans le handler empêche tout effet secondaire.
  if (window._wtLibSplitInstalled) return;
  window._wtLibSplitInstalled = true;
  document.addEventListener('click', _handleLibSplitButton, true);
  // useCapture=true : capture phase, on intercepte AVANT que les listeners
  // de rangées (toggle expand) ne s'exécutent. Mais comme on stopPropagation
  // seulement si on est sur un .wt-ps, le reste continue normalement.
}
_ensureLibSplitButtonDelegate();

/**
 * Reconstruit la liste de morceaux pour un type/valeur donnés, restreints
 * à ce qui est actuellement dans syncSel (le panneau Sync ne joue que des
 * morceaux sync'és, c'est cohérent avec son rôle de miroir mobile).
 */
function _resolveSyncGroupTracks(kind, value) {
  const inSync = allTracks.filter(t => syncSel.has(t.path));

  if (kind === 'track') {
    // value = path du morceau
    return inSync.filter(t => t.path === value);
  }
  if (kind === 'all') {
    // value = '' (toute la sync)
    return inSync;
  }
  if (kind === 'artist') {
    return inSync.filter(t => wtArtistLabel(t) === value);   // C220
  }
  if (kind === 'genre') {
    return inSync.filter(t => wtGenreLabel(t) === value);    // C220
  }
  if (kind === 'year') {
    return inSync.filter(t => wtYearLabel(t) === value);     // C220 : bucket, pas parseInt
  }
  if (kind === 'album') {
    // value = "artistNorm||albumNorm"
    const [artistNorm, albumNorm] = value.split('||');
    const normalize = s => (s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return inSync.filter(t =>
      normalize(t.album) === albumNorm &&
      (artistNorm === '' || normalize(t.artist) === artistNorm)
    );
  }
  if (kind === 'playlist') {
    // value = playlist._syncFirestoreId ou playlist.name
    const pl = allLists.find(p => p._syncFirestoreId === value || p.name === value);
    if (!pl || !pl.tracks) return [];
    return pl.tracks.filter(t => syncSel.has(t.path));
  }
  return [];
}

/**
 * Convertit un (kind, value) en libellé lisible pour le toast/contexte.
 */
function _prettyGroupLabel(kind, value) {
  if (kind === 'all') return 'Sync';
  if (kind === 'track') {
    const t = allTracks.find(x => x.path === value);
    return t ? (t.title || 'Morceau') : 'Morceau';
  }
  if (kind === 'album') {
    const [, albumNorm] = value.split('||');
    // Cherche le vrai libellé d'album depuis allTracks
    const normalize = s => (s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const sample = allTracks.find(t => normalize(t.album) === albumNorm);
    return sample ? (sample.album || 'Album') : 'Album';
  }
  return value;
}


// Démarre le listener playlists dès que Firebase est prêt
document.addEventListener('wt:firebase-ready', () => {
  const tryStart = () => {
    if (window.WT?.user) {
      startSyncPlaylistsListener();
    } else {
      document.addEventListener('wt:auth-changed', (e) => {
        if (e.detail?.user) startSyncPlaylistsListener();
      }, { once: false });
    }
  };
  tryStart();
});

// Démarre le listener dès que Firebase est prêt
document.addEventListener('wt:firebase-ready', () => {
  // On attend aussi que l'user soit signed in
  const tryStart = () => {
    if (window.WT?.user) {
      startSyncQueueListener();
    } else {
      // Pas encore signed in, on attend l'event auth-changed
      document.addEventListener('wt:auth-changed', (e) => {
        if (e.detail?.user) startSyncQueueListener();
      }, { once: false });
    }
  };
  tryStart();
});



let _syncTab = 'tous';  // 'tous' | 'artistes' | 'albums' | 'genres' | 'annees' | 'playlists'

// Liste des 6 onglets (référence unique)
const _SYNC_TABS = ['tous', 'artistes', 'albums', 'genres', 'annees', 'playlists'];

function setSyncTab(tab) {
  // Compat ascendante : si du vieux code appelle setSyncTab('all'), on redirige
  if (tab === 'all') tab = 'tous';
  if (!_SYNC_TABS.includes(tab)) {
    console.warn('[setSyncTab] tab inconnu:', tab, '→ fallback tous');
    tab = 'tous';
  }
  _syncTab = tab;

  // Bascule la classe .on sur le bon bouton
  document.querySelectorAll('.sync-tab').forEach(b => {
    b.classList.toggle('on', b.dataset.tab === tab);
  });

  // Bascule la classe .on sur le bon pane (display CSS gère l'affichage)
  document.querySelectorAll('.sync-tab-pane').forEach(p => {
    p.classList.toggle('on', p.id === `syncTab-${tab}`);
  });

  renderSyncQueue();
}

// Bascule la vue Sync sur « erreurs seulement » (ou retour à tout). Appelée par
// le segment cliquable du compteur d'en-tête.
function toggleSyncErrorsOnly(on) {
  window._syncErrorsOnly = (typeof on === 'boolean') ? on : !window._syncErrorsOnly;
  if (typeof renderSyncQueue === 'function') renderSyncQueue();
}

function renderSyncQueue() {
  // Cible le pane actif en fonction de _syncTab
  const el = document.getElementById(`syncTab-${_syncTab}`);
  if (!el) {
    console.warn('[renderSyncQueue] pane introuvable: syncTab-' + _syncTab);
    return;
  }

  const searchEl = document.getElementById('syncSearch');
  const search = (searchEl?.value || '').toLowerCase().trim();

  // Tous les morceaux sync'és — MIROIR de Firestore (= état du téléphone).
  // On part de la file Firestore (_syncMirror) pour refléter exactement ce qui
  // est sur le mobile, puis on ajoute les ajouts locaux pas encore poussés
  // (optimiste). Un morceau présent en local est résolu vers son objet
  // bibliothèque (chemin réel, lecture/pochette OK) ; sinon il s'affiche en
  // "fichier local introuvable" (_missingLocal) au lieu de disparaître.
  const _byId = new Map(allTracks.map(t => [_trackIdFor(t), t]));
  const _seenP = new Set();
  let allInSync = [];
  if (window._syncMirror && window._syncMirror.size) {
    for (const m of window._syncMirror.values()) {
      const local = _byId.get(m.id)
        || _resolveTrackInLibrary({ id: m.id, artist: m.artist, album: m.album, title: m.title, filename: m.filename });
      if (local) {
        local._syncStatus = m.status;
        local._syncDocId = m.id;
        local._syncError = m.errorMessage;
        local._syncSize = m.size;     // la taille vit sur le doc, pas sur le track local
        local._syncCover = m.cover;   // cover poussée vers le mobile (repli si pas de cover locale)
        allInSync.push(local);
        if (local.path) _seenP.add(local.path);
      } else {
        allInSync.push({
          path: '__sync__' + m.id, _syncDocId: m.id, _missingLocal: true,
          title: m.title, artist: m.artist, album: m.album,
          year: m.year, genre: m.genre, _art: m.cover, size: m.size,
          _syncStatus: m.status, _syncError: m.errorMessage,
        });
      }
    }
  }
  allTracks.forEach(t => {
    if (syncSel.has(t.path) && !_seenP.has(t.path)) { allInSync.push(t); _seenP.add(t.path); }
  });

  // Filtre « erreurs seulement » (toggle via le compteur). On garde le total
  // réel pour l'affichage du compteur, puis on restreint la vue aux erreurs.
  const _fullTot = allInSync.length;
  const _errOnly = !!window._syncErrorsOnly;
  if (_errOnly) allInSync = allInSync.filter(t => t._syncStatus === 'error');

  // Filtre par recherche (titre, artiste, album)
  const matchesSearch = (t) => {
    if (!search) return true;
    return (t.title || '').toLowerCase().includes(search)
        || (t.artist || '').toLowerCase().includes(search)
        || (t.album || '').toLowerCase().includes(search);
  };

  const filtered = allInSync.filter(matchesSearch);
  const sel = filtered;

  // Compteur global (sur tout le sync, pas filtré)
  const ctEl = document.getElementById('syncCt');
  if (ctEl) {
    let _ok = 0, _err = 0, _wait = 0;
    if (window._syncMirror) for (const m of window._syncMirror.values()) {
      if (m.status === 'received') _ok++; else if (m.status === 'error') _err++; else _wait++;
    }
    const _tot = _fullTot;
    // Spinner « sync en cours » dès qu'il reste des transferts en attente —
    // animation visible (le flash de boot l'était à peine).
    const _spin = _wait > 0
      ? `<svg width="11" height="11" viewBox="0 0 50 50" style="vertical-align:-1px;margin-right:5px;"><circle cx="25" cy="25" r="20" fill="none" stroke="rgba(200,90,69,0.25)" stroke-width="6"/><circle cx="25" cy="25" r="20" fill="none" stroke="var(--acc)" stroke-width="6" stroke-linecap="round" stroke-dasharray="70 200"><animateTransform attributeName="transform" type="rotate" from="0 25 25" to="360 25 25" dur="0.8s" repeatCount="indefinite"/></circle></svg>`
      : '';
    let _txt;
    if (_ok === _tot && !_wait && !_err) {
      // Tout est sur le téléphone
      _txt = `${_tot} morceau${_tot !== 1 ? 'x' : ''} sur le téléphone`;
    } else {
      _txt = `${_ok}/${_tot} sur le téléphone`;
      if (_wait) _txt += ` · ${_wait} en attente`;
      if (_err) _txt += ` · <span class="sync-err-toggle" onclick="toggleSyncErrorsOnly(true)" style="cursor:pointer;text-decoration:underline;color:var(--acc)">${_err} erreur${_err !== 1 ? 's' : ''}</span>`;
    }
    if (_errOnly) {
      _txt += ` · <span class="sync-err-toggle" onclick="toggleSyncErrorsOnly(false)" style="cursor:pointer;text-decoration:underline">↩ tout afficher</span>`;
    }
    ctEl.innerHTML = _spin + _txt;
  }

  // Chargement : forcé à la 1re ouverture (window._syncViewLoading), ou tant que
  // le 1er snapshot Firestore n'a pas répondu — au lieu d'un faux « Aucun
  // morceau » le temps que le miroir arrive (asynchrone).
  if ((window._syncViewLoading || (!window._syncMirrorReady && allInSync.length === 0)) && window.WT?.user && !search) {
    el.innerHTML = `
      <div class="sync-loading" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:48px 16px;color:var(--muted,#AEACA6);">
        <svg width="34" height="34" viewBox="0 0 50 50" aria-label="Chargement">
          <circle cx="25" cy="25" r="20" fill="none" stroke="rgba(200,90,69,0.25)" stroke-width="5"/>
          <circle cx="25" cy="25" r="20" fill="none" stroke="var(--acc)" stroke-width="5" stroke-linecap="round" stroke-dasharray="80 200">
            <animateTransform attributeName="transform" type="rotate" from="0 25 25" to="360 25 25" dur="0.9s" repeatCount="indefinite"/>
          </circle>
        </svg>
        <div style="font-size:12px;">Chargement de la file de synchronisation…</div>
      </div>`;
    return;
  }

  // Filtre erreurs actif mais plus aucune erreur
  if (_errOnly && allInSync.length === 0) {
    el.innerHTML = `<div class="sync-empty-search">Aucune erreur de transfert · <span class="sync-err-toggle" onclick="toggleSyncErrorsOnly(false)" style="cursor:pointer;text-decoration:underline">tout afficher</span></div>`;
    return;
  }

  // Cas vide global (rien de sync'é) : drop-zone dans Tous uniquement, message dans les autres
  if (allInSync.length === 0 && !search) {
    if (_syncTab === 'tous') {
      el.innerHTML = `
        <div class="drop-zone" id="dropZone"
             ondragover="onDragOver(event)" ondragleave="onDragLeave(event)" ondrop="onDrop(event)">
          <div class="dz-icon">⊕</div>
          <div class="dz-h">File de synchronisation</div>
          <div class="dz-sub">Glisse des morceaux, playlists, artistes ou albums<br>depuis la bibliothèque</div>
        </div>`;
    } else {
      el.innerHTML = `<div class="sync-empty-search">Aucun morceau synchronisé</div>`;
    }
    return;
  }

  // Cas vide recherche : aucun résultat
  if (sel.length === 0 && search) {
    el.innerHTML = `<div class="sync-empty-search">Aucun résultat pour "${escapeHtml(search)}"</div>`;
    return;
  }

  // Routage par onglet : injecte le HTML dans le pane
    switch (_syncTab) {
    case 'tous':
      renderSyncTabAll(el, sel, search);
      break;
    case 'playlists':
      renderSyncTabPlaylists(el, sel, filtered, search);
      break;
    case 'artistes':
      renderSyncTabArtistes(el, allInSync, search);
      break;
    case 'albums':
      renderSyncTabAlbums(el, allInSync, search);
      break;
    case 'genres':
      renderSyncTabGenres(el, allInSync, search);
      break;
    case 'annees':
      renderSyncTabAnnees(el, allInSync, search);
      break;
    default:
      el.innerHTML = `<div class="sync-empty-search">Onglet inconnu</div>`;
  }

  // Les listeners sont attachés APRÈS le rendu, sinon les boutons n'existent pas encore.
  _attachSyncListeners(el);


}

function renderSyncTabGenres(el, allInSync, search) {
  const matchesSearch = (t) => {
    if (!search) return true;
    return (t.title || '').toLowerCase().includes(search)
        || (t.artist || '').toLowerCase().includes(search)
        || (t.album || '').toLowerCase().includes(search)
        || (t.genre || '').toLowerCase().includes(search);
  };
  const filtered = allInSync.filter(matchesSearch);
  if (filtered.length === 0) {
    el.innerHTML = `<div class="sync-empty-search">Aucun résultat pour "${escapeHtml(search)}"</div>`;
    return;
  }

  const genreMap = new Map();
  for (const t of filtered) {
    const genre = t.genre || 'Non classé';
    if (!genreMap.has(genre)) genreMap.set(genre, []);
    genreMap.get(genre).push(t);
  }

  const sortedGenres = Array.from(genreMap.keys()).sort((a,b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
  let html = '';
  for (const genre of sortedGenres) {
    const tracks = genreMap.get(genre);
    html += `
  <details class="sync-pl-group">
    <summary class="sync-pl-summary" data-wt-ps-parent>
        <span class="sync-pl-icon"></span>
        <span class="sync-pl-name sync-pl-name--genre">${escapeHtml(genre)}</span>
        <span class="sync-pl-count">${tracks.length}</span>
        ${_splitButtonHTML('genre:' + genre)}
        <button class="sync-group-x" data-group-type="genre" data-group-value="${escapeHtmlAttr(genre)}" title="Retirer tous les morceaux de ce genre">×</button>
      </summary>
    <div class="sync-pl-tracks">
      ${tracks.map(t => renderSyncTrackRow(t, false)).join('')}
    </div>
  </details>`;
  }
  el.innerHTML = html;
}

function renderSyncTabAnnees(el, allInSync, search) {
  const matchesSearch = (t) => {
    if (!search) return true;
    return (t.title || '').toLowerCase().includes(search)
        || (t.artist || '').toLowerCase().includes(search)
        || (t.album || '').toLowerCase().includes(search)
        || (t.year || '').toString().includes(search);
  };
  const filtered = allInSync.filter(matchesSearch);
  if (filtered.length === 0) {
    el.innerHTML = `<div class="sync-empty-search">Aucun résultat pour "${escapeHtml(search)}"</div>`;
    return;
  }

  const yearMap = new Map();
  for (const t of filtered) {
    let year = t.year ? String(t.year) : 'Année inconnue';
    if (!yearMap.has(year)) yearMap.set(year, []);
    yearMap.get(year).push(t);
  }

  const sortedYears = Array.from(yearMap.keys()).sort((a, b) => {
    if (a === 'Année inconnue') return 1;
    if (b === 'Année inconnue') return -1;
    return parseInt(b) - parseInt(a);
  });

  let html = '';
  for (const year of sortedYears) {
    const tracks = yearMap.get(year);
    html += `
      <details class="sync-pl-group">
        <summary class="sync-pl-summary" data-wt-ps-parent>
            <span class="sync-pl-icon"></span>
            <span class="sync-pl-name sync-pl-name--year">${escapeHtml(year)}</span>
            <span class="sync-pl-count">${tracks.length}</span>
            ${_splitButtonHTML('year:' + year)}
            <button class="sync-group-x" data-group-type="year" data-group-value="${escapeHtmlAttr(year)}" title="Retirer tous les morceaux de cette année">×</button>
          </summary>
        <div class="sync-pl-tracks">
          ${tracks.map(t => renderSyncTrackRow(t, false)).join('')}
        </div>
      </details>`;
  }
  el.innerHTML = html;
}

let _syncAlbumsStack = []; // pile pour revenir en arrière

function renderSyncAlbumTracks(el, tracks, albumKey) {
  if (!tracks.length) {
    el.innerHTML = `<div class="sync-empty-search">Aucun morceau dans cet album</div>`;
    return;
  }
  const [artistNorm, albumNorm] = albumKey.split('||');
  // Récupérer les valeurs d'affichage depuis le premier morceau
  const displayArtist = tracks[0].artist || 'Artiste inconnu';
  const displayAlbum = tracks[0].album || 'Album inconnu';
  const backButton = `<button class="sync-album-back" id="syncAlbumBackBtn">← Retour aux albums</button>`;
  // On ajoute une croix de groupe au niveau du header album (cohérent avec
  // la grille où chaque carte a sa croix). Le data-group-value reconstruit
  // la clé "artistNorm||albumNorm" attendue par removeGroupFromSync.
  const title = `
    <div class="sync-album-header" data-wt-ps-parent>
      <strong>${escapeHtml(_displayAlbum(displayAlbum))}</strong> – ${escapeHtml(displayArtist)}
      ${_splitButtonHTML('album:' + albumKey)}
      <button class="sync-group-x" data-group-type="album" data-group-value="${escapeHtmlAttr(albumKey)}" title="Retirer tout l'album du Sync">×</button>
    </div>`;
  const list = tracks.map(t => renderSyncTrackRow(t, false)).join('');
  el.innerHTML = backButton + title + '<div class="sync-pl-tracks">' + list + '</div>';

  const backBtn = document.getElementById('syncAlbumBackBtn');
  if (backBtn) {
    backBtn.onclick = () => {
      if (_syncAlbumsStack.length > 0) _syncAlbumsStack.pop();
      const allInSync = allTracks.filter(t => syncSel.has(t.path));
      const search = document.getElementById('syncSearch')?.value || '';
      renderSyncTabAlbums(document.getElementById('syncTab-albums'), allInSync, search);
    };
  }

  // Attache les listeners pour les croix × individuelles (.sync-tr-x) sur
  // chaque morceau, ET la croix de groupe du header (.sync-group-x).
  // Sans ça, les croix sont inertes dans la vue détail.
  _attachSyncListeners(el);
}


function renderSyncTabAlbums(el, allInSync, search) {
  const normalize = s => (s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Vue détail d’un album (pile non vide)
  if (_syncAlbumsStack.length > 0) {
    const albumKey = _syncAlbumsStack[_syncAlbumsStack.length - 1];
    const [artistNorm, albumNorm] = albumKey.split('||');
    const tracks = allInSync.filter(t => {
      const tArtistNorm = normalize(t.artist);
      const tAlbumNorm = normalize(t.album);
      return tAlbumNorm === albumNorm && (artistNorm === '' || tArtistNorm === artistNorm);
    });
    console.log(`[Albums] Détail: ${albumKey} -> ${tracks.length} morceaux`);

    // Si l'album est devenu vide (tous les morceaux retirés du Sync),
    // on dépile et on retombe sur la vue grille. C'est moins frustrant que
    // d'afficher "Aucun morceau dans cet album" sans issue.
    if (tracks.length === 0) {
      _syncAlbumsStack.pop();
      // Re-rentre dans la fonction qui va maintenant rendre la grille
      // (ou afficher l'état vide global si plus rien n'est sync'é).
      return renderSyncTabAlbums(el, allInSync, search);
    }

    renderSyncAlbumTracks(el, tracks, albumKey);
    return;
  }

  // Vue grille : construction de la map avec clé normalisée
  const matchesSearch = (t) => {
    if (!search) return true;
    return (t.title || '').toLowerCase().includes(search)
        || (t.artist || '').toLowerCase().includes(search)
        || (t.album || '').toLowerCase().includes(search);
  };
  const filtered = allInSync.filter(matchesSearch);
  const albumMap = new Map(); // clé normalisée -> { artistRaw, albumRaw, tracks, cover }

  for (const t of filtered) {
    const artistRaw = t.artist || '';          // on garde la chaîne vide si pas d'artiste
    const albumRaw = t.album || 'Album inconnu';
    const artistNorm = normalize(artistRaw);
    const albumNorm = normalize(albumRaw);
    const key = `${artistNorm}||${albumNorm}`;
    if (!albumMap.has(key)) {
      // Pour l'affichage, on remplace l'artiste vide par "Artiste inconnu"
      const displayArtist = artistRaw === '' ? 'Artiste inconnu' : artistRaw;
      albumMap.set(key, { artist: displayArtist, album: albumRaw, tracks: [], cover: null, artistNorm, albumNorm });
    }
    albumMap.get(key).tracks.push(t);
  }

  const albums = Array.from(albumMap.values()).sort((a, b) => {
    const aStr = `${a.artist} - ${a.album}`;
    const bStr = `${b.artist} - ${b.album}`;
    return aStr.localeCompare(bStr, 'fr', { sensitivity: 'base' });
  });

  if (albums.length === 0) {
    el.innerHTML = `<div class="sync-empty-search">Aucun résultat pour "${escapeHtml(search)}"</div>`;
    return;
  }

  let html = '<div class="sync-album-grid">';
  for (const alb of albums) {
    const coverUrl = alb.cover || '';
    const coverStyle = coverUrl ? `background-image: url("${coverUrl.replace(/"/g, '&quot;')}");` : 'background-color: var(--bg3);';
    const key = `${alb.artistNorm}||${alb.albumNorm}`;
    html += `
  <div class="sync-album-card" data-key="${escapeHtmlAttr(key)}" data-wt-ps-parent>
    <div class="sync-album-cover" style="${coverStyle}">
      ${!coverUrl ? '<span class="sync-album-placeholder">♪</span>' : ''}
    </div>
    <div class="sync-album-title">${escapeHtml(_displayAlbum(alb.album))}</div>
    <div class="sync-album-artist">${escapeHtml(alb.artist)}</div>
    <div class="sync-album-count">${alb.tracks.length} morceau${alb.tracks.length !== 1 ? 'x' : ''}</div>
    ${_splitButtonHTML('album:' + key)}
    <button class="sync-group-x" data-group-type="album" data-group-value="${escapeHtmlAttr(key)}" title="Retirer tout l’album du Sync">×</button>
  </div>`;
  }
  html += '</div>';
  el.innerHTML = html;

  // Chargement asynchrone des covers
  for (const card of el.querySelectorAll('.sync-album-card')) {
    const key = card.dataset.key;
    const alb = albums.find(a => `${a.artistNorm}||${a.albumNorm}` === key);
    if (!alb || alb.cover) continue;
    const coverDiv = card.querySelector('.sync-album-cover');
    const sampleTrack = alb.tracks[0];
    if (sampleTrack && typeof resolveCoverForTrack === 'function') {
      resolveCoverForTrack(sampleTrack)
        .then(coverUrl => {
          if (coverUrl && coverDiv) {
            alb.cover = coverUrl;
            coverDiv.style.backgroundImage = `url("${coverUrl.replace(/"/g, '&quot;')}")`;
            coverDiv.style.backgroundSize = 'cover';
            coverDiv.style.backgroundPosition = 'center';
            const placeholder = coverDiv.querySelector('.sync-album-placeholder');
            if (placeholder) placeholder.remove();
          }
        })
        .catch(err => console.warn('[cover load]', err));
    }
  }

  // Attacher les événements de clic
  el.querySelectorAll('.sync-album-card').forEach(card => {
   card.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = card.dataset.key;
      if (key) {
        console.log('[Albums] Clic sur album, push key:', key);
        _syncAlbumsStack.push(key);
        renderSyncTabAlbums(el, allInSync, search);
      }
    });
  });

  // Attache les listeners de croix × sur les cartes album (croix sur card hover)
  _attachSyncListeners(el);
}



// Fonction globale pour revenir en arrière
window._syncAlbumsBack = function() {
  _syncAlbumsStack.pop();
  // Déclencher un re-rendu de l'onglet albums
  const el = document.getElementById(`syncTab-albums`);
  const allInSync = allTracks.filter(t => syncSel.has(t.path));
  const search = document.getElementById('syncSearch')?.value || '';
  renderSyncTabAlbums(el, allInSync, search);
};



// Helper local pour échapper le HTML dans la recherche (évite XSS si l'user tape <script>)
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

// Rendu de la vue "Playlists" : un accordéon par playlist synced
function renderSyncTabPlaylists(el, sel, filtered, search) {
  const syncedPlaylists = allLists.filter(pl => pl?._sync === true && pl?.tracks?.length > 0);
  let html = '';
  for (const pl of syncedPlaylists) {
    const plTracks = pl.tracks.filter(t => {
      if (!syncSel.has(t.path)) return false;
      if (!search) return true;
      return (t.title || '').toLowerCase().includes(search)
          || (t.artist || '').toLowerCase().includes(search)
          || (t.album || '').toLowerCase().includes(search);
    });
    if (plTracks.length === 0) continue;
    html += `
      <details class="sync-pl-group">
        <summary class="sync-pl-summary" data-wt-ps-parent>
          <span class="sync-pl-icon"></span>
          <span class="sync-pl-name">${escapeHtml(pl.name)}</span>
          <span class="sync-pl-count">${plTracks.length}</span>
          ${_splitButtonHTML('playlist:' + (pl._syncFirestoreId || pl.name))}
          <button class="sync-group-x" data-group-type="playlist" data-group-value="${escapeHtmlAttr(pl._syncFirestoreId || pl.name)}" title="Retirer toute la playlist du Sync">×</button>
        </summary>
        <div class="sync-pl-tracks">
          ${plTracks.map(t => renderSyncTrackRow(t, false)).join('')}
        </div>
      </details>`;
  }
  if (!html) html = `<div class="sync-empty-search">Aucun résultat pour "${escapeHtml(search)}"</div>`;
  el.innerHTML = html;
}

// ============================================================
// RENDER SYNC TAB ARTISTES (accordéon)
// ============================================================
function renderSyncTabArtistes(el, allInSync, search) {
  const matchesSearch = (t) => {
    if (!search) return true;
    return (t.title || '').toLowerCase().includes(search)
        || (t.artist || '').toLowerCase().includes(search)
        || (t.album || '').toLowerCase().includes(search);
  };
  const filtered = allInSync.filter(matchesSearch);

  if (filtered.length === 0) {
    el.innerHTML = `<div class="sync-empty-search">Aucun résultat pour "${escapeHtml(search)}"</div>`;
    return;
  }

  const artistMap = new Map();
  for (const t of filtered) {
    const artist = t.artist || 'Artiste inconnu';
    if (!artistMap.has(artist)) artistMap.set(artist, []);
    artistMap.get(artist).push(t);
  }

  const sortedArtists = Array.from(artistMap.keys()).sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));

  let html = '';
  for (const artist of sortedArtists) {
    const tracks = artistMap.get(artist);
    html += `
      <details class="sync-pl-group">
        <summary class="sync-pl-summary" data-wt-ps-parent>
          <span class="sync-pl-icon"></span>
          <span class="sync-pl-name sync-pl-name--artist">${escapeHtml(artist)}</span>
          <span class="sync-pl-count">${tracks.length}</span>
          ${_splitButtonHTML('artist:' + artist)}
          <button class="sync-group-x" data-group-type="artist" data-group-value="${escapeHtmlAttr(artist)}" title="Retirer tous les morceaux de cet artiste">×</button>
        </summary>
        <div class="sync-pl-tracks">
          ${tracks.map(t => renderSyncTrackRow(t, false)).join('')}
        </div>
      </details>`;
  }
  el.innerHTML = html;
}

// Rendu de la vue "Tous" : liste plate avec provenance
function renderSyncTabAll(el, sel, search) {
  if (sel.length === 0) {
    el.innerHTML = `<div class="sync-empty-search">Aucun résultat pour "${escapeHtml(search)}"</div>`;
    return;
  }

  el.innerHTML = sel.map(t => renderSyncTrackRow(t, true)).join('');
}

// Rendu d'une ligne morceau dans le panneau Sync
function renderSyncTrackRow(t, withProvenance) {
  // Cover : cover locale (customCovers) → _art → cover poussée au mobile (_syncCover).
  // Avant, on n'affichait que t._art → les morceaux résolus depuis la
  // bibliothèque (cover dans customCovers) restaient sans pochette.
  const cover = (t.path && typeof customCovers !== 'undefined' && customCovers[t.path])
    || t._art || t._syncCover || '';
  const coverHtml = cover
    ? `<img src="${cover}" class="sync-tr-cover" />`
    : ``;

  let provenance = '';
  if (withProvenance) {
    // Identifie dans quelles playlists synced ce morceau apparaît
    const inPlaylists = allLists
      .filter(pl => pl?._sync && pl?.tracks?.some(x => x.path === t.path))
      .map(pl => pl.name);

    // On n'affiche la provenance QUE si elle est informative (appartenance à une
    // ou plusieurs playlists synchronisées). « Ajouté manuellement » sur chaque
    // ligne n'apportait rien (c'est le cas par défaut) → on le retire.
    if (inPlaylists.length === 1) {
      provenance = `<div class="sync-tr-prov">Dans ${escapeHtml(inPlaylists[0])}</div>`;
    } else if (inPlaylists.length > 1) {
      provenance = `<div class="sync-tr-prov">Dans ${inPlaylists.map(escapeHtml).join(', ')}</div>`;
    }
  }

  return `
   <div class="sync-tr-row" data-wt-ps-parent${!t._missingLocal && t.path ? ` data-syncctxpath="${escapeHtmlAttr(t.path)}"` : ''}>
      ${coverHtml}
      <div class="sync-tr-info">
        <div class="sync-tr-title">${escapeHtml(t.title || '')}</div>
       <div class="sync-tr-meta">
          <span class="sync-tr-artist">${escapeHtml(t.artist || '')}</span>
          <span class="sync-tr-album">${escapeHtml(_displayAlbum(t.album))}</span>
        </div>
        ${provenance}
        ${t._syncStatus === 'error'
          ? `<div class="sync-tr-error" title="${escapeHtmlAttr(t._syncError || '')}" style="font-size:10px; color:var(--acc); margin-top:3px; line-height:1.3;">⚠ ${escapeHtml(_syncErrorHint(t._syncError))}</div>`
          : ''}
      </div>
      <div class="sync-tr-actions">
        ${_splitButtonHTML('track:' + t.path, { sm: true })}
        ${!t._missingLocal && t.path
          ? `<button class="sync-tr-more" data-syncctxpath="${escapeHtmlAttr(t.path)}" title="Plus d'options" style="background:none;border:none;color:var(--t3);cursor:pointer;padding:0 4px;display:inline-flex;align-items:center;"><svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><circle cx="7" cy="3" r="1.15"/><circle cx="7" cy="7" r="1.15"/><circle cx="7" cy="11" r="1.15"/></svg></button>`
          : ''}
        ${t._syncStatus === 'error'
          ? `<button class="sync-tr-retry" data-syncdoc="${escapeHtmlAttr(t._syncDocId || '')}" title="${escapeHtmlAttr(t._syncError || 'Erreur de transfert')} — cliquer pour re-résoudre le chemin et réessayer"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round" style="vertical-align:middle" aria-hidden="true"><path d="M7 1.9 L12.6 11.6 L1.4 11.6 Z"/><path d="M7 5.4 V8"/><circle cx="7" cy="9.9" r="0.55" fill="currentColor" stroke="none"/></svg></button>`
          : `<span class="sync-tr-badge" title="${t._syncStatus === 'received' ? 'Transféré' : 'En attente de transfert'}">${t._syncStatus === 'received'
              ? `<svg width="14" height="14" viewBox="0 0 14 14" style="vertical-align:middle" aria-hidden="true"><circle cx="7" cy="7" r="3.1" fill="#5E9C76"/></svg>`
              : `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" style="vertical-align:middle" aria-hidden="true"><g><circle cx="7" cy="7" r="5"/><path d="M7 4.2 V7 L9.1 8.2" stroke-linecap="round" stroke-linejoin="round"/><animate attributeName="opacity" values="0.35;1;0.35" dur="1.6s" repeatCount="indefinite"/></g></svg>`}</span>`}
        <button class="sync-tr-x" ${t._missingLocal ? `data-syncdoc="${escapeHtmlAttr(t._syncDocId)}"` : `data-path="${escapeHtmlAttr(t.path)}"`} title="Retirer du sync"><svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" style="vertical-align:middle" aria-hidden="true"><path d="M3.5 3.5 L10.5 10.5 M10.5 3.5 L3.5 10.5"/></svg></button>
      </div>
    </div>`;
}

// Helpers d'échappement HTML (peuvent déjà exister, on les ajoute si pas le cas)
if (typeof escapeHtml === 'undefined') {
  window.escapeHtml = function(s) {
    return (s || '').replace(/[&<>"']/g, c => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
    })[c]);
  };
}
if (typeof escapeHtmlAttr === 'undefined') {
  window.escapeHtmlAttr = function(s) {
    return (s || '').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
  };
}

function updateSyncStats(sel){
  const n=sel.length;
  const bytes=sel.reduce((s,t)=>s+t.size,0);
  const sz=bytes>1073741824?(bytes/1073741824).toFixed(1)+' GB':bytes>1048576?(bytes/1048576).toFixed(1)+' MB':(bytes/1024).toFixed(0)+' KB';
  document.getElementById('syncCt').textContent=`${n} morceau${n!==1?'x':''} sélectionné${n!==1?'s':''}`;
  document.getElementById('spStatN').textContent=n.toLocaleString();
  document.getElementById('spStatSz').textContent=n?sz:'–';
  document.getElementById('spGo').disabled=n===0;
  // Funnel commun de tout changement de syncSel → le bouton tél. du player
  // (et celui du fullscreen) reflètent le morceau en cours, d'où qu'il vienne.
  if(typeof updatePlayingSyncUI==='function') updatePlayingSyncUI();
  if(typeof _fsActive!=='undefined' && _fsActive && typeof _fsRefreshCtrls==='function') _fsRefreshCtrls();
}

function addToSync(t){
  syncSel.add(t.path);
  // Patch I : ajoute le lien manual au doc Firestore (création si nouveau)
  _syncLinkAdd(t, { manual: true });
  // Patch D : indexe automatiquement dans le serveur HTTP local
  _ensureHttpServed();
  if(document.getElementById('syncView').classList.contains('on'))renderSyncQueue();
}

// Patch D : indexe TOUS les morceaux de syncSel dans le serveur HTTP local.
// À appeler après chaque modif de syncSel pour que les morceaux ajoutés
// soient immédiatement téléchargeables par le mobile sans clic Synchroniser.
// Comportement "set" : envoie la totalité de syncSel à chaque fois (le main.js
// remplace la liste interne _syncTracks).
//
// Debounce 800ms : si plusieurs morceaux sont ajoutés d'affilée (drag-drop
// multi-tracks, ou sync d'une playlist entière), on ne refait l'index qu'une
// fois à la fin de la séquence.
let _httpServeTimer = null;
function _ensureHttpServed(){
  if(!window.wt?.syncSetTracks) return;
  if(_httpServeTimer) clearTimeout(_httpServeTimer);
  _httpServeTimer = setTimeout(async () => {
    _httpServeTimer = null;
    try {
      const byPath = new Map(allTracks.map(t => [t.path, t]));
      // Map (id|path) → entrée serveur, pour dédoublonner syncSel ∪ miroir.
      const served = new Map();
      const _add = (key, entry) => { if (key && !served.has(key)) served.set(key, entry); };

      // 1. syncSel : la sélection desktop. Re-résout les chemins dérivés.
      for (const p of Array.from(syncSel)) {
        let t = byPath.get(p);
        if (!t) {
          const r = _resolveTrackInLibrary({ path: p });
          if (r) {
            t = r;
            if (r.path && r.path !== p) {
              syncSel.add(r.path);
              if (window._pushedTrackPaths) {
                const tid = window._pushedTrackPaths.get(p);
                if (tid) window._pushedTrackPaths.set(r.path, tid);
              }
              console.log(`[ensureHttpServed] re-résolu "${(p.split('/').pop()||'')}" → ${r.path}`);
            }
          }
        }
        if (t) {
          const id = _trackIdFor(t);
          _add(id || ('p:' + t.path), { id: id || null, title: _syncTitle(t), artist: t.artist || '', album: t.album || '', year: t.year || null, path: t.path });
        } else {
          // non résolu → servi par chemin brut (URL md5 legacy)
          _add('p:' + p, { id: null, title: _syncTitle({ path: p }), artist: '', album: '', year: null, path: p });
        }
      }

      // 2. miroir Firestore : TOUT doc que le mobile connaît doit être servable
      // par son trackId (= id du doc), re-résolu vers le chemin COURANT. Corrige
      // les 404 quand un doc n'est pas (ou plus) dans syncSel après redémarrage.
      if (window._syncMirror) {
        for (const m of window._syncMirror.values()) {
          if (served.has(m.id)) continue;
          const r = _resolveTrackInLibrary({ id: m.id, artist: m.artist, album: m.album, title: m.title, filename: m.filename });
          if (r && r.path) {
            _add(m.id, { id: m.id, title: _syncTitle(r), artist: r.artist || '', album: r.album || '', year: r.year || null, path: r.path });
          }
        }
      }

      // 3. Carte annexe : fichiers retrouvés sur le disque par le retry (hors
      // allTracks). Servis sous leur docId pour que /f/<docId> résolve.
      if (window._syncExtraServe) {
        for (const [docId, info] of window._syncExtraServe) {
          if (!info || !info.path || served.has(docId)) continue;
          _add(docId, { id: docId, title: _syncTitle(info), artist: info.artist || '', album: info.album || '', year: info.year || null, path: info.path });
        }
      }

      const payload = Array.from(served.values());
      console.log(`[ensureHttpServed] syncSel=${syncSel.size}, miroir=${window._syncMirror ? window._syncMirror.size : 0}, servis=${payload.length}`);
      const n = await window.wt.syncSetTracks(payload);
      console.log(`[ensureHttpServed] indexé ${n} morceau(x) dans le serveur HTTP local`);
    } catch(e){
      console.warn('[ensureHttpServed] failed:', e);
    }
  }, 800);
}

// ── Patch D : helper pour pousser une playlist desktop vers Firestore ────
// Convertit la playlist desktop (objet {name, tracks: [{path, title, artist, ...}]})
// en format Firestore (trackIds = ['artist__title', ...]) et l'écrit dans
// syncPlaylists. Le mobile la verra automatiquement via son listener.
//
// L'ID Firestore de la playlist est dérivé de son nom (slugifié) pour rester
// stable entre desktop et mobile, et lisible dans la console Firebase.
async function _syncPushPlaylistToFirestore(pl) {
  if (!pl || !pl.name) return;
  if (!window.WT?.firebase || !window.WT?.user) return;

  // Patch N+1 : la smart playlist Favoris n'est PAS matérialisée dans Firestore.
  // Source de vérité unique = track.isFavorite (sur chaque doc syncQueue/<id>).
  // Mobile et desktop calculent leur vue Favoris localement à partir de ce flag.
  // Push interdit pour éviter la divergence (la playlist trackIds Firestore
  // serait toujours en retard sur les toggles individuels).
  if (pl.system === true && pl.name === 'Favoris') {
    console.log('[syncPushPlaylist] skip Favoris (smart, propagée via track.isFavorite)');
    return;
  }

  const slugify = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0, 60);

  // Patch : si la playlist a déjà été sync'ée, on garde son ID Firestore stable
  // (= immuable au rename). Sinon, on calcule depuis le nom actuel (premier push).
  // Sans ça, renommer une playlist sync'ée créait un fantôme Firestore avec l'ancien nom.
  const playlistId = pl._syncFirestoreId || `pl_${slugify(pl.name)}`;
  if (!playlistId || playlistId === 'pl_') return;

  // Convertit les tracks (objets) en trackIds (slugs)
  const trackIds = (pl.tracks || [])
    .map(t => _trackIdFor(t))
    .filter(id => id && id !== '__');

  const { db, doc, setDoc, Timestamp } = window.WT.firebase;
  const uid = window.WT.user.uid;

  try {
    // 1. Push la playlist Firestore (doc syncPlaylists)
    await setDoc(
      doc(db, 'users', uid, 'syncPlaylists', playlistId),
      {
        name: pl.name,
        trackIds,
        kind: 'user',
        createdAt: Timestamp.now(),
        updatedBy: 'desktop',
        updatedAt: Timestamp.now(),
      },
      { merge: true }
    );
    pl._sync = true;
    pl._syncFirestoreId = playlistId;

    // 2. Patch I : pour chaque morceau de la playlist, ajoute le lien
    // linkedTo.playlists[] avec cet ID. Crée le doc syncQueue si besoin.
    for (const t of (pl.tracks || [])) {
      if (!t || !t.path) continue;
      await _syncLinkAdd(t, { playlist: playlistId });
    }

    console.log(`[syncPushPlaylist] pushed "${pl.name}" (${trackIds.length} morceaux) → ${playlistId}`);

    // Patch D : ajoute les morceaux de la playlist à syncSel et indexe dans le serveur HTTP local
    // Sans ça, le mobile reçoit l'URL des morceaux mais le serveur HTTP renvoie 404.
    (pl.tracks || []).forEach(t => { if(t?.path) syncSel.add(t.path); });
    _ensureHttpServed();
    if(typeof renderSyncQueue === 'function') renderSyncQueue();
  } catch (e) {
    console.warn('[syncPushPlaylist] failed for', pl.name, ':', e);
  }
}

// ── Patch H : helpers de gestion des liens linkedTo ──────────────────
// Le doc syncQueue Firestore a un champ linkedTo = { manual: bool, playlists: [...] }
// qui dit pourquoi ce morceau est sur le mobile.
//
//   - linkedTo.manual = true : l'user a ajouté ce morceau à la main
//   - linkedTo.playlists = ["pl_workout"] : ce morceau est dans Workout (synced)
//
// Un morceau est dans le Sync si et seulement si manual === true OU playlists.length > 0.
// Quand les deux deviennent vides, on supprime le doc Firestore (= le morceau sort du Sync).

// Hash sync stable d'un chemin (djb2). Composant d'id unique quand le titre est
// vide : sinon tous les morceaux sans titre d'un même artiste donnent le slug
// artist__'' et écrasent le même doc Firestore (collision = 1 seul synchronisé).
function _wtPathHash(p){ let h=5381; const z=String(p||''); for(let i=0;i<z.length;i++){ h=((h<<5)+h+z.charCodeAt(i))>>>0; } return ('0000000'+h.toString(16)).slice(-8); }

// Titre d'affichage pour la sync : repli sur le nom de fichier (sans extension)
// quand le tag titre est vide. N'altère PAS allTracks (display/sync uniquement).
function _syncTitle(t){ const tt=((t&&t.title)||'').trim(); if(tt) return tt; const b=(((t&&t.path)||'').split('/').pop()||''); return b.replace(/\.[^/.]+$/,'') || '(sans titre)'; }

const _slugifyTrackForLink = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0, 60);

function _trackIdFor(t) {
  const a = _slugifyTrackForLink(t && t.artist);
  let ti = _slugifyTrackForLink(t && t.title);
  if (!ti) ti = 'h' + _wtPathHash(t && t.path);  // titre vide -> suffixe stable du chemin (anti-collision)
  return `${a}__${ti}`;
}

// Re-résout un morceau « dérivé » (chemin absent d'allTracks → 404) vers son
// objet bibliothèque COURANT. Racine des erreurs de transfert résiduelles et du
// bug smart-playlist (« dans allTracks=0 »). Cascade :
//   1. chemin exact
//   2. trackId stable (slug artiste+titre) — survit au déplacement de fichier
//   3. artiste + album + nom de fichier
//   4. nom de fichier seul (dernier recours)
// meta peut être : un objet track, un doc miroir {id,artist,album,title,filename},
// ou un simple {path}. Renvoie l'objet allTracks courant (chemin à jour) ou null.
function _resolveTrackInLibrary(meta) {
  if (!meta || typeof allTracks === 'undefined' || !Array.isArray(allTracks)) return null;
  // 1. chemin exact
  if (meta.path) {
    const exact = allTracks.find(t => t.path === meta.path);
    if (exact) return exact;
  }
  // 2. trackId (slug artiste+titre)
  const wantId = meta.id || ((meta.artist || meta.title) ? _trackIdFor(meta) : null);
  if (wantId && wantId !== '__') {
    const byId = allTracks.find(t => _trackIdFor(t) === wantId);
    if (byId) return byId;
  }
  // 3. artiste + album + nom de fichier
  const fname = (meta.filename || (meta.path || '').split('/').pop() || '').toLowerCase();
  if (fname) {
    const aKey = _slugifyTrackForLink(meta.artist);
    const alKey = _slugifyTrackForLink(meta.album);
    const byFile = allTracks.find(t => {
      const tf = ((t.path || '').split('/').pop() || '').toLowerCase();
      return tf === fname
        && _slugifyTrackForLink(t.artist) === aKey
        && _slugifyTrackForLink(t.album) === alKey;
    });
    if (byFile) return byFile;
    // 4. nom de fichier seul (album/tag a pu changer)
    const byFileOnly = allTracks.find(t => ((t.path || '').split('/').pop() || '').toLowerCase() === fname);
    if (byFileOnly) return byFileOnly;
  }
  return null;
}

// Lit le doc Firestore, ajoute le lien (manual ou playlist), réécrit.
// Crée le doc s'il n'existe pas encore (premier ajout).
async function _syncLinkAdd(t, link) {
  if (!t || !window.WT?.firebase || !window.WT?.user) return;
  const trackId = _trackIdFor(t);
  if (!trackId || trackId === '__') return;

  const { db, doc, getDoc, setDoc, Timestamp } = window.WT.firebase;
  const uid = window.WT.user.uid;
  const ref = doc(db, 'users', uid, 'syncQueue', trackId);

  try {
    const snap = await getDoc(ref);
    const existing = snap.exists() ? snap.data() : null;

    // État actuel de linkedTo (peut être absent sur les docs anciens)
    const linkedTo = existing?.linkedTo || { manual: false, playlists: [] };

    if (link.manual === true) {
      linkedTo.manual = true;
    }
    if (link.playlist && !linkedTo.playlists.includes(link.playlist)) {
      linkedTo.playlists.push(link.playlist);
    }

    // Si le doc n'existait pas, on doit créer un doc complet (avec url etc.)
    if (!existing) {
      // Résolution de la pochette
      const coverUrl = (typeof resolveCoverForTrack === 'function')
        ? (await resolveCoverForTrack(t) || null)
        : null;

      // URL sur le trackId stable (= id du doc) : survit au déplacement de
      // fichier. Le serveur HTTP local résout trackId → chemin courant.
      const url = (trackId && trackId !== '__') ? `http://${myIP}:${myPort}/f/${trackId}` : null;

      await setDoc(ref, {
        title: _syncTitle(t),
        artist: t.artist || '',
        album: t.album || '',
        year: t.year || null,
        genre: t.genre || null,
        albumArtUrl: coverUrl,
        filename: (t.path || '').split('/').pop() || `${trackId}.mp3`,
        url,
        size: t.size || 0,
        status: 'pending',
        noShuffle: !!(t.path && _noShuffleSet.has(t.path)),
        addedAt: Timestamp.now(),
        linkedTo,
      });
      console.log(`[syncLinkAdd] créé doc syncQueue ${trackId} avec link`, link);
    } else {
      // Doc existant : on met juste à jour linkedTo (merge)
      await setDoc(ref, { linkedTo }, { merge: true });
      console.log(`[syncLinkAdd] ajout lien à ${trackId}:`, link, '→', linkedTo);
    }

    // Met à jour les indexes locaux
    window._pushedTrackIds = window._pushedTrackIds || new Set();
    window._pushedTrackPaths = window._pushedTrackPaths || new Map();
    window._pushedTrackIds.add(trackId);
    if (t.path) window._pushedTrackPaths.set(t.path, trackId);
  } catch (e) {
    console.warn('[syncLinkAdd] failed for', trackId, ':', e);
  }
}

// Retire un lien (manual ou playlist). Si plus aucun lien, supprime le doc.
async function _syncLinkRemove(t, link) {
  if (!t || !window.WT?.firebase || !window.WT?.user) return;
  const trackId = _trackIdFor(t);
  if (!trackId || trackId === '__') return;

  const { db, doc, getDoc, setDoc, deleteDoc } = window.WT.firebase;
  const uid = window.WT.user.uid;
  const ref = doc(db, 'users', uid, 'syncQueue', trackId);

  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) return;

    const data = snap.data();
    const linkedTo = data.linkedTo || { manual: false, playlists: [] };

    if (link.manual === true) {
      linkedTo.manual = false;
    }
    if (link.playlist) {
      linkedTo.playlists = (linkedTo.playlists || []).filter(p => p !== link.playlist);
    }

    // Si plus aucun lien, on supprime le doc (= le morceau sort du Sync)
    if (!linkedTo.manual && linkedTo.playlists.length === 0) {
      await deleteDoc(ref);
      window._pushedTrackIds?.delete(trackId);
      if (t.path) window._pushedTrackPaths?.delete(t.path);
      console.log(`[syncLinkRemove] dernier lien retiré, doc ${trackId} supprimé`);
    } else {
      await setDoc(ref, { linkedTo }, { merge: true });
      console.log(`[syncLinkRemove] retrait lien à ${trackId}:`, link, '→', linkedTo);
    }
  } catch (e) {
    console.warn('[syncLinkRemove] failed for', trackId, ':', e);
  }
}

// ── Patch N.3 : Favoris comme smart playlist dynamique (côté desktop) ─
// La playlist Favoris n'est PAS persistée dans le store local : c'est une
// vue calculée sur t.isFavorite. Marquée `system:true` pour la protéger
// du save, du rename, de la suppression, de la fusion et du drag.
//
// On l'injecte dans allLists à chaque boot (après getLibrary), puis on la
// rebuild en place à chaque toggle favori.

const FAVORITES_LIST_NAME = 'Favoris';

function _buildFavoritesSmartList() {
  const tracks = (typeof allTracks !== 'undefined')
    ? allTracks.filter(t => t && t.isFavorite === true)
    : [];

  return {
    // ID stable basé sur le nom — la smart playlist Favoris est UNIQUE, donc
    // un ID dérivé de son nom est suffisant et stable entre rebuilds.
    id: 'system:favoris',
    name: FAVORITES_LIST_NAME,
    tracks,
    count: tracks.length,
    smart: true,
    system: true,         // protège du save, du rename, etc.
    custom: false,
    merged: false,

    // Patch N+1 : Favoris n'est PAS matérialisée dans Firestore. La source de
    // vérité est track.isFavorite (sur chaque doc syncQueue/<id>). Les morceaux
    // favoris sont quand même auto-sync vers Firestore via toggleTrackFavorite
    // (qui écrit isFavorite:true sur le doc track), mais la playlist elle-même
    // n'a pas d'existence Firestore.
    _sync: false,
  };
}

// Insère la playlist Favoris en première position des customLists si elle
// n'est pas déjà présente, ou la rebuild en place si elle existe déjà.
// Renvoie l'index final de la playlist Favoris dans allLists.
function _injectOrRebuildFavoritesList() {
  if (typeof allLists === 'undefined') return -1;
  const existingIdx = allLists.findIndex(l => l && l.system === true && l.name === FAVORITES_LIST_NAME);
  const fresh = _buildFavoritesSmartList();
  if (existingIdx >= 0) {
    // Rebuild en place — on garde l'index pour ne pas perturber curPl
    allLists[existingIdx] = fresh;
    return existingIdx;
  }
  // Sinon, insère en première position (haut des customLists)
  allLists.unshift(fresh);
  return 0;
}
// ── Patch N : helpers pour gérer les favoris desktop ─────────────────
// Le favori est une propriété du track (t.isFavorite). Synchronisé via
// le doc syncQueue Firestore (champ isFavorite). Cohérent avec mobile.

async function toggleTrackFavorite(track) {
  if (!track || !track.path) return;

  // Inverse l'état local
  track.isFavorite = !track.isFavorite;

  // ✅ Sauvegarde locale (localStorage)
  _saveFavoritesToLocalStorage();

  // ✅ Force la sauvegarde des métadonnées via le système existant (trackMeta)
  if (typeof scheduleMetaSave === 'function') scheduleMetaSave();

  // ── Auto-sync au favori (philosophie Wave Tune : favoriser = vouloir sur mobile) ──
  // Si l'user vient de marquer un morceau favori ET qu'il n'a pas explicitement
  // exclu ce morceau du Sync (croix × précédente), on l'ajoute automatiquement.
  // Si l'user dé-favorise, on ne touche pas à syncSel (le morceau peut être sync
  // via une autre playlist, ou ajouté manuellement).
  if (track.isFavorite && !track._syncExcluded && typeof syncSel !== 'undefined') {
    if (!syncSel.has(track.path)) {
      syncSel.add(track.path);
      // Persiste dans Firestore via le lien "manuel" (cohérent avec le drag-drop)
      if (typeof _syncLinkAdd === 'function') {
        _syncLinkAdd(track, { manual: true });
      }
      // Recalcule les stats du Sync
      if (typeof updateSyncStats === 'function') {
        updateSyncStats([...allTracks.filter(x => syncSel.has(x.path))]);
      }
      console.log(`[toggleTrackFavorite] auto-sync ${track.title}`);
    }
  }

  // Si le morceau est sur le mobile (dans syncQueue Firestore), push la modification
  if (window.WT?.firebase && window.WT?.user && window._pushedTrackPaths) {
    const trackId = window._pushedTrackPaths.get(track.path);
    if (trackId) {
      try {
        const { db, doc, setDoc } = window.WT.firebase;
        const uid = window.WT.user.uid;
        await setDoc(
          doc(db, 'users', uid, 'syncQueue', trackId),
          { isFavorite: track.isFavorite },
          { merge: true }
        );
      } catch (e) {
        console.warn('[toggleTrackFavorite] firestore push failed:', e);
      }
    }
  }

  // Met à jour le morceau en cours de lecture si nécessaire
  if (queue[qi] && queue[qi].path === track.path) {
    queue[qi].isFavorite = track.isFavorite;
    if (typeof updatePlayingFavoriteUI === 'function') updatePlayingFavoriteUI();
    // Favoriser = auto-ajout au Sync (philosophie) → le bouton tél. doit suivre
    if (typeof updatePlayingSyncUI === 'function') updatePlayingSyncUI();
  }
  console.log(`[toggleTrackFavorite] ${track.title} → ${track.isFavorite ? '★' : '☆'}`);

  // Reconstruit la playlist Favoris si on est dessus
  if (typeof _injectOrRebuildFavoritesList === 'function') {
    const favIdx = _injectOrRebuildFavoritesList();
    if (curPl === favIdx && allLists[favIdx]) {
      filtered = [...allLists[favIdx].tracks];
      if (typeof applySortToFiltered === 'function') applySortToFiltered();
      if (typeof updateBreadcrumb === 'function') updateBreadcrumb();
    }
  }

  // Rafraîchit l’affichage
  if (typeof renderVirtual === 'function') renderVirtual();
  if (typeof renderSidebar === 'function') renderSidebar();
  if (typeof renderSyncQueue === 'function' && document.getElementById('syncView')?.classList.contains('on')) {
    renderSyncQueue();
  }
}

// ── PERSISTENCE LOCALE DES FAVORIS (fallback) ──
function _saveFavoritesToLocalStorage() {
  if (!allTracks) return;
  const favs = {};
  for (const t of allTracks) {
    if (t.isFavorite) favs[t.path] = true;
  }
  try {
    localStorage.setItem('wt_favorites', JSON.stringify(favs));
  } catch(e) {}
}

function _loadFavoritesFromLocalStorage() {
  if (!allTracks) return;
  try {
    const favs = JSON.parse(localStorage.getItem('wt_favorites') || '{}');
    for (const [path, isFav] of Object.entries(favs)) {
      const track = allTracks.find(t => t.path === path);
      if (track && isFav) track.isFavorite = true;
    }
    console.log('[loadFavorites]', Object.keys(favs).length, 'favoris restaurés depuis localStorage');
  } catch(e) {}
}

// ── Patch E : propagation continue des modifs playlists desktop ───────
// Compagnon de scheduleSave : à chaque sauvegarde, on parcourt allLists
// et pour chaque playlist marquée _sync=true, on push sa version actuelle
// vers Firestore. Le mobile reçoit le 'modified' via son listener et met
// à jour sa playlist locale.
//
// On track les hashes des playlists pour ne pousser QUE celles qui ont
// vraiment changé (évite de spammer Firestore à chaque scheduleSave).

const _syncedPlaylistHashes = new Map();  // playlistId Firestore → hash JSON

function _hashPlaylist(pl) {
  // Hash simple : nom + tracks paths concaténés. Si l'un change, hash change.
  const tracksKey = (pl.tracks || []).map(t => t.path || '').join('|');
  return `${pl.name}::${tracksKey}`;
}

function _syncPropagateAllSyncedPlaylists() {
  if (!window.WT?.firebase || !window.WT?.user) return;
  if (typeof allLists === 'undefined') return;

  const syncedPlaylists = allLists.filter(pl => pl?._sync === true);
  if (syncedPlaylists.length === 0) return;

  let pushedCount = 0;
  syncedPlaylists.forEach(pl => {
    if (!pl._syncFirestoreId) return;  // n'a jamais été push, on skip
    const hash = _hashPlaylist(pl);
    const lastHash = _syncedPlaylistHashes.get(pl._syncFirestoreId);
    if (hash === lastHash) return;  // pas de changement, skip

    _syncedPlaylistHashes.set(pl._syncFirestoreId, hash);
    _syncPushPlaylistToFirestore(pl);
    pushedCount++;
  });

  if (pushedCount > 0) {
    console.log(`[syncPropagateAllSyncedPlaylists] ${pushedCount} playlist(s) propagée(s)`);
  }
}

function _hashPlaylist(pl) {
  // Hash simple : nom + tracks paths concaténés. Si l'un change, hash change.
  const tracksKey = (pl.tracks || []).map(t => t.path || '').join('|');
  return `${pl.name}::${tracksKey}`;
}

function _syncPropagateAllSyncedPlaylists() {
  if (!window.WT?.firebase || !window.WT?.user) return;
  if (typeof allLists === 'undefined') return;

  const syncedPlaylists = allLists.filter(pl => pl?._sync === true);
  if (syncedPlaylists.length === 0) return;

  let pushedCount = 0;
  syncedPlaylists.forEach(pl => {
    if (!pl._syncFirestoreId) return;  // n'a jamais été push, on skip
    const hash = _hashPlaylist(pl);
    const lastHash = _syncedPlaylistHashes.get(pl._syncFirestoreId);
    if (hash === lastHash) return;  // pas de changement, skip

    _syncedPlaylistHashes.set(pl._syncFirestoreId, hash);
    _syncPushPlaylistToFirestore(pl);
    pushedCount++;
  });

  if (pushedCount > 0) {
    console.log(`[syncPropagateAllSyncedPlaylists] ${pushedCount} playlist(s) propagée(s)`);
  }
}

// ── Patch C : helper pour retirer un morceau du sync Firestore ────────
// Quand l'user retire un morceau du panneau Sync (par n'importe quel moyen),
// on supprime le doc Firestore correspondant. Le mobile détecte 'removed'
// via son listener et nettoie localement.
//
// Idempotent : si le morceau n'était pas dans Firestore, on ne fait rien.
// Patch J : version simplifiée. Force la suppression complète du doc et
// retire le morceau de toutes les playlists synced. Utilisé uniquement par
// "syncNone" (Vider tout). Pour les suppressions normales, on passe par
// _syncLinkRemove qui gère les liens proprement.
function _syncDeleteFromFirestore(path) {
  if (!path) return;
  if (!window.WT?.firebase || !window.WT?.user || !window._pushedTrackPaths) return;

  const trackId = window._pushedTrackPaths.get(path);
  if (!trackId) return;

  const { db, doc, deleteDoc } = window.WT.firebase;
  const uid = window.WT.user.uid;
  deleteDoc(doc(db, 'users', uid, 'syncQueue', trackId))
    .then(() => {
      window._pushedTrackIds?.delete(trackId);
      window._pushedTrackPaths?.delete(path);

      // Cascade : retire le morceau de toutes les playlists synced locales
      if (typeof allLists !== 'undefined') {
        let cascadeCount = 0;
        allLists.forEach(pl => {
          if (!pl?._sync || !pl?.tracks) return;
          const before = pl.tracks.length;
          pl.tracks = pl.tracks.filter(t => t.path !== path);
          if (pl.tracks.length !== before) {
            pl.count = pl.tracks.length;
            cascadeCount++;
          }
        });
        if (cascadeCount > 0 && typeof scheduleSave === 'function') {
          scheduleSave();
        }
      }

      console.log(`[syncDeleteFromFirestore] retiré ${trackId} (force)`);
    })
    .catch(e => console.warn('[syncDeleteFromFirestore] failed for', trackId, ':', e));
}
function _handleSyncRetry(e) {
  e.stopPropagation();
  e.preventDefault();
  const id = e.currentTarget.getAttribute('data-syncdoc');
  if (id) retrySyncTrack(id);
}

// Clic droit sur une ligne du Sync : ouvre le menu contextuel morceau standard.
function _handleSyncCtx(e) {
  const p = e.currentTarget.getAttribute('data-syncctxpath');
  if (!p) return;
  const tr = (typeof allTracks !== 'undefined') ? allTracks.find(x => x.path === p) : null;
  if (!tr || typeof showTrackCtxMenu !== 'function') return;
  e.preventDefault();
  e.stopPropagation();
  showTrackCtxMenu(e, tr, -1);
}

// Transforme le message d'erreur brut (écrit par le mobile) en raison courte et
// actionnable affichée sur la ligne. Le détail complet reste dans le tooltip.
function _syncErrorHint(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return 'Erreur de transfert · clique ⚠ pour réessayer';
  if (s.includes('404') || s.includes('introuvable') || s.includes('not found'))
    return 'Fichier introuvable sur le desktop · clique ⚠ pour re-résoudre le chemin';
  if (s.includes('re-scan') || s.includes('rescan') || s.includes('dossier musique'))
    return 'Introuvable dans la bibliothèque · re-scanne le dossier Musique';
  if (s.includes('timeout') || s.includes('timed out') || s.includes('délai') || s.includes('delai'))
    return 'Délai de transfert dépassé · clique ⚠ pour réessayer';
  if (s.includes('network') || s.includes('réseau') || s.includes('reseau') || s.includes('econn') || s.includes('refused'))
    return 'Connexion interrompue · vérifie le WiFi · clique ⚠ pour réessayer';
  if (s.includes('space') || s.includes('espace') || s.includes('enospc'))
    return 'Espace insuffisant sur le téléphone';
  return (raw.length > 90 ? raw.slice(0, 90) + '…' : raw) + ' · clique ⚠';
}

// Réessaie un transfert EN RÉPARANT d'abord : re-résout le morceau dans la
// bibliothèque (chemin courant) à partir des métadonnées du doc, réaligne
// l'URL/le service HTTP, PUIS remet en 'pending'. Sans la re-résolution, un
// simple 'pending' reboucle sur le même 404 quand le chemin a dérivé. Si le
// morceau est introuvable dans la bibliothèque, message actionnable (pas de
// boucle) invitant à re-scanner le dossier Musique.
async function retrySyncTrack(id) {
  if (!id) return;
  try {
    if (!window.WT?.firebase || !window.WT?.user) return;
    const { db, doc, setDoc } = window.WT.firebase;
    const uid = window.WT.user.uid;
    const m = (window._syncMirror && window._syncMirror.get(id)) || {};
    const r = _resolveTrackInLibrary({ id, artist: m.artist, album: m.album, title: m.title, filename: m.filename });

    if (r && r.path) {
      // Assure le service du fichier sous le trackId stable + URL alignée
      syncSel.add(r.path);
      window._pushedTrackPaths = window._pushedTrackPaths || new Map();
      window._pushedTrackPaths.set(r.path, id);
      if (typeof _ensureHttpServed === 'function') _ensureHttpServed();
      await setDoc(doc(db, 'users', uid, 'syncQueue', id), {
        url: `http://${myIP}:${myPort}/f/${id}`,
        filename: (r.path.split('/').pop()) || m.filename || `${id}.mp3`,
        status: 'pending', errorMessage: '',
      }, { merge: true });
      if (window._syncMirror && window._syncMirror.has(id)) { const mm = window._syncMirror.get(id); mm.status = 'pending'; mm.errorMessage = ''; }
      console.log('[retrySyncTrack] re-résolu + relancé:', id, '→', r.path);
    } else {
      // Pas dans allTracks → on cherche le fichier sur le disque (dossier Musique
      // scanné) : il a pu être déplacé/renommé hors de la bibliothèque chargée.
      let found = null;
      try {
        if (window.wt?.syncFindFile) {
          found = await window.wt.syncFindFile({ filename: m.filename, title: m.title, artist: m.artist, album: m.album });
        }
      } catch (e) { console.warn('[retrySyncTrack] syncFindFile a échoué:', e); }

      if (found) {
        // Sert le fichier retrouvé sous le docId (carte annexe) + réaligne le doc
        window._syncExtraServe = window._syncExtraServe || new Map();
        window._syncExtraServe.set(id, { path: found, title: m.title, artist: m.artist, album: m.album, year: m.year });
        syncSel.add(found);
        window._pushedTrackPaths = window._pushedTrackPaths || new Map();
        window._pushedTrackPaths.set(found, id);
        if (typeof _ensureHttpServed === 'function') _ensureHttpServed();
        await setDoc(doc(db, 'users', uid, 'syncQueue', id), {
          url: `http://${myIP}:${myPort}/f/${id}`,
          filename: (found.split('/').pop()) || m.filename || `${id}.mp3`,
          status: 'pending', errorMessage: '',
        }, { merge: true });
        if (window._syncMirror && window._syncMirror.has(id)) { const mm = window._syncMirror.get(id); mm.status = 'pending'; mm.errorMessage = ''; }
        console.log('[retrySyncTrack] retrouvé sur le disque + relancé:', id, '→', found);
        if (typeof toast === 'function') toast('Fichier retrouvé sur le disque — transfert relancé.');
      } else {
        const _msg = 'Introuvable dans la bibliothèque ET sur le disque (dossier Musique) — fichier supprimé ?';
        await setDoc(doc(db, 'users', uid, 'syncQueue', id), { status: 'error', errorMessage: _msg }, { merge: true });
        if (window._syncMirror && window._syncMirror.has(id)) { const mm = window._syncMirror.get(id); mm.status = 'error'; mm.errorMessage = _msg; }
        console.warn('[retrySyncTrack] introuvable (bibliothèque + disque):', id);
        if (typeof toast === 'function') toast('Morceau introuvable, même sur le disque — il a dû être supprimé.');
      }
    }
    if (typeof renderSyncQueue === 'function') renderSyncQueue();
  } catch (e) {
    console.warn('[retrySyncTrack] failed for', id, ':', e);
  }
}

// Retire un morceau du Sync par son id de doc Firestore (cas "fichier local
// introuvable" : pas de chemin local pour passer par removeSync). Supprime le
// doc syncQueue → le mobile suit via son listener, et le miroir desktop aussi.
async function removeSyncByDocId(id) {
  if (!id) return;
  try {
    if (window.WT?.firebase && window.WT?.user) {
      const { db, doc, deleteDoc } = window.WT.firebase;
      await deleteDoc(doc(db, 'users', window.WT.user.uid, 'syncQueue', id));
    }
    if (window._syncMirror) window._syncMirror.delete(id);
    if (window._pushedTrackIds) window._pushedTrackIds.delete(id);
    if (typeof renderSyncQueue === 'function') renderSyncQueue();
  } catch (e) {
    console.warn('[removeSyncByDocId] failed for', id, ':', e);
  }
}

// ── Réparation one-shot des docs en ERREUR dont le fichier a dérivé ──────
// Pour chaque doc syncQueue en `status:'error'` qui se re-résout dans la
// bibliothèque (fichier déplacé/renommé/re-scané), on réécrit l'URL sur le
// trackId stable, on corrige le filename, on rebascule en `pending` et on
// (re)sert le chemin courant. Le mobile re-télécharge alors depuis la bonne
// URL via son listener. Idempotent, garde de session (1 passe par démarrage).
// Ne touche QUE les docs en erreur → aucun re-téléchargement des morceaux déjà
// transférés (leur URL md5 legacy reste servie par le serveur).
async function _repairSyncUrls() {
  if (window._syncUrlsRepaired) return;
  if (!window.WT?.firebase || !window.WT?.user) return;
  if (!window._syncMirror || !window._syncMirror.size) return;
  if (typeof allTracks === 'undefined' || !allTracks.length) return;  // bibliothèque pas prête
  window._syncUrlsRepaired = true;

  const { db, doc, setDoc } = window.WT.firebase;
  const uid = window.WT.user.uid;
  let repaired = 0;

  for (const m of window._syncMirror.values()) {
    if (m.status !== 'error') continue;
    const r = _resolveTrackInLibrary({
      id: m.id, artist: m.artist, album: m.album, title: m.title, filename: m.filename,
    });
    let resolvedPath = (r && r.path) ? r.path : null;

    // Pas dans allTracks → recherche AUTOMATIQUE sur le disque (dossier Musique).
    // Retrouve les fichiers déplacés hors bibliothèque sans clic (Jello, Nude…).
    if (!resolvedPath && window.wt?.syncFindFile) {
      try {
        const found = await window.wt.syncFindFile({ filename: m.filename, title: m.title, artist: m.artist, album: m.album });
        if (found) {
          resolvedPath = found;
          window._syncExtraServe = window._syncExtraServe || new Map();
          window._syncExtraServe.set(m.id, { path: found, title: m.title, artist: m.artist, album: m.album, year: m.year });
          console.log('[repairSyncUrls] retrouvé sur le disque:', m.id, '→', found);
        }
      } catch (e) { /* silent */ }
    }
    if (!resolvedPath) continue;  // vraiment introuvable → reste en erreur (× par docId)

    // Réconcilie syncSel + index inverse vers le chemin courant
    syncSel.add(resolvedPath);
    window._pushedTrackPaths = window._pushedTrackPaths || new Map();
    window._pushedTrackPaths.set(resolvedPath, m.id);

    try {
      await setDoc(
        doc(db, 'users', uid, 'syncQueue', m.id),
        {
          url: `http://${myIP}:${myPort}/f/${m.id}`,
          filename: (resolvedPath.split('/').pop()) || m.filename || `${m.id}.mp3`,
          status: 'pending',
          errorMessage: '',
        },
        { merge: true }
      );
      m.status = 'pending'; m.errorMessage = '';
      repaired++;
    } catch (e) {
      console.warn('[repairSyncUrls] échec pour', m.id, ':', e);
    }
  }

  if (repaired > 0) {
    console.log(`[repairSyncUrls] ${repaired} doc(s) en erreur re-résolu(s) et remis en pending`);
    _ensureHttpServed();
    if (typeof toast === 'function') {
      toast(`${repaired} morceau${repaired > 1 ? 'x' : ''} réparé${repaired > 1 ? 's' : ''} (chemin re-résolu)`);
    }
  }
}

function removeSync(p) {
  syncSel.delete(p);
  // Patch J : retire le lien manuel. Le doc reste s'il y a des liens playlist.
  // Si plus aucun lien, le doc Firestore est supprimé automatiquement.
  let t = allTracks.find(x => x.path === p);
  // Phase 2 : chemin dérivé (× inerte jusqu'ici) → re-résolution bibliothèque
  if (!t) t = _resolveTrackInLibrary({ path: p });
  if (t) {
    if (t.path && t.path !== p) syncSel.delete(t.path);  // purge le chemin courant aussi
    _syncLinkRemove(t, { manual: true });

    // Marquer comme exclu si c'est un favori : sans cette marque, le prochain
    // toggle favori re-pousserait le morceau dans syncSel automatiquement.
    // L'exclusion est mémorisée jusqu'à une action explicite (drag-drop dans
    // le panneau Sync). Persistée via trackMeta (champ syncExcluded).
    if (t.isFavorite) {
      t._syncExcluded = true;
      if (typeof scheduleMetaSave === 'function') scheduleMetaSave();
      console.log(`[removeSync] ${t.title} marqué exclu du sync auto-favori`);
    }
  }
  // Patch D : maj l'index du serveur HTTP local (retire ce morceau)
  _ensureHttpServed();
  renderSyncQueue();
}
function syncAll(){
  // Patch I : ajoute aussi le lien manual à chaque morceau dans Firestore
  allTracks.forEach(t => {
    syncSel.add(t.path);
    _syncLinkAdd(t, { manual: true });
  });
  // Patch D : indexe la totalité dans le serveur HTTP local
  _ensureHttpServed();
  renderSyncQueue();
  if(!document.getElementById('syncView').classList.contains('on'))showSyncView();
}
// Patch A : Vider tout le Sync.
// Supprime VRAIMENT tous les docs Firestore (syncQueue + syncPlaylists)
// pour que le mobile reflète le vide instantanément via son listener.
// Garde-fou : modal custom de confirmation (pas confirm() natif).
function syncNone(){
  // Compte les playlists synchronisées pour le message de confirmation
  const syncedPlaylists = allLists.filter(pl => pl?._sync === true && pl?._syncFirestoreId);
  const tracksCount = syncSel.size;
  const playlistsCount = syncedPlaylists.length;

  if(tracksCount === 0 && playlistsCount === 0){
    toast('Sync déjà vide');
    return;
  }

  // Ouvre la modal custom (créée par Patch B). Si pas encore en DOM, fallback confirm().
  if(typeof _openSyncClearConfirm === 'function'){
    _openSyncClearConfirm(tracksCount, playlistsCount, () => _doSyncNone());
  } else {
    // Fallback : confirm natif si modal pas chargée (sécurité)
    const msg = `Vider tout le Sync ?\n\n${tracksCount} morceau(x) et ${playlistsCount} playlist(s) seront retirés de ton mobile.\n\nCette action est immédiate et bidirectionnelle.`;
    if(!confirm(msg)) return;
    _doSyncNone();
  }
}

// Patch A : exécution réelle du vidage. Séparée de syncNone() pour pouvoir
// l'appeler depuis la modal custom OU le confirm() de fallback.
async function _doSyncNone(){
  if(!window.WT?.firebase || !window.WT?.user){
    toast('Sync indisponible (Firebase pas prêt)');
    return;
  }

  const { db, collection, getDocs, deleteDoc } = window.WT.firebase;
  const uid = window.WT.user.uid;

  console.log('[syncNone] début du vidage complet Firestore + local');

  // 1. Supprime TOUS les docs syncPlaylists côté Firestore
  let playlistsDeleted = 0;
  try {
    const psnap = await getDocs(collection(db, 'users', uid, 'syncPlaylists'));
    for(const d of psnap.docs){
      await deleteDoc(d.ref);
      playlistsDeleted++;
    }
    console.log(`[syncNone] supprimé ${playlistsDeleted} playlist(s) Firestore`);
  } catch(e){
    console.warn('[syncNone] suppression syncPlaylists failed:', e);
  }

  // 2. Supprime TOUS les docs syncQueue côté Firestore
  let tracksDeleted = 0;
  try {
    const qsnap = await getDocs(collection(db, 'users', uid, 'syncQueue'));
    for(const d of qsnap.docs){
      await deleteDoc(d.ref);
      tracksDeleted++;
    }
    console.log(`[syncNone] supprimé ${tracksDeleted} morceau(x) Firestore`);
  } catch(e){
    console.warn('[syncNone] suppression syncQueue failed:', e);
  }

  // 3. Reset local côté desktop
  syncSel.clear();
  allLists.forEach(pl => {
    if(pl._sync){
      pl._sync = false;
      delete pl._syncFirestoreId;
    }
  });
  if(window._pushedTrackIds) window._pushedTrackIds.clear();
  if(window._pushedTrackPaths) window._pushedTrackPaths.clear();
  if(typeof _syncedPlaylistHashes !== 'undefined') _syncedPlaylistHashes.clear();

  // 4. Refresh UI
  if(typeof renderSyncQueue === 'function') renderSyncQueue();
  if(typeof renderSidebar === 'function') renderSidebar();
  if(typeof updateSyncStats === 'function') updateSyncStats([]);
  if(typeof scheduleSave === 'function') scheduleSave();

  // 5. Feedback utilisateur
  toast(`✓ Sync vidé · ${tracksDeleted} morceau(x) · ${playlistsDeleted} playlist(s)`);
  console.log('[syncNone] vidage terminé. Le mobile va se mettre à jour via son listener.');
}

// Patch B : modal de confirmation custom pour Vider le Sync
let _syncClearPendingAction = null;

function _openSyncClearConfirm(tracksCount, playlistsCount, onConfirm){
  const ov = document.getElementById('ovSyncClear');
  const body = document.getElementById('syncClearBody');
  if(!ov || !body){
    // Fallback si modal pas en DOM (cas anormal)
    if(confirm(`Vider tout le Sync ?\n\n${tracksCount} morceaux · ${playlistsCount} playlists`)){
      onConfirm();
    }
    return;
  }

  // Construction du message
  const lines = [];
  lines.push(`<strong style="color:var(--t1)">${tracksCount}</strong> morceau${tracksCount !== 1 ? 'x' : ''}`);
  if(playlistsCount > 0){
    lines.push(`<strong style="color:var(--t1)">${playlistsCount}</strong> playlist${playlistsCount !== 1 ? 's' : ''} synchronisée${playlistsCount !== 1 ? 's' : ''}`);
  }
  body.innerHTML = `
    <p style="margin:0 0 10px"><strong style="color:var(--t1)">${lines.join(' · ')}</strong> seront supprimés du Sync.</p>
    <p style="margin:0 0 10px">Cette action retire le contenu de ton mobile <strong style="color:var(--t1)">immédiatement</strong> via Firebase.</p>
    <p style="margin:0;color:var(--t3);font-size:12px">Les playlists restent côté desktop, juste désynchronisées.</p>
  `;

  _syncClearPendingAction = onConfirm;
  const confirmBtn = document.getElementById('syncClearConfirmBtn');
  if(confirmBtn){
    confirmBtn.onclick = () => {
      // Patch fix : on capture la fonction AVANT d'appeler close (qui la reset à null)
      const action = _syncClearPendingAction;
      _closeSyncClearConfirm();
      if(typeof action === 'function'){
        action();
      }
    };
  }

  ov.classList.add('on');
}

function _closeSyncClearConfirm(){
  document.getElementById('ovSyncClear')?.classList.remove('on');
  _syncClearPendingAction = null;
}

// Fermer la modal en cliquant à l'extérieur
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('ovSyncClear')?.addEventListener('click', (e) => {
    if(e.target.id === 'ovSyncClear') _closeSyncClearConfirm();
  });
});
function syncAddPlaylists(){
  allLists.forEach(l => {
    l.tracks?.forEach(t=>{if(t.path)syncSel.add(t.path);});
    _syncPushPlaylistToFirestore(l);  // Patch D : push chaque playlist Firestore
  });
  renderSyncQueue();
  toast('✓ Toutes les playlists ajoutées');
}

// Drag & Drop — Sync
function onDragOver(e){
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  // Hover visuel sur la zone, qu'elle soit vide (#dropZone) ou pleine (#syncQueue)
  (document.getElementById('dropZone') || document.getElementById('syncQueue'))?.classList.add('drop-hover');
}
function onDragLeave(e){
  (document.getElementById('dropZone') || document.getElementById('syncQueue'))?.classList.remove('drop-hover');
}
function onDrop(e){
  e.preventDefault();
  e.stopPropagation();
  (document.getElementById('dropZone') || document.getElementById('syncQueue'))?.classList.remove('drop-hover');

  let added = 0;
  let failed = false;

  // 1. Multi-tracks (sélection drag-and-drop)
  try {
    const tracksJson = e.dataTransfer.getData('tracks');
    if (tracksJson) {
      const tracks = JSON.parse(tracksJson);
      if (Array.isArray(tracks) && tracks.length > 0) {
        tracks.forEach(t => { if (t?.path) { syncSel.add(t.path); added++; } });
      }
    }
  } catch (err) { console.warn('[sync drop] tracks parse failed:', err); failed = true; }

  // 2. Single track (fallback)
  if (added === 0) {
    try {
      const trackJson = e.dataTransfer.getData('track');
      if (trackJson) {
        const t = JSON.parse(trackJson);
        if (t?.path) { syncSel.add(t.path); added++; }
      }
    } catch (err) { console.warn('[sync drop] track parse failed:', err); failed = true; }
  }

  // 3. Playlist drag (depuis la sidebar)
  if (added === 0) {
    const plIdxStr = e.dataTransfer.getData('text/x-wt-pl-idx');
    if (plIdxStr) {
      const idx = parseInt(plIdxStr, 10);
      const pl = allLists[idx];
      if (pl?.tracks?.length) {
        pl.tracks.forEach(t => { if (t?.path) { syncSel.add(t.path); added++; } });
        _syncPushPlaylistToFirestore(pl);  // Patch D : push la playlist Firestore (= visible côté mobile)
        toast(`+ Playlist "${pl.name}" — ${added} morceaux`);
        renderSyncQueue();
        if (typeof updateSpGoState === 'function') updateSpGoState();
        return;
      }
    }
  }

  // 4. Files depuis le Finder (drag de fichiers MP3/M4A)
  if (added === 0 && e.dataTransfer.files?.length) {
    const audioExt = /\.(mp3|m4a|aac|flac|ogg|wav|aiff?)$/i;
    const audioFiles = Array.from(e.dataTransfer.files).filter(f => audioExt.test(f.name));
    if (audioFiles.length === 0) {
      toast('Aucun fichier audio dans le drop');
    } else {
      // On a besoin que ces fichiers soient déjà dans allTracks pour les sync.
      // Si non, on demande à l'user de les importer d'abord via le bouton Bibliothèque.
      const matched = [];
      const unmatched = [];
      for (const f of audioFiles) {
        // Match par nom de fichier (path se termine par f.name) — heuristique
        const found = allTracks.find(t => t.path && t.path.endsWith(f.name));
        if (found) { syncSel.add(found.path); matched.push(found); added++; }
        else unmatched.push(f.name);
      }
      if (matched.length > 0) {
        toast(`+ ${matched.length} fichier(s) ajouté(s)`);
      }
      if (unmatched.length > 0) {
        toast(`${unmatched.length} fichier(s) pas dans la bibliothèque — à importer d'abord`);
      }
    }
  }

  // 5. Résultat
  if (added > 0) {
    toast(added === 1 ? `+ 1 morceau ajouté` : `+ ${added} morceaux ajoutés`);
    // Patch D : indexe automatiquement les nouveaux morceaux dans le serveur HTTP local
    _ensureHttpServed();
    renderSyncQueue();
    if (typeof updateSpGoState === 'function') updateSpGoState();
  } else if (failed) {
    toast('Erreur de drop — voir console');
  } else {
    console.warn('[sync drop] aucun format reconnu', Array.from(e.dataTransfer.types));
  }
}

function setFolderLabel(p){
  const txt = p ? p.split('/').pop() : 'Aucun dossier';
  // Label unique dans le header de sidebar (bloc Bibliothèque)
  const el = document.getElementById('libFolderLbl');
  if(el) el.textContent = txt;
  // Marquage visuel si aucun dossier (attire l'œil sur le bouton)
  const btn = document.getElementById('libFolderBtn');
  if(btn) btn.classList.toggle('no-folder', !p);
}

function setMode(m){
  syncMode=m;
  document.getElementById('modeWifi').classList.toggle('on',m==='wifi');
  document.getElementById('modeFb').classList.toggle('on',m==='firebase');
}

let syncing=false;
async function doSync(){
  if(syncing) return;
  syncing=true;
  const fill=document.getElementById('spFill');
  const st=document.getElementById('spSt');
  const go=document.getElementById('spGo');
  go.disabled=true; go.textContent='Synchronisation…';
  fill.classList.remove('done'); fill.style.width='0%';
  try {
    // Construire la liste à envoyer au serveur HTTP local
    const selected = allTracks.filter(t => syncSel.has(t.path));
    if(!selected.length){
      st.textContent = 'Aucun morceau sélectionné';
      go.textContent='Lancer la sync'; go.disabled=false; syncing=false;
      fill.style.width='0%'; return;
    }
    // Animation progression pendant qu'on envoie
    let p=0; const iv=setInterval(()=>{p=Math.min(p+5,85);fill.style.width=p+'%';},40);
    // Envoyer au serveur HTTP local
    let n = 0;
    if(window.wt?.syncSetTracks){
      n = await window.wt.syncSetTracks(selected.map(t => ({
        id: _trackIdFor(t), title:_syncTitle(t), artist:t.artist||'', album:t.album||'',
        year:t.year||null, path:t.path
      })));
    }
    // ── NOUVEAU : pousser la queue dans Firestore pour notifier le mobile ──
    let firestoreCount = 0;
    if (window.WT?.firebase && window.WT?.user) {
      const { db, doc, setDoc, Timestamp } = window.WT.firebase;
      const uid = window.WT.user.uid;
      const baseUrl = `http://${myIP}:${myPort}`;

      // Slugify pour générer des trackIds stables (mêmes valeurs côté mobile/desktop)
      const _slugifyTrackDoSync = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0, 60);

      // Resync léger : on ne ré-écrit dans Firestore que les morceaux PAS ENCORE
      // reçus par le téléphone (nouveaux, en attente, en erreur). Ré-écrire tous
      // les docs à chaque « Resynchroniser » relançait tout le monde, re-résolvait
      // toutes les pochettes (lag) et saturait Firestore (erreurs 400). Le serveur
      // HTTP, lui, continue de tout servir (syncSetTracks ci-dessus, non filtré).
      const _mir = window._syncMirror;
      const toPush = selected.filter(t => {
        const _id = _trackIdFor(t);
        const m = _mir && _mir.get(_id);
        return !m || m.status !== 'received';
      });
      console.log(`[doSync] ${toPush.length}/${selected.length} morceaux à (ré)écrire dans Firestore (le reste est déjà sur le téléphone)`);

      const writes = toPush.map(async (t) => {
        const trackId = _trackIdFor(t);
        if (!trackId || trackId === '__') {
          console.warn('[doSync] skipping track without trackId:', t.title);
          return;
        }

        try {
          // Résolution de la pochette via la même hiérarchie que le player local
          const coverUrl = (typeof resolveCoverForTrack === 'function')
            ? (await resolveCoverForTrack(t) || null)
            : null;

          await setDoc(
            doc(db, 'users', uid, 'syncQueue', trackId),
            {
              title: _syncTitle(t),
              artist: t.artist || '',
              album: t.album || '',
              year: t.year || null,
              genre: t.genre || null,             // ← AJOUT : genre poussé vers mobile
              albumArtUrl: coverUrl,              // ← AJOUT : pochette poussée vers mobile
              filename: (t.path || '').split('/').pop() || `${trackId}.mp3`,
              url: `${baseUrl}/f/${trackId}`,     // URL sur trackId stable (anti-dérive)
              size: t.size || 0,
              status: 'pending',
              addedAt: Timestamp.now(),
            },
            { merge: true }
          );
          firestoreCount++;
        } catch (e) {
          console.warn('[doSync firestore]', t.title, e);
        }
      });

      await Promise.allSettled(writes);
      console.log('[doSync] firestore queue updated:', firestoreCount, 'tracks');

      // ── NOUVEAU : marquer les trackIds qu'on a poussés ─────────────
      // Permet au listener syncQueue de distinguer "morceau pas encore
      // poussé" (à garder) de "morceau poussé puis disparu" (suppression
      // mobile, à retirer).
      window._pushedTrackIds = window._pushedTrackIds || new Set();
      window._pushedTrackPaths = window._pushedTrackPaths || new Map();  // path → trackId actuel sur Firestore
      const _slugifyTrack = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0, 60);
      selected.forEach(t => {
        const trackId = _trackIdFor(t);
        if (trackId && trackId !== '__') {
          window._pushedTrackIds.add(trackId);
          // Index inverse : path → trackId actuel
          // Permet à schedulePropagateTrackUpdate de retrouver le morceau
          // même quand son titre a changé (le path reste stable)
          if (t.path) window._pushedTrackPaths.set(t.path, trackId);
        }
      });
      console.log('[doSync] tracked', window._pushedTrackIds.size, 'pushed trackIds,', window._pushedTrackPaths.size, 'paths');
    } else {
      console.warn('[doSync] Firebase non prêt — sync queue notification skipped');
    }

    // ── FIN nouveau ──

    clearInterval(iv); fill.style.width='100%'; fill.classList.add('done');
    const url = `http://${myIP}:${myPort}/`;
    let msg = `✓ <strong>${n} morceaux</strong> prêts`;
    if (firestoreCount > 0) {
      msg += ` · Ton téléphone va recevoir ${firestoreCount} morceau${firestoreCount>1?'x':''} à sa prochaine ouverture`;
    } else {
      msg += ` · Sur ton smartphone (même WiFi), ouvre <a href="${url}" style="color:var(--acc)">${url}</a> dans Safari`;
    }
    st.innerHTML = msg;
    go.textContent='↻ Resynchroniser'; go.disabled=false;
    toast(`✓ ${n} morceaux partagés${firestoreCount>0?` · ${firestoreCount} notifiés au téléphone`:''}`);
  } catch(e) {
    console.error('[doSync]', e);
    st.textContent = '✗ Erreur : ' + (e.message || 'sync impossible');
    go.textContent='Réessayer'; go.disabled=false;
    fill.style.width='0%';
  } finally {
    syncing=false;
  }
}

function copyIP(){
  const url=`http://${myIP}:${myPort}/tracks`;
  navigator.clipboard?.writeText(url);
  toast('✓ URL copiée');
}

// ── PLAYER ────────────────────────────────────────
// Convertir un chemin fichier en URL audio valide
function pathToUrl(p) {
  try {
    if (p.startsWith('file://')) return p;
    return 'file://' + p.split('/').map(seg =>
      seg.replace(/[^A-Za-z0-9\-_.!~*'()[\]@,;$&+=]/g, c => encodeURIComponent(c))
    ).join('/');
  } catch { return 'file://' + p; }
}

function playFrom(i){
  playbackHistory = []; // Reset l'historique pour la nouvelle liste
  queue=filtered.map(t=>({...t,url:pathToUrl(t.path)}));
  // Set context based on current state
  if(curPl>=0 && allLists[curPl]) setPlayContext('playlist', allLists[curPl].name);
  else if(viewMode==='artist') { /* context set by playArtist */ }
  else if(viewMode==='album')  { /* context set by playAlbum  */ }
  else setPlayContext('all','');
  // La queue vient d'être remplacée — invalider l'ordre shuffle
  // (les anciens indices ne correspondent plus à la nouvelle queue)
  _shuffleOrder=[]; _shuffleCursor=0;
  // Reset la limite d'affichage de la mini-queue (nouvelle playlist = nouveau départ)
  if(typeof _miniQueueLimit !== 'undefined') _miniQueueLimit = 25;
  qi=i;
  if(shuffle) buildShuffleOrder();
  playIdx(i);
}
// Met à jour l'overlay au hover de la cover du mini-player.
// Extrait de playIdx pour pouvoir le rappeler après saveOmniChanges (sinon
// l'overlay garde l'ancienne année/album quand on édite le track en cours).
function _refreshPlayerOverlay(t) {
  if (!t) return;
  const albumEl = document.getElementById('pArtAlbumName');
  const yearEl = document.getElementById('pArtYearVert');
  const genreEl = document.getElementById('pArtGenreChip');
  if (albumEl) albumEl.textContent = t.album ? '[' + _displayAlbum(t.album) + ']' : '';
  // Transparence (compact, l'espace est réduit) : « ··· » pendant la recherche,
  // « ∅ » quand la recherche a eu lieu sans résultat fiable — le détail complet
  // est donné par le toast et par le fullscreen.
  const _pvNoInfo = !!(t._autoProcessed && (t._autoOutcome === 'refused' || t._autoOutcome === 'empty'));
  if (yearEl) {
    yearEl.textContent = t.year || (t._verifying ? '···' : (_pvNoInfo ? '∅' : 'inconnue'));
    // C191 : les symboles d'état (···/∅/?) sont illisibles en rendu
    // vertical 9px — la classe .state bascule en pastille horizontale.
    yearEl.classList.toggle('state', !t.year);
    yearEl.title = t.year ? '' : (t._verifying ? 'Recherche des infos en cours…'
      : (_pvNoInfo ? 'Année introuvable en ligne (recherche effectuée)'
      : 'Année inconnue — sera recherchée à la lecture (ou clic droit → Compléter les infos)'));
  }
  if (genreEl) {
    const g = t.genreStyle || t.genre || '';
    if (g) {
      genreEl.textContent = g;
      const color = (typeof getGenreColor === 'function') ? getGenreColor(g) : '#AEACA6';
      genreEl.style.setProperty('--wt-genre-color', color);
      genreEl.style.display = 'inline-flex';
    } else {
      genreEl.style.display = 'none';
    }
  }
  const ov = document.getElementById('pArtAlbumOv');
  if (ov) {
    if (!t.album && !t.year && !(t.genreStyle || t.genre)) ov.classList.add('empty');
    else ov.classList.remove('empty');
  }
}


let _lastPriorityAlbum = '';   // dernier album priorisé en lecture (anti-spam addForce)
const _playVerifySeen = new Set();  // chemins déjà re-vérifiés cette session (anti-spam)
// C196 : révision de la LOGIQUE de recherche. À incrémenter quand un correctif
// change ce que l'auto peut trouver (ex. C192-193 : brackets déballés) — les
// cooldowns d'échec posés AVANT deviennent caducs pour les morceaux douteux,
// sinon ils restent bloqués 7 jours sur un échec dû à l'ancien bug.
const _PV_LOGIC_REV = 3;
function playIdx(i){
  playbackHistory = playbackHistory.filter(idx => idx !== i);
  if(i<0||i>=queue.length)return;
  // Phase 3 : on PRIORISE l'auto sur l'ALBUM du morceau qu'on lance — pas juste
  // le morceau (add() est bloqué par _seen une fois le boot passé). addForce
  // double la file : le morceau en cours + ses voisins d'album incomplets passent
  // devant, prêts quand tu y arrives. Une seule fois par album (anti-spam).
  if (typeof enrichQueue !== 'undefined' && enrichQueue.addForce && typeof allTracks !== 'undefined') {
    const _cur = queue[i];
    // Le morceau JOUÉ est re-vérifié lui-même (même s'il paraît « complet » —
    // un genre faux comme « R&B » sur de la salsa n'est pas détectable par
    // _incomplete). Une fois par session par morceau. Les résultats sûrs
    // s'appliquent automatiquement ; les douteux partent en revue (à vérifier
    // plus tard). addForce respecte _userModified/_ignored.
    // COOLDOWN PERSISTANT : pas de recherche à chaque play. Un morceau DOUTEUX
    // (info manquante/junk) est re-vérifié au plus tous les 7 jours ; un morceau
    // qui paraît complet n'est vérifié qu'UNE fois (chasse au genre faux).
    // L'horodatage survit aux redémarrages via trackMeta (checkedAt).
    const _pvNow = Date.now();
    const _pvRecheckMs = 7 * 24 * 3600 * 1000;
    const _pvDoubt = _cur && (_cur._incomplete
      || !_cur.genre || (typeof isJunkGenre === 'function' && isJunkGenre(_cur.genre))
      || !_cur.year  || (typeof isJunkYear  === 'function' && isJunkYear(_cur.year)));
    const _pvCheckedAt = (_cur && _cur._playCheckedAt) || 0;
    // C196 : vérif faite sous une logique antérieure → caduque pour un douteux.
    const _pvStaleRev = ((_cur && _cur._playCheckedRev) || 0) < _PV_LOGIC_REV;
    // C222 : un morceau qui PARAÎT complet n'était vérifié qu'une fois dans sa
    // vie, puis plus jamais — même après un correctif de pipeline. La révision de
    // logique (_PV_LOGIC_REV) le rend à nouveau vérifiable UNE fois, ce qui permet
    // au balayage des données fausses (C222) d'atteindre toute la bibliothèque,
    // progressivement, au fil des écoutes. Puis le cooldown reprend ses droits.
    const _pvDue = _pvDoubt ? (_pvStaleRev || _pvNow - _pvCheckedAt > _pvRecheckMs)
                            : (!_pvCheckedAt || _pvStaleRev);
    // C203 : _userModified n'exclut plus la RECHERCHE — il protège l'ÉCRITURE.
    // Un morceau édité à la main mais douteux (année/genre VIDE) part en mode
    // « fillOnly » : seuls ses champs vides peuvent être comblés, rien
    // d'existant n'est jamais touché, _userModified n'est jamais effacé.
    const _pvFillOnly = !!(_cur && _cur._userModified);
    if (_cur && _cur.path && _pvDue && !_playVerifySeen.has(_cur.path)
        && (!_pvFillOnly || _pvDoubt) && !_cur._ignored) {
      _playVerifySeen.add(_cur.path);
      // Cible = l'objet allTracks (les entrées de queue sont des COPIES : sans
      // ça, l'horodatage/outcome ne se persistaient pas, et le drapeau
      // « recherche en cours » pouvait rester bloqué sur la copie affichée).
      const _pvTarget = (typeof allTracks !== 'undefined' && allTracks.find(x => x.path === _cur.path)) || _cur;
      _pvTarget._verifying = true;
      _cur._verifying = true; // la copie de queue est ce que le fullscreen affiche
      // Le lot autoResolve.bulk sature le pipeline réseau (throttle MB 1 req/s) :
      // on le met en pause le temps de vérifier le morceau JOUÉ, sinon l'user
      // attend plusieurs minutes son résultat. Repris à la fin (cf. _tick).
      try {
        const _bk = window.autoResolve && window.autoResolve.bulk;
        if (_bk && _bk.status && _bk.status().running && !_bk.status().paused) {
          _bk.pause();
          window._bulkPausedForPlay = true;
        }
      } catch(e) {}
      enrichQueue.addForce(_pvTarget, { priority: 15, fillOnly: _pvFillOnly });
      console.log(`[play→auto] vérification de « ${_cur.title || _cur.path.split('/').pop()} » lancée`);
      if (_fsActive && typeof _fsRefresh === 'function') setTimeout(_fsRefresh, 30);
    } else if (_cur && _cur.path && _pvDoubt && !_pvDue) {
      // Transparence : un morceau DOUTEUX sauté par le cooldown le dit dans la
      // console — sinon « pas de recherche ? » est indiscernable d'un oubli.
      const _pvNextD = Math.max(1, Math.ceil((_pvRecheckMs - (_pvNow - _pvCheckedAt)) / 86400000));
      console.log(`[play→auto] « ${_cur.title || _cur.path.split('/').pop()} » : déjà vérifié récemment, pas de nouvelle recherche (retentative auto dans ~${_pvNextD} j — clic droit → « Compléter les infos » pour forcer)`);
    }
    const _alb = _cur ? (_cur.album || '').toLowerCase().trim() : '';
    if (_alb && _alb !== _lastPriorityAlbum) {
      _lastPriorityAlbum = _alb;
      const _gaps = allTracks.filter(t => t && t._incomplete && !t._userModified && !t._ignored
        && (t.album || '').toLowerCase().trim() === _alb);
      if (_gaps.length) {
        enrichQueue.addForce(_gaps, { priority: 12 });
        console.log(`[play→auto] ${_gaps.length} morceau(x) incomplet(s) de « ${_cur.album} » priorisés`);
      }
    }
  }
  qi=i; const t=queue[i];
  // Nouveau morceau → autoriser le scroll auto vers "now" au prochain render de la mini queue
  _miniScrollToNowOnce = true;
  au.src=t.url||pathToUrl(t.path);
  if(audioCtx&&audioCtx.state==='suspended') audioCtx.resume();
  au.play().catch(e=>console.warn(e));
  document.getElementById('pTitle').textContent=t.title||'–';

  // Sous-ligne : artiste seul (l'album passe dans l'overlay cover)
  const _pSub=document.getElementById('pSub');
  if(_pSub){
    const _pa=t.artist||'';
    _pSub.innerHTML = _pa
      ? `<span style="color:#C85A45;font-family:'Inter',sans-serif;font-style:italic;letter-spacing:.04em">${esc(_pa)}</span>`
      : '–';
  }

// Overlay au hover de la cover : album (centré) + année (verticale bas-droite) + chip genre (bas-gauche)
  _refreshPlayerOverlay(t);
  document.getElementById('pIdx').textContent=`${i+1}/${queue.length}`;
  // Sync mini player
  // Patch : tracking play stats (playCount, lastPlayed) pour smart playlists
  if(typeof _trackPlayStart === 'function') _trackPlayStart(t);
  nowPath=t.path; renderVirtual();
  fetchArt(t);
      if (typeof _refreshPlayerOverlay === 'function') _refreshPlayerOverlay(t);
  computeNext();
  renderDockQueue();
  if(typeof _miniDrawerOpen!=='undefined'&&_miniDrawerOpen) renderMiniQueue();
 if(typeof updatePlayingFavoriteUI==='function') updatePlayingFavoriteUI();
  if(typeof _notifyNowPlaying==='function') _notifyNowPlaying(queue[qi]); // notif macOS façon iTunes
  if(typeof _updateMediaSession==='function') _updateMediaSession(queue[qi]); // widget « En lecture » + touches média
  if(typeof updatePlayingSyncUI==='function') updatePlayingSyncUI(); // le tél. reflète le NOUVEAU morceau
  if(typeof _fsClearLoop==='function') _fsClearLoop(); // la boucle A-B ne survit pas au changement de piste
  if(_fsActive && typeof _fsRefresh === 'function') _fsRefresh();
  // Marquee : déclencher si le titre déborde
  setTimeout(checkTitleOverflow, 150);
  _miniScrollToNowOnce = true; // Pour que la liste s'aligne sur le morceau actuel
  renderMiniQueue();
}
// ── PLAY STATS TRACKING ────────────────────────────
// Patch : enregistre playCount + lastPlayed pour smart playlists.
// Persisté via prefs.trackMeta (même mécanisme que isFavorite).

let _playStatsSaveTimer = null;
const _playStatsPending = {}; // path -> { playCount, lastPlayed }

function _trackPlayStart(t){
  if(!t || !t.path) return;
  // Cherche le track canonique dans allTracks (la queue contient des copies)
  const src = allTracks.find(x => x.path === t.path);
  if(!src) return;

  src.playCount = (src.playCount || 0) + 1;
  src.lastPlayed = Date.now();

  // Sync aussi sur la copie en queue pour que les évals immédiates soient à jour
  t.playCount = src.playCount;
  t.lastPlayed = src.lastPlayed;

  // Mémoriser pour persistance batched
  _playStatsPending[t.path] = {
    playCount: src.playCount,
    lastPlayed: src.lastPlayed
  };

  // Debounce 3s pour éviter d'écrire à chaque skip rapide
  if(_playStatsSaveTimer) clearTimeout(_playStatsSaveTimer);
  _playStatsSaveTimer = setTimeout(_flushPlayStats, 3000);
}

async function _flushPlayStats(){
  _playStatsSaveTimer = null;
  const batch = {..._playStatsPending};
  for(const k of Object.keys(_playStatsPending)) delete _playStatsPending[k];
  if(!Object.keys(batch).length) return;

  // Persiste via le canal trackMeta existant (main.js le stocke dans prefs.json)
  if(window.wt && typeof window.wt.saveTrackMeta === 'function'){
    const payload = {};
    for(const [path, stats] of Object.entries(batch)){
      payload[path] = stats;
    }
    try {
      await window.wt.saveTrackMeta(payload);
      console.log('[playStats] persisted', Object.keys(payload).length, 'tracks');
    } catch(e){
      console.warn('[playStats] save failed', e);
    }
  }
}

// Au unload : on flush immédiatement pour ne pas perdre les dernières lectures
window.addEventListener('beforeunload', () => {
  if(_playStatsSaveTimer){
    clearTimeout(_playStatsSaveTimer);
    _flushPlayStats();
  }
});
function togglePlay() {
  if (!queue.length) return;
  if (au.paused) {
    au.play();
  } else {
    au.pause();
  }
  // ✅ Refresh fullscreen play icon if active
  if (_fsActive && typeof _fsRefresh === 'function') {
    setTimeout(_fsRefresh, 50);
  }
}
// Index du prochain morceau (pré-calculé pour shuffle)
let nextQueueIdx=-1;
// Ordre aléatoire persistant pendant une session shuffle : index courant en premier, puis un vrai mélange
let _shuffleOrder=[];       // tableau d'indices dans `queue`, dans l'ordre de lecture shuffle
let _shuffleCursor=0;       // position courante dans _shuffleOrder

// ══ Exclure de l'aléatoire (no-play-in-shuffle) + Minuteur de veille (Sleep) ══
function _loadNoShuffle(){
  try { return new Set(JSON.parse(localStorage.getItem('wt_no_shuffle') || '[]')); }
  catch(e){ return new Set(); }
}
let _noShuffleSet = _loadNoShuffle();
function toggleNoShuffleFor(t){
  if(!t || !t.path) return;
  const was = _noShuffleSet.has(t.path);
  if(was) _noShuffleSet.delete(t.path); else _noShuffleSet.add(t.path);
  try { localStorage.setItem('wt_no_shuffle', JSON.stringify([..._noShuffleSet])); } catch(e){}
  _pushNoShuffleToMobile(t, !was);
  _refreshNoShuffleBtn();
  if(typeof computeNext === 'function') computeNext();
  if(typeof toast === 'function') toast(was ? 'Réintégré à l\'aléatoire' : 'Exclu de l\'aléatoire');
}
function toggleCurrentNoShuffle(){
  const t = queue[qi]; if(!t || !t.path) return;
  const was = _noShuffleSet.has(t.path);
  if(was) _noShuffleSet.delete(t.path); else _noShuffleSet.add(t.path);
  try { localStorage.setItem('wt_no_shuffle', JSON.stringify([..._noShuffleSet])); } catch(e){}
  _pushNoShuffleToMobile(t, !was);
  _refreshNoShuffleBtn();
  if(typeof computeNext === 'function') computeNext();
  if(typeof toast === 'function') toast(was ? 'Réintégré à l\'aléatoire' : 'Exclu de l\'aléatoire');
}
// Propage le flag no-play-in-shuffle vers le doc syncQueue du mobile.
// Même garde que propagateTrackUpdate : on ne pousse que si le morceau est
// effectivement synchronisé (présent dans _pushedTrackPaths → on a l'ID du
// doc mobile). Merge → ne touche pas aux autres champs.
function _pushNoShuffleToMobile(track, value){
  try {
    if(!track || !track.path) return;
    if(!window.WT?.firebase || !window.WT?.user || !window._pushedTrackPaths) return;
    const trackId = window._pushedTrackPaths.get(track.path);
    if(!trackId) return; // pas sur mobile
    const { db, doc, setDoc } = window.WT.firebase;
    const uid = window.WT.user.uid;
    setDoc(doc(db, 'users', uid, 'syncQueue', trackId), { noShuffle: !!value }, { merge: true })
      .then(() => console.log('[noShuffle→mobile] pushed:', track.title, !!value))
      .catch(e => console.warn('[noShuffle→mobile] push failed:', e));
  } catch(e){ console.warn('[noShuffle→mobile] error:', e); }
}
function _refreshNoShuffleBtn(){
  const t = queue[qi]; const off = !!(t && t.path && _noShuffleSet.has(t.path));
  document.querySelectorAll('[data-wt-noshuf]').forEach(b => {
    b.classList.toggle('on', off);
    b.title = off ? 'Exclu de l\'aléatoire (clic pour réintégrer)' : 'Ne pas lire en aléatoire';
  });
}
function _nextShuffleIdx(pos){
  const n = _shuffleOrder.length;
  if(n <= 1) return -1;
  for(let step = 1; step < n; step++){
    const p = pos + step;
    if(p >= n && repeat !== 'all') break;
    const idx = _shuffleOrder[p % n];
    const tk = queue[idx];
    if(!tk || _noShuffleSet.has(tk.path)) continue;
    return idx;
  }
  if(pos + 1 < n) return _shuffleOrder[pos + 1];
  return repeat === 'all' ? _shuffleOrder[0] : -1;
}
const _SLEEP_STEPS = [0, 15, 30, 45, 60];
let _sleepTimer = null, _sleepUntil = 0, _sleepEndOfTrack = false, _sleepChosen = 0, _sleepTracksLeft = 0;
function _sleepMinLeft(){ return _sleepUntil ? Math.max(0, Math.ceil((_sleepUntil - Date.now()) / 60000)) : 0; }
function cycleSleep(){
  const cur = _sleepUntil ? Math.round((_sleepUntil - Date.now()) / 60000) : 0;
  let i = _SLEEP_STEPS.findIndex(m => m >= cur);
  i = (i < 0 ? 0 : i + 1) % _SLEEP_STEPS.length;
  setSleep(_SLEEP_STEPS[i]);
}
function setSleep(min){
  if(_sleepTimer){ clearTimeout(_sleepTimer); _sleepTimer = null; }
  _sleepEndOfTrack = false;
  _sleepChosen = min || 0;
  if(!min){ _sleepUntil = 0; _refreshSleepBtn(); if(typeof toast === 'function') toast('Veille désactivée'); return; }
  _sleepUntil = Date.now() + min * 60000;
  _sleepTimer = setTimeout(() => {
    try { if(typeof au !== 'undefined' && au) au.pause(); } catch(e){}
    _sleepUntil = 0; _sleepTimer = null; _refreshSleepBtn();
    if(typeof toast === 'function') toast('Veille : lecture en pause');
  }, min * 60000);
  _refreshSleepBtn();
  if(typeof toast === 'function') toast('Veille dans ' + min + ' min');
}
function setSleepAfterTracks(n){
  n = Math.max(1, Math.min(99, parseInt(n) || 1));
  if(_sleepTimer){ clearTimeout(_sleepTimer); _sleepTimer = null; }
  _sleepUntil = 0;
  _sleepEndOfTrack = true;      // le handler 'ended' décompte
  _sleepTracksLeft = n;
  _sleepChosen = 'tracks';
  _refreshSleepBtn();
  if(typeof toast === 'function') toast(n === 1 ? 'Veille : à la fin du morceau' : `Veille : au bout de ${n} morceaux`);
}
function setSleepEndOfTrack(){ setSleepAfterTracks(1); }
function _fsSleepTracksGo(ev){
  if(ev) ev.stopPropagation();
  const inp = document.getElementById('fsSleepNTracks');
  setSleepAfterTracks(inp ? inp.value : 1);
  const pop = document.getElementById('fsSleepPop');
  if(pop) pop.classList.remove('open');
  if(typeof _fsSleepMarkActive === 'function') _fsSleepMarkActive();
}
function _refreshSleepBtn(){
  const m = _sleepMinLeft();
  document.querySelectorAll('[data-wt-sleep]').forEach(b => {
    b.classList.toggle('on', m > 0 || _sleepEndOfTrack);
    const lbl = b.querySelector('.wt-sleep-lbl'); if(lbl) lbl.textContent = _sleepEndOfTrack ? (_sleepTracksLeft > 1 ? _sleepTracksLeft + '♪' : 'fin') : (m > 0 ? m + 'm' : '');
    b.title = _sleepEndOfTrack ? (_sleepTracksLeft > 1 ? ('Veille : encore ' + _sleepTracksLeft + ' morceaux (clic pour changer)') : 'Veille : à la fin du morceau (clic pour changer)')
            : (m > 0 ? ('Veille dans ' + m + ' min (clic pour changer)') : 'Minuteur de veille');
  });
}

function buildShuffleOrder(){
  if(!queue.length){ _shuffleOrder=[]; _shuffleCursor=0; return; }
  // Si qi est hors-bornes, le clamper (ne doit pas arriver mais par sécurité)
  if(qi<0||qi>=queue.length) qi=0;
  // Commencer par le morceau courant, mélanger tous les autres (Fisher-Yates)
  const rest=[];
  for(let i=0;i<queue.length;i++) if(i!==qi) rest.push(i);
  for(let i=rest.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [rest[i],rest[j]]=[rest[j],rest[i]];
  }
  _shuffleOrder = [qi,...rest];
  _shuffleCursor = 0;
  nextQueueIdx = _shuffleOrder.length>1 ? _shuffleOrder[1] : -1;
}

function computeNext(){
  if(!queue.length){nextQueueIdx=-1;return;}
  if(shuffle){
    // Si _shuffleOrder est obsolète (queue remplacée), on le reconstruit
    const orderStale =
      !_shuffleOrder.length ||
      _shuffleOrder.length !== queue.length ||
      _shuffleOrder.some(idx => idx < 0 || idx >= queue.length || !queue[idx]) ||
      _shuffleOrder.indexOf(qi) < 0;
    if(orderStale){ buildShuffleOrder(); return; }
    // Trouver la position actuelle du morceau courant dans _shuffleOrder
    const pos=_shuffleOrder.indexOf(qi);
    if(pos>=0){
      _shuffleCursor=pos;
      nextQueueIdx = _nextShuffleIdx(pos);   // saute les morceaux exclus de l'aléatoire
      return;
    }
    // Sécurité — reconstruire si on a atterri ici
    buildShuffleOrder();
  } else {
    nextQueueIdx=(qi+1)<queue.length?(qi+1):(repeat==='all'?0:-1);
  }
}

function nextTrack(){
  if(!queue.length) return;

  // 1. On enregistre le morceau qu'on vient de finir AVANT de changer l'index
  if (qi >= 0 && qi < queue.length) {
    // Sécurité : on n'ajoute que si le dernier morceau historique est différent du courant
    if (playbackHistory[playbackHistory.length - 1] !== qi) {
      playbackHistory.push(qi);
      if (playbackHistory.length > 50) playbackHistory.shift();
    }
  }

  // 2. Calcul du suivant (Shuffle ou Normal)
  let n;
  if(shuffle){
    n = nextQueueIdx >= 0 ? nextQueueIdx : Math.floor(Math.random() * queue.length);
  } else {
    n = qi + 1;
    if(n >= queue.length){
      if(repeat === 'all') n = 0;
      else { au.pause(); return; }
    }
  }

  // 3. Lancement
  playIdx(n);
}
function prevTrack(){
  // Si on est au milieu du morceau, on recommence juste le titre
  if(au.currentTime > 3){ au.currentTime = 0; return; }
  if(!queue.length) return;

  // UTILISATION DE L'HISTORIQUE
  if (playbackHistory.length > 0) {
    const lastIdx = playbackHistory.pop();
    if (lastIdx < queue.length) {
      playIdx(lastIdx);
      return; // On sort ici pour ne pas exécuter la suite
    }
  }

  // Fallback (si historique vide)
  if(shuffle && _shuffleOrder.length){
    const pos = _shuffleOrder.indexOf(qi);
    if(pos > 0) playIdx(_shuffleOrder[pos - 1]);
    else if(pos === 0 && repeat === 'all') playIdx(_shuffleOrder[_shuffleOrder.length - 1]);
    else au.currentTime = 0;
  } else {
    playIdx((qi - 1 + queue.length) % queue.length);
  }
}
function toggleShuffle(){
  shuffle=!shuffle;
  document.getElementById('pcSh').classList.toggle('on',shuffle);
  const ms=document.getElementById('miniSh');
  if(ms) ms.classList.toggle('on',shuffle);
  if(shuffle) buildShuffleOrder(); else { _shuffleOrder=[]; _shuffleCursor=0; }
  computeNext();
  renderDockQueue();
  renderMiniQueue();
  if(typeof _fsActive!=='undefined' && _fsActive && typeof _fsRefreshCtrls==='function') _fsRefreshCtrls();
  toast(shuffle?'Aléatoire activé':'Aléatoire désactivé');
}
function cycleRepeat(){
  repeat=repeat==='none'?'all':repeat==='all'?'one':'none';
  updateRepeatUI();
  // Re-render queue — repeat='all' changes the wraparound items shown
  if(typeof renderMiniQueue==='function') renderMiniQueue();
}

// ── SYNC du morceau en cours depuis le miniplayer ─────
function togglePlayingSync(){
  const t = queue[qi];
  if(!t || !t.path){ toast('Aucun morceau'); return; }
  if(syncSel.has(t.path)){
    syncSel.delete(t.path);
    toast('− Retiré du Sync');
  } else {
    syncSel.add(t.path);
    toast('✓ Ajouté au Sync');
  }
  console.log('[togglePlayingSync]', t.title, '→ syncSel.size =', syncSel.size);
  updatePlayingSyncUI();
  // Rafraîchir la liste (checkbox de la track row) + stats + vue Sync si visible
  try {
    if(typeof updateSyncStats==='function'){
      const selected = allTracks.filter(x=>syncSel.has(x.path));
      console.log('[togglePlayingSync] allTracks match:', selected.length, '/', syncSel.size);
      updateSyncStats(selected);
    }
    // Toujours rafraîchir la vue Sync (même si cachée) pour qu'elle soit à jour au prochain affichage
    if(typeof renderSyncQueue==='function'){
      renderSyncQueue();
    }
    if(typeof renderVirtual==='function') renderVirtual();
  } catch(e){ console.error('[togglePlayingSync]', e); }
  // Persister sur disque
  if(typeof scheduleSyncSave==='function') scheduleSyncSave();
}
// ── FAVORI du morceau en cours depuis le player/fullscreen ─────
// Patch N.4 : toggle favori du morceau en cours et maj UI sur les deux players
function togglePlayingFavorite(){
  const t = queue[qi];
  if(!t || !t.path){ toast('Aucun morceau'); return; }
  // Cherche le track dans allTracks (la queue est une copie, on toggle sur la source)
  const srcTrack = allTracks.find(x => x.path === t.path) || t;
  if(typeof toggleTrackFavorite === 'function'){
    toggleTrackFavorite(srcTrack);
    // Synchronise le bool sur la queue aussi (pour que _fsRefresh affiche bien à jour)
    t.isFavorite = srcTrack.isFavorite;
  }
  updatePlayingFavoriteUI();
}

// Maj visuelle des deux boutons favori (player + fullscreen) selon le morceau courant
function updatePlayingFavoriteUI(){
  const t = queue[qi];
  // Source de vérité : allTracks (le toggle a écrit dedans)
  const srcTrack = t && t.path ? allTracks.find(x => x.path === t.path) : null;
  const isFav = !!(srcTrack && srcTrack.isFavorite);

  // Player de droite
  const pBtn = document.getElementById('pcFavNow');
  const pIcon = document.getElementById('pcFavIcon');
  if(pBtn){
    pBtn.classList.toggle('on', isFav);
    pBtn.title = isFav ? '★ Favori — clic pour retirer' : 'Marquer comme favori';
  }
  if(pIcon) pIcon.textContent = isFav ? '★' : '☆';

  // Fullscreen
  const fsBtn = document.getElementById('fsFavBtn');
  const fsIcon = document.getElementById('fsFavIcon');
  if(fsBtn){
    fsBtn.classList.toggle('on', isFav);
    fsBtn.title = isFav ? '★ Favori — clic pour retirer' : 'Marquer comme favori';
  }
  if(fsIcon) fsIcon.textContent = isFav ? '★' : '☆';
}
// ── RACCOURCIS CLAVIER (lecture) ─────────────────────────────────────────────
// Défauts : Espace = lecture/pause, Cmd/Ctrl+→ = suivant, Cmd/Ctrl+← = précédent.
// Personnalisables (persistés en localStorage) via openKeysSettings().
// Les touches MÉDIA du clavier (⏯ ⏭ ⏮) marchent partout, même app en arrière-plan
// (enregistrées côté main, reçues via le canal 'media-key').
const _WT_KEYS_DEFAULT = { play: 'Space', next: 'Meta+ArrowRight', prev: 'Meta+ArrowLeft' };
let _wtKeys = Object.assign({}, _WT_KEYS_DEFAULT);
try { Object.assign(_wtKeys, JSON.parse(localStorage.getItem('wtKeys') || '{}')); } catch(e) {}

function _wtComboOf(e){
  const parts = [];
  if (e.metaKey) parts.push('Meta');
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  const k = e.code === 'Space' ? 'Space' : (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  parts.push(k);
  return parts.join('+');
}
function _wtKeyLabel(combo){
  return String(combo || '').replace('Meta', '⌘').replace('Ctrl', '⌃').replace('Alt', '⌥').replace('Shift', '⇧')
    .replace('ArrowRight', '→').replace('ArrowLeft', '←').replace('ArrowUp', '↑').replace('ArrowDown', '↓')
    .replace('Space', 'Espace');
}
document.addEventListener('keydown', (e) => {
  // Jamais pendant une saisie, ni quand une modale/le fullscreen gèrent déjà le clavier
  const tg = e.target;
  if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.isContentEditable)) return;
  if (typeof _fsActive !== 'undefined' && _fsActive) return; // le fullscreen a ses propres touches
  const bo = document.getElementById('batchOv');
  if (bo && bo.classList.contains('on')) return;
  const combo = _wtComboOf(e);
  if (combo === _wtKeys.play) { e.preventDefault(); if (typeof togglePlay === 'function') togglePlay(); }
  else if (combo === _wtKeys.next) { e.preventDefault(); if (typeof nextTrack === 'function') nextTrack(); }
  else if (combo === _wtKeys.prev) { e.preventDefault(); if (typeof prevTrack === 'function') prevTrack(); }
});

// MediaSession (Chromium natif) : touches média ⏯ ⏭ ⏮ ET widget « En lecture »
// macOS, SANS permission d'accessibilité (globalShortcut peut échouer sur macOS
// récent). Métadonnées mises à jour au changement de piste (_notifyNowPlaying).
if ('mediaSession' in navigator) {
  try {
    navigator.mediaSession.setActionHandler('play', () => { if (au.paused && typeof togglePlay === 'function') togglePlay(); });
    navigator.mediaSession.setActionHandler('pause', () => { if (!au.paused && typeof togglePlay === 'function') togglePlay(); });
    navigator.mediaSession.setActionHandler('nexttrack', () => { if (typeof nextTrack === 'function') nextTrack(); });
    navigator.mediaSession.setActionHandler('previoustrack', () => { if (typeof prevTrack === 'function') prevTrack(); });
  } catch(e) { console.warn('[mediaSession] handlers:', e && e.message); }
}
function _updateMediaSession(t){
  if (!('mediaSession' in navigator) || !t) return;
  try {
    const art = [];
    const cov = t._art || t.cover || null;
    if (cov && /^https?:/.test(cov)) art.push({ src: cov, sizes: '512x512', type: 'image/jpeg' });
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title || t.path.split('/').pop(),
      artist: t.artist || '',
      album: t.album || '',
      artwork: art
    });
  } catch(e) {}
}

// Touches média système (relayées par le process main)
if (window.wt && window.wt.on) {
  window.wt.on('media-key', (action) => {
    if (action === 'play') { if (typeof togglePlay === 'function') togglePlay(); }
    else if (action === 'next') { if (typeof nextTrack === 'function') nextTrack(); }
    else if (action === 'prev') { if (typeof prevTrack === 'function') prevTrack(); }
  });
}

// Mini-panneau de personnalisation (réutilise .batch-ov/.batch-box)
function openKeysSettings(){
  let ov = document.getElementById('keysOv');
  if (!ov) {
    ov = document.createElement('div');
    ov.className = 'batch-ov';
    ov.id = 'keysOv';
    ov.innerHTML =
      '<div class="batch-box" style="width:380px">'
      + '<div class="batch-hd"><span style="font-weight:700">Raccourcis clavier</span>'
      + '<button class="batch-btn" onclick="document.getElementById(\'keysOv\').classList.remove(\'on\')">Fermer</button></div>'
      + '<div class="batch-body" id="keysBody"></div>'
      + '<div class="batch-ft"><span style="font-size:10px;color:var(--t3)">Les touches média du clavier (lecture/pause, suivant, précédent) fonctionnent toujours, même app en arrière-plan.</span>'
      + '<button class="batch-btn" onclick="_wtKeysReset()">Défauts</button></div>'
      + '</div>';
    document.body.appendChild(ov);
  }
  _wtKeysRender();
  ov.classList.add('on');
}
function _wtKeysRender(){
  const body = document.getElementById('keysBody');
  if (!body) return;
  const rows = [['play', 'Lecture / Pause'], ['next', 'Morceau suivant'], ['prev', 'Morceau précédent']];
  body.innerHTML = rows.map(([k, label]) =>
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px">'
    + '<span style="font-size:12px">' + label + '</span>'
    + '<button class="batch-btn" style="min-width:110px;font-family:var(--font-mono)" onclick="_wtKeyCapture(\'' + k + '\', this)">'
    + _wtKeyLabel(_wtKeys[k]) + '</button></div>'
  ).join('');
}
function _wtKeyCapture(which, btn){
  btn.textContent = 'Appuie sur une touche…';
  const handler = (e) => {
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { document.removeEventListener('keydown', handler, true); _wtKeysRender(); return; }
    if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return; // attendre la vraie touche
    _wtKeys[which] = _wtComboOf(e);
    try { localStorage.setItem('wtKeys', JSON.stringify(_wtKeys)); } catch(err) {}
    document.removeEventListener('keydown', handler, true);
    _wtKeysRender();
    if (typeof toast === 'function') toast('Raccourci enregistré : ' + _wtKeyLabel(_wtKeys[which]));
  };
  document.addEventListener('keydown', handler, true);
}
function _wtKeysReset(){
  _wtKeys = Object.assign({}, _WT_KEYS_DEFAULT);
  try { localStorage.setItem('wtKeys', JSON.stringify(_wtKeys)); } catch(e) {}
  _wtKeysRender();
}

// ── NOTIFICATION « lecture en cours » (façon iTunes) ────────────────────────
// Notif macOS discrète (titre — artiste · album) à chaque changement de morceau,
// seulement quand la fenêtre n'est PAS au premier plan (sinon on la voit déjà).
// Désactivable : localStorage wtNotifyTrack = '0'.
function _notifyNowPlaying(t){
  try {
    if (!t || localStorage.getItem('wtNotifyTrack') === '0') return;
    if (typeof document !== 'undefined' && document.hasFocus && document.hasFocus()) return;
    if (window.wt && window.wt.notifyTrack) {
      window.wt.notifyTrack({
        title: t.title || t.path.split('/').pop(),
        body: (t.artist || 'Artiste inconnu') + (t.album ? ' — ' + t.album : '')
      });
    }
  } catch(e) {}
}

// Maj visuelle du bouton SYNC du miniplayer (allumé si le morceau courant est dans Sync)
function updatePlayingSyncUI(){
  const btn = document.getElementById('pcSyncNow');
  if(!btn) return;
  const t = queue[qi];
  const inSync = !!(t && t.path && syncSel.has(t.path));
  btn.classList.toggle('on', inSync);
  btn.title = inSync ? '✓ Morceau dans le Sync — clic pour retirer' : 'Ajouter ce morceau au Sync Smartphone';
}

// Transparence du play→auto : quand la vérification du MORCEAU EN COURS se
// termine, on le dit clairement (toast) et on rafraîchit l'affichage — l'user
// sait que la recherche a eu lieu et ce qu'elle a donné.
function _notifyPlayCheckResult(t, outcome){
  if (!t || !queue[qi] || queue[qi].path !== t.path) return;
  const name = t.title || t.path.split('/').pop();
  if (outcome === 'corrected' && t._autoFix) {
    const f = t._autoFix, bits = [];
    if (f.year  && f.year.to)  bits.push('année : ' + f.year.to);
    if (f.genre && f.genre.to) bits.push('genre : ' + f.genre.to);
    if (bits.length && typeof toast === 'function') toast(`✓ « ${name} » — ${bits.join(', ')}`);
  } else if (outcome === 'proposed') {
    if (typeof toast === 'function') toast(`« ${name} » — proposition à revoir (bouton Vérifier)`);
  } else if (outcome === 'refused' || outcome === 'empty') {
    if (typeof toast === 'function') toast(`« ${name} » — recherche effectuée, aucune info fiable trouvée`);
  }
  if (typeof _fsActive !== 'undefined' && _fsActive && typeof _fsRefresh === 'function') _fsRefresh();
  if (typeof _refreshPlayerOverlay === 'function') _refreshPlayerOverlay(t);
}
function updateRepeatUI(){
  const b=document.getElementById('pcRep');
  const mb=document.getElementById('miniRep');
  const fsb=document.getElementById('fsRepeatBtn');
  b.classList.toggle('on',repeat!=='none');
  if(mb) mb.classList.toggle('on',repeat!=='none');
  if(fsb) fsb.classList.toggle('on',repeat!=='none');
  // Icône repeat-all : deux flèches qui se bouclent
  const svgAll=`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`;
  // Icône repeat-one : chiffre 1 dans une boucle
  const svgOne=`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><text x="11" y="14" font-size="7" font-weight="bold" fill="currentColor" stroke="none" text-anchor="middle">1</text></svg>`;
  // Icône fullscreen (plus grande)
  const svgAllFS=`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`;
  const svgOneFS=`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><text x="11" y="14" font-size="7" font-weight="bold" fill="currentColor" stroke="none" text-anchor="middle">1</text></svg>`;
  const icon = repeat==='one' ? svgOne : svgAll;
  const iconFS = repeat==='one' ? svgOneFS : svgAllFS;
  b.innerHTML=icon;
  if(mb) mb.innerHTML=icon;
  if(fsb) fsb.innerHTML=iconFS;
  // Label tooltip clair
  const label=repeat==='none'?'Répéter : désactivé':repeat==='all'?'Répéter : tous':'Répéter : ce morceau';
  b.title=label;
  if(mb) mb.title=label;
  if(fsb) fsb.title=label;
}
au.addEventListener('play',()=>{
  const pi=document.getElementById('playIcon');
  if(pi) pi.innerHTML='<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
  const pcPl=document.getElementById('pcPl');
  if(pcPl) pcPl.classList.add('playing');
  const mi=document.getElementById('miniPlayIcon');
  if(mi) mi.innerHTML='<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
  const md=document.getElementById('miniDisc');
  if(md) md.classList.add('playing');
  const fsPl=document.getElementById('fsPlayIcon');
  if(fsPl) fsPl.innerHTML='<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
});
au.addEventListener('pause',()=>{
  const pi=document.getElementById('playIcon');
  if(pi) pi.innerHTML='<polygon points="5 3 19 12 5 21 5 3"/>';
  const pcPl=document.getElementById('pcPl');
  if(pcPl) pcPl.classList.remove('playing');
  const mi=document.getElementById('miniPlayIcon');
  if(mi) mi.innerHTML='<polygon points="5 3 19 12 5 21 5 3"/>';
  const md=document.getElementById('miniDisc');
  if(md) md.classList.remove('playing');
  const fsPl=document.getElementById('fsPlayIcon');
  if(fsPl) fsPl.innerHTML='<polygon points="6 3 20 12 6 21 6 3"/>';
});
au.addEventListener('ended',()=>{
  if(_sleepEndOfTrack){
    _sleepTracksLeft = Math.max(0, _sleepTracksLeft - 1);
    if(_sleepTracksLeft <= 0){
      _sleepEndOfTrack = false; _sleepChosen = 0; _refreshSleepBtn();
      if(typeof toast === 'function') toast('Veille : lecture arrêtée');
      return; // on ne lance PAS le morceau suivant
    }
    _refreshSleepBtn(); // décompte visible sur la lune, la lecture continue
  }
  if(repeat==='one'){au.currentTime=0;au.play();}else nextTrack();
});
// ── WEB AUDIO EQ ──────────────────────────────────
let audioCtx=null, sourceNode=null, bassFilter=null, midFilter=null, trebleFilter=null, analyserNode=null, masterGain=null;

function initAudioGraph(){
  if(!audioCtx){
    audioCtx=new (window.AudioContext||window.webkitAudioContext)();
    bassFilter=audioCtx.createBiquadFilter();
    midFilter=audioCtx.createBiquadFilter();
    trebleFilter=audioCtx.createBiquadFilter();
    bassFilter.type='lowshelf';    bassFilter.frequency.value=80;    bassFilter.gain.value=EQ_VALS[0];
    midFilter.type='peaking';      midFilter.frequency.value=1000;   midFilter.gain.value=EQ_VALS[1]; midFilter.Q.value=1;
    trebleFilter.type='highshelf'; trebleFilter.frequency.value=10000; trebleFilter.gain.value=EQ_VALS[2];
  }
  // ✅ Singleton strict : createMediaElementSource ne peut être appelé
  // qu'UNE seule fois par élément <audio>. L'ancien garde
  // `if(sourceNode && !sourceNode._wtConnected)` ne se déclenchait jamais
  // (sourceNode démarre à null) — la chaîne EQ n'était en réalité jamais
  // branchée. Corrigé : création au premier appel, puis chaîne
  // source → EQ → analyser → destination (le son reste intact).
  if(!sourceNode){
    sourceNode=audioCtx.createMediaElementSource(au);
    if(!analyserNode){
      analyserNode=audioCtx.createAnalyser();
      analyserNode.fftSize=256;
      analyserNode.smoothingTimeConstant=0.8;
    }
    // C201 : GAIN MAÎTRE en bout de chaîne. Une fois l'élément capturé par
    // createMediaElementSource, au.volume devient non fiable selon les
    // versions de Chromium — le volume pilote donc ce GainNode, et
    // au.volume est figé à 1 (une seule autorité, pas de double atténuation).
    masterGain=audioCtx.createGain();
    masterGain.gain.value=(typeof muted!=='undefined'&&muted)?0:(typeof vol!=='undefined'?vol:1);
    sourceNode.connect(bassFilter);
    bassFilter.connect(midFilter);
    midFilter.connect(trebleFilter);
    trebleFilter.connect(analyserNode);
    analyserNode.connect(masterGain);
    masterGain.connect(audioCtx.destination);
    au.volume=1;
    sourceNode._wtConnected=true;
  }
  // Autoplay policy : le contexte peut naître en état "suspended" —
  // sans resume(), l'audio routé par Web Audio serait muet.
  if(audioCtx.state==='suspended'){ try{ audioCtx.resume(); }catch(e){} }
}
// ── VISUALISEUR D'ONDES FULLSCREEN (C186-C190) ───────────────
// AnalyserNode greffé sur la chaîne EQ existante (singleton), rendu
// canvas 56 barres teintées par le genre courant. Actif uniquement en
// fullscreen ET en lecture (zéro CPU sinon). Fallback silencieux : en
// cas d'échec Web Audio ou de signal muet (~2 s de lecture sans
// données, source non analysable), on ré-affiche les 5 barres
// décoratives d'origine via la classe viz-on sur .fs-art-wrap.
const _fsViz = { raf:0, data:null, failed:false, zeroFrames:0 };

function _fsVizStart(){
  if(_fsViz.failed) return;
  const cv=document.getElementById('fsViz');
  const wrap=document.querySelector('.fs-art-wrap');
  if(!cv||!wrap) return;
  try{
    initAudioGraph();
    if(!analyserNode) throw new Error('no analyser');
    if(audioCtx && audioCtx.state==='suspended') audioCtx.resume();
    if(!_fsViz.data) _fsViz.data=new Uint8Array(analyserNode.frequencyBinCount);
  }catch(e){
    _fsViz.failed=true;
    wrap.classList.remove('viz-on');
    return;
  }
  wrap.classList.add('viz-on');
  if(_fsViz.raf) return; // boucle déjà planifiée
  const ctx=cv.getContext('2d');
  const frame=()=>{
    _fsViz.raf=0;
    if(!_fsActive) return;
    // Dimensionnement Retina (no-op si inchangé)
    const dpr=window.devicePixelRatio||1;
    const W=cv.offsetWidth||180, H=cv.offsetHeight||40;
    if(cv.width!==Math.round(W*dpr)||cv.height!==Math.round(H*dpr)){
      cv.width=Math.round(W*dpr); cv.height=Math.round(H*dpr);
    }
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,W,H);
    // C198 : 3 ondes ENTRELACÉES (graves / médiums / aigus) — sinusoïdes
    // dont l'amplitude et la vitesse suivent l'énergie réelle de chaque
    // bande du spectre, avec lissage inter-frames (15 %/frame) : mouvement
    // fluide façon logo, plus de nervosité oscilloscope.
    analyserNode.getByteFrequencyData(_fsViz.data);
    let sum=0; for(let i=0;i<_fsViz.data.length;i++) sum+=_fsViz.data[i];
    if(sum>0) _fsViz.proven=true;
    // Fallback vers les barres décoratives UNIQUEMENT si la source ne
    // produit JAMAIS de signal (~5 s) : un vrai silence (intro, blanc
    // entre morceaux) ne doit pas déclasser le visualiseur (le bug du
    // « retour aux barres » venait de là).
    if(!au.paused && sum===0 && !_fsViz.proven){
      if(++_fsViz.zeroFrames>300){
        _fsViz.failed=true;
        wrap.classList.remove('viz-on');
        return;
      }
    } else { _fsViz.zeroFrames=0; }
    // Hue du genre courant (lookup direct dans _GENRE_COLOR_MAP)
    const g=(queue[qi]&&queue[qi].genre)||'';
    const col=(typeof getGenreColor==='function')?getGenreColor(g):'#C85A45';
    // Énergie par bande (128 bins · fftSize 256) :
    // graves 0-7, médiums 8-39, aigus 40-95.
    const _band=(a,b)=>{let s2=0;for(let i=a;i<b;i++)s2+=_fsViz.data[i];return s2/((b-a)*255);};
    const eng=[_band(0,8), _band(8,40), _band(40,96)];
    if(!_fsViz.amp) _fsViz.amp=[0,0,0];
    if(!_fsViz.ph)  _fsViz.ph =[0,2.1,4.2];
    // C200 : normalisation ADAPTATIVE par bande. L'énergie brute d'un
    // morceau masterisé fort reste écrasée en haut de plage → les ondes
    // paraissaient figées. On suit un plancher et un plafond GLISSANTS
    // par bande et on étire le signal entre les deux : les ondes suivent
    // la dynamique RELATIVE du morceau (le beat se voit vraiment).
    if(!_fsViz.lo) _fsViz.lo=[1,1,1];
    if(!_fsViz.hi) _fsViz.hi=[0,0,0];
    const cy=H/2;
    const LAYERS=[
      {k:0, cycles:1.5, alpha:0.85, lw:2.0, gain:1.00}, // graves : onde longue, trait fort
      {k:1, cycles:2.5, alpha:0.50, lw:1.4, gain:0.85}, // médiums
      {k:2, cycles:4.0, alpha:0.30, lw:1.0, gain:0.70}, // aigus : onde courte, trait fin
    ];
    for(const L of LAYERS){
      // C200 : plafond qui décroît lentement, plancher qui remonte lentement
      // → fenêtre dynamique auto-calibrée sur les dernières secondes.
      const e=eng[L.k];
      _fsViz.hi[L.k]=Math.max(e,_fsViz.hi[L.k]*0.995);
      _fsViz.lo[L.k]=Math.min(e,_fsViz.lo[L.k]+0.0015);
      const span=Math.max(0.05,_fsViz.hi[L.k]-_fsViz.lo[L.k]);
      const rel=Math.max(0,Math.min(1,(e-_fsViz.lo[L.k])/span));
      // Attaque rapide (35 %/frame), retombée douce (8 %) : le beat frappe,
      // le calme retombe en douceur.
      const rate=rel>_fsViz.amp[L.k]?0.35:0.08;
      _fsViz.amp[L.k]+=(rel-_fsViz.amp[L.k])*rate;
      _fsViz.ph[L.k]+=0.02+_fsViz.amp[L.k]*0.10;           // vitesse ∝ énergie
      // 12 % d'amplitude de base : l'onde ne s'aplatit jamais totalement.
      const A=(0.12+0.88*_fsViz.amp[L.k])*cy*0.85*L.gain;
      ctx.beginPath();
      ctx.strokeStyle=col;
      ctx.globalAlpha=L.alpha;
      ctx.lineWidth=L.lw;
      ctx.lineCap='round';
      for(let x=0;x<=W;x+=3){
        const y=cy+Math.sin((x/W)*Math.PI*2*L.cycles+_fsViz.ph[L.k])*A;
        if(x===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha=1;
    // En pause : la boucle s'arrête, le dernier frame reste affiché
    // (atténué via .fs-overlay.paused .fs-viz).
    if(!au.paused) _fsViz.raf=requestAnimationFrame(frame);
  };
  _fsViz.raf=requestAnimationFrame(frame);
}

function _fsVizStop(){
  if(_fsViz.raf){ cancelAnimationFrame(_fsViz.raf); _fsViz.raf=0; }
}

// Reprise/arrêt de la boucle au fil de la lecture. Le resume() défensif
// couvre le cas où le graphe a été créé hors geste utilisateur.
au.addEventListener('play',()=>{
  if(audioCtx && audioCtx.state==='suspended'){ try{ audioCtx.resume(); }catch(e){} }
  if(typeof _fsActive!=='undefined' && _fsActive) _fsVizStart();
});
au.addEventListener('pause',()=>{ _fsVizStop(); });

// ── EQ + QUEUE FLOAT WINDOWS + SINE WAVE ─────────────────────
let _dockWaveRunning=false;

function startDockWave(canvasId){
  const cv=document.getElementById(canvasId); if(!cv) return;
  _dockWaveRunning=true;
  const ctx=cv.getContext('2d');
  let t=0;
  const frame=()=>{
    if(!document.getElementById(canvasId)) return; // canvas removed
    const W=cv.offsetWidth||250, H=cv.offsetHeight||36;
    if(cv.width!==W||cv.height!==H){cv.width=W;cv.height=H;}
    ctx.clearRect(0,0,W,H);
    const cy=H/2;
    const playing=!au.paused;
    const b=parseFloat(document.getElementById('eqBass')?.value||0)/12;
    const m=parseFloat(document.getElementById('eqMid')?.value||0)/12;
    const tr=parseFloat(document.getElementById('eqTreble')?.value||0)/12;
    // 3 sine waves layered — like the Wave Tune logo
    [
      {amp:.40,freq:2.1,phase:0,   alpha:.75,w:1.8,eq:b},
      {amp:.25,freq:3.7,phase:1.05,alpha:.45,w:1.2,eq:m},
      {amp:.15,freq:5.3,phase:-.7, alpha:.28,w:.9, eq:tr},
    ].forEach(({amp,freq,phase,alpha,w,eq})=>{
      const liveAmp=(playing?(amp+Math.abs(eq)*.35):amp*.3)*cy;
      ctx.beginPath();
      ctx.strokeStyle=`rgba(200,90,69,${playing?alpha:alpha*.4})`;
      ctx.lineWidth=w; ctx.lineCap='round'; ctx.lineJoin='round';
      for(let x=0;x<=W;x+=2){
        const p=x/W;
        const y=cy+Math.sin(p*Math.PI*2*freq+t+phase)*liveAmp*(0.65+Math.sin(p*Math.PI)*.35);
        x===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
      }
      ctx.stroke();
    });
    t+=playing?.05:.018;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ── EQ HORIZONTAL FADER SYSTEM (identical to miniplayer) ──
const EQ_VALS=[0,0,0]; // bass, mid, treble

function eqToPos(v){return(v+12)/24;}
function posToEq(p){return Math.max(-12,Math.min(12,Math.round((p*24-12)*2)/2));}

const DOCK_EQ_IDS=[
  {fillId:'eqFillEl0',valId:'eqBassVal',  inputId:'eqBass'},
  {fillId:'eqFillEl1',valId:'eqMidVal',   inputId:'eqMid'},
  {fillId:'eqFillEl2',valId:'eqTrebleVal',inputId:'eqTreble'},
];

// APRÈS — version corrigée
function setDockEQBand(idx, val, skipSync=false){
  EQ_VALS[idx] = val;
  const pos = eqToPos(val);
  const pct = (pos * 100) + '%';
  const color = val !== 0 ? '#C85A45' : 'rgba(255,255,255,.06)';
  const ids = DOCK_EQ_IDS[idx];
  const f = document.getElementById(ids.fillId);
  if(f){ f.style.width = pct; f.style.background = color; }
  const lbl = document.getElementById(ids.valId);
  if(lbl) lbl.textContent = val > 0 ? '+' + val : String(val);
  const inp = document.getElementById(ids.inputId);
  if(inp) inp.value = val;

  // ✅ FIX 1 : initialiser le graphe audio si pas encore fait
  // (au lieu d'abandonner silencieusement)
  if(!audioCtx) initAudioGraph();

  // Appliquer le gain — les filtres existent maintenant
  if(idx === 0 && bassFilter)    bassFilter.gain.value = val;
  if(idx === 1 && midFilter)     midFilter.gain.value  = val;
  if(idx === 2 && trebleFilter)  trebleFilter.gain.value = val;
}

function makeDragEQ(faderId, trackId, idx){
  const fader=document.getElementById(faderId);
  if(!fader) return;
  let down=false;
  function calc(e){
    const track=document.getElementById(trackId);
    if(!track) return 0.5;
    const r=track.getBoundingClientRect();
    if(r.width===0) return 0.5;
    return Math.max(0,Math.min(1,(e.clientX-r.left)/r.width));
  }
  fader.addEventListener('mousedown',e=>{
    down=true;
    if(!audioCtx) initAudioGraph();
    setDockEQBand(idx,posToEq(calc(e)));
    e.preventDefault();
  });
  document.addEventListener('mousemove',e=>{
    if(down) requestAnimationFrame(()=>setDockEQBand(idx,posToEq(calc(e))));
  });
  document.addEventListener('mouseup',()=>{down=false;});
}

function initDockEQDrags(){
  makeDragEQ('eqFader0','eqTrack0',0);
  makeDragEQ('eqFader1','eqTrack1',1);
  makeDragEQ('eqFader2','eqTrack2',2);
}
// Init EQ drags après rendu
document.addEventListener('DOMContentLoaded',()=>{ initDockEQDrags(); });
// Render miniplayer queue shell as soon as DOM is ready (before boot finishes)
document.addEventListener('DOMContentLoaded',()=>{
  if(typeof renderMiniQueue==='function') renderMiniQueue();
});

function applyEQ(){
  // Called by old code — bridge to new system
  if(!audioCtx) initAudioGraph();
  const b=parseFloat(document.getElementById('eqBass')?.value||0);
  const m=parseFloat(document.getElementById('eqMid')?.value||0);
  const t=parseFloat(document.getElementById('eqTreble')?.value||0);
  setDockEQBand(0,b); setDockEQBand(1,m); setDockEQBand(2,t);
}

function resetEQ(){
  [0,1,2].forEach(i=>setDockEQBand(i,0));
  if(bassFilter) bassFilter.gain.value=0;
  if(midFilter)  midFilter.gain.value=0;
  if(trebleFilter)trebleFilter.gain.value=0;
  }

function toggleEQ(){
  const p=document.getElementById('eqPanel');
  const b=document.getElementById('eqToggleBtn');
  const visible=p.style.display!=='none';
  p.style.display=visible?'none':'block';
  b.classList.toggle('on',!visible);
  if(!visible&&!audioCtx) initAudioGraph();
// ── EQ + QUEUE FLOAT WINDOWS ────────────────────────

}

function renderDockQueue(){
  const list=document.getElementById('dockQueueList');
  if(!list) return;
  const cntEl=document.getElementById('dockQueueCount');
  // dockQueueList est conservé pour compat, mais l'UI dock a été retirée.
  // Si dockQueueCount n'existe pas, on sort proprement — la vraie queue
  // visible est rendue par renderMiniQueue().
  if(!cntEl) return;
  if(!queue.length){
    cntEl.textContent='0 morceaux';
    list.innerHTML='<div class="dock-queue-empty">Lance un morceau pour commencer</div>';
    return;
  }

  // Build ordered upcoming list — shuffle shows TRUE future order
  const items=[];
  if(shuffle){
    // Next track first
    if(nextQueueIdx>=0) items.push({t:queue[nextQueueIdx],idx:nextQueueIdx,label:'Suivant'});
    // Remaining in deterministic shuffled order (stable between renders, seeded by qi)
    const others=[];
    queue.forEach((_,i)=>{if(i!==qi&&i!==nextQueueIdx) others.push(i);});
    // Seeded Fisher-Yates-like stable sort
    const seed=qi*31+queue.length;
    for(let k=0;k<others.length;k++){
      const j=(k+seed)%others.length;
      [others[k],others[j]]=[others[j],others[k]];
    }
    others.forEach(idx=>items.push({t:queue[idx],idx,label:''}));
  } else {
    for(let k=1;k<queue.length;k++){
      const i=(qi+k)%queue.length;
      if(i===qi) break;
      items.push({t:queue[i],idx:i,label:k===1?'Suivant':''});
      if(i<qi && repeat!=='all') break;
    }
  }

  cntEl.textContent=`${items.length} morceau${items.length!==1?'x':''} à venir`;
  if(!items.length){
    list.innerHTML='<div class="dock-queue-empty">Dernier morceau en lecture</div>';
    return;
  }
  list.innerHTML=items.map((item,pos)=>`
    <div class="dq-item${item.label==='Suivant'?' active':''}"
         draggable="true" data-qidx="${item.idx}" data-pos="${pos}"
         onclick="playIdx(${item.idx})" ondblclick="playIdx(${item.idx})">
      <div class="dq-drag">⠿</div>
      <div class="dq-num">${item.label==='Suivant'?'▷':pos+1}</div>
      <div class="dq-info">
        <div class="dq-title">${esc(item.t.title)}</div>
        <div class="dq-artist">${esc(item.t.artist||'')}${item.t.album?` <span style="color:#757570;font-family:'Courier Prime',monospace;font-size:8px;letter-spacing:.01em">[${esc(_displayAlbum(item.t.album))}]</span>`:''}</div>
      </div>
      <div class="dq-rm" title="Retirer" onclick="dockRmQ(${item.idx},event)">
        <svg width="8" height="8" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="1" y1="1" x2="13" y2="13"/><line x1="13" y1="1" x2="1" y2="13"/></svg>
      </div>
    </div>`).join('');
  attachDockQueueDrag(list);
  
}

function dockRmQ(qidx,ev){
  if(ev && ev.stopPropagation) ev.stopPropagation();
  if(qidx<0||qidx>=queue.length) return;
  queue.splice(qidx,1);
  if(qi>qidx) qi--;
  // Recaler les index qui pointent dans queue, sinon ils désignent le mauvais
  // morceau après le décalage (→ "le suivant de la liste normale" remonte au lieu
  // du bon, surtout en aléatoire). Même correctif que « Lire après ».
  if(Array.isArray(_shuffleOrder))
    _shuffleOrder = _shuffleOrder.filter(i => i !== qidx).map(i => i > qidx ? i - 1 : i);
  if(Array.isArray(playbackHistory))
    playbackHistory = playbackHistory.filter(i => i !== qidx).map(i => i > qidx ? i - 1 : i);
  renderDockQueue();     // gardé pour compatibilité
  renderMiniQueue();     // met à jour la mini‑queue du panneau de droite
  if(typeof _fsActive !== 'undefined' && _fsActive && typeof _fsRenderQueue === 'function'){
    _fsRenderQueue();    // met à jour la file d'attente en plein écran
  }
}

function attachDockQueueDrag(list){
  let dragQIdx=-1;
  list.querySelectorAll('.dq-item[draggable]').forEach(row=>{
    row.addEventListener('dragstart',e=>{
      dragQIdx=parseInt(row.dataset.qidx??-1);
      row.style.opacity='.4';
      e.dataTransfer.effectAllowed='move';
    });
    row.addEventListener('dragend',()=>{row.style.opacity='';dragQIdx=-1;});
    row.addEventListener('dragover',e=>{e.preventDefault();row.classList.add('drag-over');});
    row.addEventListener('dragleave',()=>row.classList.remove('drag-over'));
    row.addEventListener('drop',e=>{
      e.preventDefault(); row.classList.remove('drag-over');
      const toIdx=parseInt(row.dataset.qidx??-1);
      if(dragQIdx<0||toIdx<0||dragQIdx===toIdx) return;
      const from=dragQIdx;
      dragQIdx=-1;
      requestAnimationFrame(()=>{
        const moved=queue.splice(from,1)[0];
        const dest=from<toIdx?toIdx-1:toIdx;
        queue.splice(dest,0,moved);
        if(qi===from) qi=dest;
        else if(from<qi&&dest>=qi) qi--;
        else if(from>qi&&dest<=qi) qi++;
        renderDockQueue();
      });
    });
  });
}

// Recevoir commandes du mini player

// timeupdate — UI locale seulement, sync mini via timer séparé
au.addEventListener('timeupdate',()=>{
  if(!au.duration||seekDrag)return;
  const p=(au.currentTime/au.duration)*100;
  document.getElementById('seekFill').style.width=p+'%';
  document.getElementById('pCur').textContent=fmt(au.currentTime);
  document.getElementById('pDur').textContent=fmt(au.duration);
  // mini-player seek elements (still rendered in DOM)
  const msf=document.getElementById('miniSeekfill');
  if(msf) msf.style.width=p+'%';
  const mc=document.getElementById('miniCur'); if(mc) mc.textContent=fmt(au.currentTime);
  const md=document.getElementById('miniDur'); if(md) md.textContent=fmt(au.duration);
});
const seekBar=document.getElementById('seekBar');
let _seekRaf=false;
const doSeek=e=>{
  if(!au.duration)return;
  const r=seekBar.getBoundingClientRect();
  const ratio=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width));
  au.currentTime=ratio*au.duration;
  // Immediate visual feedback
  document.getElementById('seekFill').style.width=(ratio*100)+'%';
  document.getElementById('pCur').textContent=fmt(au.currentTime);
};
seekBar.addEventListener('mousedown',e=>{seekDrag=true;doSeek(e);e.preventDefault();});
document.addEventListener('mousemove',e=>{
  if(!seekDrag)return;
  if(!_seekRaf){_seekRaf=true;requestAnimationFrame(()=>{doSeek(e);_seekRaf=false;});}
});
document.addEventListener('mouseup',()=>{seekDrag=false; syncDragging=false;});
// Volume — drag smooth
let volDrag=false;
// C201 : point de sortie UNIQUE du volume. Graphe Web Audio actif →
// masterGain (au.volume figé à 1) ; sinon → au.volume classique.
function _applyVolumeOut(){
  const v = muted ? 0 : vol;
  if (masterGain) { masterGain.gain.value = v; au.volume = 1; }
  else au.volume = v;
}
function _setVolFromRatio(ratio){
  vol=Math.max(0,Math.min(1,ratio)); muted=false;
  _applyVolumeOut();
  const vf=document.getElementById('vfill');
  if(vf) vf.style.width=(vol*100)+'%';
  const ff=document.getElementById('fsVolFill');
  if(ff) ff.style.width=(vol*100)+'%';
  updVI();
}
function applyVol(e){
  const r=document.getElementById('vtrack').getBoundingClientRect();
  if(!r.width) return;
  _setVolFromRatio((e.clientX-r.left)/r.width);
}
document.getElementById('vfader').addEventListener('mousedown',e=>{volDrag=true;applyVol(e);e.preventDefault();});
document.addEventListener('mousemove',e=>{if(volDrag)applyVol(e);});
document.addEventListener('mouseup',()=>{volDrag=false;});
// C202 : fader volume du FULLSCREEN — même moteur (_setVolFromRatio), autre piste
let _fsVolDrag=false;
function _fsApplyVol(e){
  const tr=document.querySelector('#fsVolFader .fs-vol-track');
  if(!tr) return;
  const r=tr.getBoundingClientRect();
  if(!r.width) return;
  _setVolFromRatio((e.clientX-r.left)/r.width);
}
(function(){
  const f=document.getElementById('fsVolFader');
  if(!f) return;
  f.addEventListener('mousedown',e=>{_fsVolDrag=true;_fsApplyVol(e);e.preventDefault();});
  document.addEventListener('mousemove',e=>{if(_fsVolDrag)_fsApplyVol(e);});
  document.addEventListener('mouseup',()=>{_fsVolDrag=false;});
})();
// Synchronise le remplissage du fader fullscreen (appelé à l'ouverture)
function _fsVolSync(){
  const ff=document.getElementById('fsVolFill');
  if(ff) ff.style.width=((muted?0:vol)*100)+'%';
}
function toggleMute(){
  if(muted){ muted=false; vol=prevVol; }
  else { prevVol=vol; muted=true; }
  _applyVolumeOut();                        // C201 : gain maître si graphe actif
  const _w=(muted?0:vol)*100+'%';
  const vf=document.getElementById('vfill');    if(vf) vf.style.width=_w;
  const ff=document.getElementById('fsVolFill');if(ff) ff.style.width=_w;
  updVI();
}
function updVI(){
  const el=document.getElementById('vi');
  if(muted||vol===0){
    el.innerHTML=`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`;
  } else if(vol<0.4){
    el.innerHTML=`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
  } else {
    el.innerHTML=`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
  }
}

// ── TITRE : marquee automatique si débordement ─────────────────────
function checkTitleOverflow(){
  // Titre principal
  const wrap  = document.querySelector('.p-title-wrap');
  const title = document.getElementById('pTitle');
  if(wrap && title){
    // Texte canonique (1 copie) : depuis le 1er segment s'il existe, sinon textContent.
    const _seg0 = title.querySelector('.p-mq-seg');
    const full  = _seg0 ? _seg0.textContent : (title.textContent || '');
    wrap.classList.remove('overflow');
    title.textContent = full;                       // repart d'1 copie pour mesurer
    requestAnimationFrame(()=>{
      const overflows = title.scrollWidth > wrap.clientWidth + 2;
      wrap.classList.toggle('overflow', overflows);
      if(overflows){
        // 2 copies identiques (gap intégré via CSS) → boucle SANS saut.
        const a = document.createElement('span'); a.className = 'p-mq-seg'; a.textContent = full;
        const b = a.cloneNode(true); b.setAttribute('aria-hidden','true');
        title.textContent = ''; title.append(a, b);
      }
    });
  }
  // Sub-titre (artiste · [album] · année)
  const subWrap = document.querySelector('.p-sub-wrap');
  const sub     = document.getElementById('pSub');
  if(subWrap && sub){
    subWrap.classList.remove('overflow');
    requestAnimationFrame(()=>{
      const overflows = sub.scrollWidth > subWrap.clientWidth + 2;
      subWrap.classList.toggle('overflow', overflows);
    });
  }
}
// Recheck on resize (le panel peut changer de largeur)
window.addEventListener('resize', () => {
  clearTimeout(window._ttoT);
  window._ttoT = setTimeout(checkTitleOverflow, 120);
});

// ── AUTO-FETCH : covers & metadata (genre/year) sur première lecture ─
// Les valeurs sont mises en cache dans customCovers (persistantes) + allTracks.
// Les modifications user (_userModified) ne sont JAMAIS écrasées.
const _autoFetchInFlight = new Set(); // éviter les doublons si on navigue vite

// ── Throttle global pour iTunes (18 req/min max pour éviter 403/429) ──
const _itunesQueue = [];
let _itunesProcessing = false;
const ITUNES_DELAY_MS = 3200; // 18 req/min ≈ safe

// Garde-fous anti-flood (la boucle 429 infinie de l'ancienne version) :
const ITUNES_MAX_TRIES        = 3;     // essais max par requête avant abandon
const ITUNES_BACKOFF_BASE_MS  = 30000; // 30 s, doublé à chaque 429 (30→60→120)
const ITUNES_BREAKER_THRESHOLD = 5;    // 429 consécutifs → on coupe iTunes pour la session
let _itunesConsecutive429 = 0;         // compteur pour le circuit breaker
let _itunesDisabled = false;           // true = source iTunes coupée (resolve(null) direct)

// Réarme iTunes (à appeler au début d'un run manuel : forceEnrich / Vérifier).
function resetItunesBreaker(){
  if(_itunesDisabled) console.info('[iTunes] breaker réarmé — source réactivée');
  _itunesDisabled = false;
  _itunesConsecutive429 = 0;
}

async function _itunesThrottled(url){
  // Circuit ouvert : on ne tente même plus le réseau, on rend null proprement.
  if(_itunesDisabled) return null;
  return new Promise((resolve, reject) => {
    _itunesQueue.push({ url, resolve, reject, tries: 0 });
    _processItunesQueue();
  });
}
async function _processItunesQueue(){
  if(_itunesProcessing) return;
  if(!_itunesQueue.length) return;
  _itunesProcessing = true;
  const item = _itunesQueue.shift();
  const { url, resolve, reject } = item;
  try {
    const r = await fetch(url);
    if(r.status === 403 || r.status === 429){
      _itunesConsecutive429++;
      // Trop de 429 d'affilée → iTunes nous bannit : on coupe la source pour la session.
      if(_itunesConsecutive429 >= ITUNES_BREAKER_THRESHOLD){
        console.warn(`[iTunes] ${_itunesConsecutive429} rate-limits consécutifs — source coupée pour la session (resetItunesBreaker pour réactiver)`);
        _itunesDisabled = true;
        // On vide la file en rendant null : plus aucune requête iTunes ne partira.
        resolve(null);
        while(_itunesQueue.length){ _itunesQueue.shift().resolve(null); }
        _itunesProcessing = false;
        return;
      }
      item.tries++;
      if(item.tries >= ITUNES_MAX_TRIES){
        // Cette requête a épuisé ses essais : on abandonne CET album (pas toute la file).
        console.warn(`[iTunes] abandon après ${item.tries} essais : ${decodeURIComponent(url)}`);
        resolve(null);
        setTimeout(() => { _itunesProcessing = false; _processItunesQueue(); }, ITUNES_DELAY_MS);
        return;
      }
      // Backoff exponentiel : 30 s, puis 60 s, puis 120 s.
      const wait = ITUNES_BACKOFF_BASE_MS * Math.pow(2, item.tries - 1);
      console.warn(`[iTunes] rate-limited (essai ${item.tries}/${ITUNES_MAX_TRIES}) — pause ${wait/1000}s`);
      _itunesQueue.unshift(item);
      setTimeout(() => { _itunesProcessing = false; _processItunesQueue(); }, wait);
      return;
    }
    // Succès réseau → on remet le compteur breaker à zéro.
    _itunesConsecutive429 = 0;
    const text = await r.text();
    if(!text || !text.trim()){ resolve(null); }
    else {
      try { resolve(JSON.parse(text)); } catch { resolve(null); }
    }
  } catch(e){ reject(e); }
  finally {
    setTimeout(() => { _itunesProcessing = false; _processItunesQueue(); }, ITUNES_DELAY_MS);
  }
}

// ── Fallback Deezer pour pochette (pas de rate-limit aussi strict) ──
async function _fetchDeezerArt(terms){
  try {
    const q = encodeURIComponent(terms);
    const r = await fetch(`https://api.deezer.com/search/album?q=${q}&limit=1&output=json`);
    const d = await r.json();
    const item = d.data?.[0];
    return item?.cover_xl || item?.cover_big || null;
  } catch { return null; }
}

// Nettoie un nom d'album pour la requête cover. Les tags de la bibliothèque
// enveloppent souvent TOUT le nom dans des crochets (« [Riot Act] (JP RETAIL) ») :
// l'ancien strip \[.*?\] effaçait alors l'album ENTIER → requête « Pearl Jam »
// seule → iTunes renvoyait l'album le plus vendu du groupe (MTV Unplugged) →
// mauvaise cover. On DÉBALLE au lieu d'effacer, et on ne retire que les suffixes.
function _coverQueryAlbum(raw){
  let a = String(raw || '').trim();
  if (!a) return '';
  a = a.replace(/\((?:[^)]*)\)\s*$/g, '').trim();           // suffixe « (JP RETAIL) », « (Deluxe) »…
  const unwrapped = a.replace(/^\[(.+)\]$/s, '$1').trim();   // « [Riot Act] » → « Riot Act »
  if (unwrapped) a = unwrapped;
  const stripped = a.replace(/\[.*?\]|\(.*?\)/g, '').trim(); // résidus internes
  return stripped || a.replace(/[\[\]()]/g, ' ').replace(/\s+/g, ' ').trim();
}

async function autoFetchArtwork(t){
  if(!t || !t.path) return;
  if(customCovers[t.path]) return; 
  // On a déjà cherché récemment sans rien trouver → on ne re-fetch pas.
  if(_hasFreshNoCover(t.path)) return;
  if(_autoFetchInFlight.has('art:'+t.path)) return;
  
  _autoFetchInFlight.add('art:'+t.path);
  
  try{
    const cleanAlbum = _coverQueryAlbum(t.album || t.title);
    // C207 : sur une VRAIE compilation multi-artistes, l'artiste de la piste
    // (« Aretha Franklin ») ne matchera JAMAIS l'artiste de l'album iTunes
    // (« Various Artists ») → le garde-fou _coverHit rejetait toutes les
    // pochettes de compilation. On retire alors l'artiste : la recherche et la
    // validation se font sur le seul nom d'album (le `!primaryArtist` ci-dessous
    // court-circuite le test d'artiste). Un best-of SOLO n'est pas concerné :
    // il garde sa contrainte d'artiste, sinon « Greatest Hits » nu ramènerait
    // la pochette d'un homonyme (cross-contamination).
    const _vaComp = (typeof isVariousArtistsAlbum === 'function') && isVariousArtistsAlbum(t);
    // Garde-fou universel : les tags pourris stockent plusieurs artistes avec
    // toutes sortes de séparateurs (" _ ", " / ", " & ", "feat.", "ft.", "vs",
    // "x", ","…). iTunes ne matche jamais ce genre de chaîne → 429 en boucle.
    // On ne garde que le PREMIER artiste, nettoyé.
    const primaryArtist = _vaComp ? '' : (t.artist || '')
      .split(/\s+(?:_|\/|\\|&|\+|·|•|;|,|vs\.?|x)\s+|\s+(?:feat|ft|featuring|avec|with)\.?\s+/i)[0]
      .replace(/[\[\](){}]/g, ' ')   // on jette les crochets/parenthèses résiduels
      .replace(/\s+/g, ' ')          // espaces multiples → simple
      .trim();
    const terms = [primaryArtist, cleanAlbum].filter(Boolean).join(' ');
    
    if(!terms.trim()) return;
    const q = encodeURIComponent(terms);

    let artUrl = null;
    
    try {
      // VALIDATION : on ne prend plus aveuglément results[0] — la cover doit
      // venir d'un album dont le NOM recoupe l'album demandé ET dont l'artiste
      // recoupe le tag (sinon « Pearl Jam » seul → cover du best-seller).
      const _coverHit = (list) => (list || []).find(r =>
        _albumMatches(cleanAlbum, r.collectionName || '') &&
        (!primaryArtist || _albumMatches(primaryArtist, r.artistName || '')));
      const d = await _itunesThrottled(`https://itunes.apple.com/search?term=${q}&limit=5&entity=album`);
      let _hit = _coverHit(d?.results);
      if(!_hit){
        const d2 = await _itunesThrottled(`https://itunes.apple.com/search?term=${q}&limit=5&entity=song`);
        _hit = _coverHit(d2?.results);
      }
      artUrl = _hit?.artworkUrl100?.replace('100x100bb','600x600bb');
      if(!artUrl && (d?.results?.length)) console.log(`[autoFetchArtwork] résultats iTunes rejetés (album/artiste sans rapport) pour « ${terms} »`);
    } catch(e) { }

   if(!artUrl) {
      artUrl = await _fetchDeezerArt(terms);
    }

    if(!artUrl){
      _markNoCover(t.path);   // échec des deux sources → on note, pas de re-fetch
      return;
    }

    customCovers[t.path] = artUrl;
    scheduleSave();

    // C208 : une pochette vaut pour TOUT l'album (hors compilation) — les
    // autres pistes du dossier l'héritent sans re-fetch iTunes/Deezer.
    if (typeof propagateAlbumMeta === 'function') propagateAlbumMeta(t, { cover: artUrl });

    // Patch B : propage la nouvelle cover vers le mobile si le morceau y est déjà
    schedulePropagateTrackUpdate(t);

    if(nowPath === t.path){
      updateArtDisplay(artUrl);
      if(typeof _refreshFullscreenArt === 'function') _refreshFullscreenArt();
    }
    
    // ✅ AJOUTÉ : mettre à jour l'éditeur si ouvert
    updateEditorCoverIfOpen(t.path, artUrl);
    
    scheduleUIRefresh();

  } catch(e) {
    console.warn('[autoFetchArtwork]', e);
  } finally {
    _autoFetchInFlight.delete('art:'+t.path);
  }
}

// Petite fonction pour regrouper les rafraîchissements d'image
let _uiRefreshTimer = null;
function scheduleUIRefresh() {
  clearTimeout(_uiRefreshTimer);
  _uiRefreshTimer = setTimeout(() => {
    // On ne redessine la liste que si l'utilisateur ne scrolle pas activement
    if(typeof renderVirtual === 'function') renderVirtual();
    if(typeof renderMiniQueue === 'function') renderMiniQueue();
  }, 300); // Attend 300ms que les autres images arrivent
}

async function autoFetchMeta(t){
  if(!t || !t.path) return;
  const track = allTracks.find(x=>x.path===t.path) || t;
  if(track._userModified) return;         // user edits sacrées
  if(track.genre && track.year) return;   // rien à compléter
  if(_autoFetchInFlight.has('meta:'+t.path)) return;
  _autoFetchInFlight.add('meta:'+t.path);
  try{
    if(!window.wt?.fetchOnlineMeta) return;
    const group = {
      album:  track.album  || '',
      artist: track.artist || '',
      paths:  [track.path]
    };
    const results = await window.wt.fetchOnlineMeta([group]);
    const meta = results?.[track.path];
    if(!meta) return;
    let changed = false;
    if(meta.genre && !track.genre){ track.genre = meta.genre; changed = true; }
    if(meta.year  && !track.year ){ track.year  = meta.year;  changed = true; }
    if(changed){
      // Synchroniser la copie dans queue
      const qIdx = queue.findIndex(q=>q.path===track.path);
      if(qIdx >= 0){
        if(meta.genre && !queue[qIdx].genre) queue[qIdx].genre = meta.genre;
        if(meta.year  && !queue[qIdx].year ) queue[qIdx].year  = meta.year;
      }
      // Rafraîchir l'affichage si c'est le morceau en cours
            if(nowPath === track.path && !track._userModified){
        refreshPlayerSub(track);
      }
      renderVirtual();
      scheduleMetaSave();
    }
  }catch(e){
    console.warn('[autoFetchMeta]', e);
  }finally{
    _autoFetchInFlight.delete('meta:'+t.path);
  }
}

function refreshPlayerSub(t){
  const _pSub = document.getElementById('pSub');
  if(!_pSub) return;
  const _pa = t.artist||'';
  _pSub.innerHTML = _pa
    ? `<span style="color:#C85A45;font-family:'Inter',sans-serif;font-style:italic;letter-spacing:.04em">${esc(_pa)}</span>`
    : '–';
}

// Artwork
function fetchArt(t){
  // Check custom cover first (user-set ou cache auto-fetch)
  if(customCovers[t.path]){
    updateArtDisplay(customCovers[t.path]);
    // ✅ ADD THIS - Also update fullscreen directly
    if (typeof _fsActive !== 'undefined' && _fsActive) {
      const fsArt = document.getElementById('fsArtImg');
      if (fsArt) {
        fsArt.style.backgroundImage = `url("${customCovers[t.path].replace(/"/g, '\\"')}")`;
        fsArt.classList.remove('no-art');
      }
    }
    updateEditorCoverIfOpen(t.path, customCovers[t.path]);
  } else {
    const el=document.getElementById('pArt');
    if(el) el.innerHTML='<svg class="p-art-inner" viewBox="0 0 100 100" fill="none"><circle cx="50" cy="50" r="25" fill="#C85A45" opacity=".4"/><circle cx="50" cy="50" r="7" fill="#1E1E1B"/><path d="M31 50 Q40 28 50 50 Q60 72 69 50" stroke="white" stroke-width="3" stroke-linecap="round" fill="none" opacity=".4"/></svg>';
    // Auto-fetch + cache
    autoFetchArtwork(t);
  }
  autoFetchMeta(t);
}
// Cache for album/artist images (in addition to customCovers which is per-track)
const _albumArtCache = (() => {           // key: artist||album → url (PERSISTÉ)
  try { return JSON.parse(localStorage.getItem('wt_album_art_cache') || '{}') || {}; }
  catch(e){ return {}; }
})();
let _albumArtCacheSaveT = null;
function _saveAlbumArtCache(){
  clearTimeout(_albumArtCacheSaveT);
  _albumArtCacheSaveT = setTimeout(() => {
    try { localStorage.setItem('wt_album_art_cache', JSON.stringify(_albumArtCache)); } catch(e){}
  }, 1500);
}

// Résout la meilleure URL de pochette pour un track. Suit la même
// hiérarchie que l'affichage local (custom > cache album > track > rien).
async function resolveCoverForTrack(t) {
  if (!t) return null;

  // 1. Cover personnalisée par l'user
  if (typeof customCovers !== 'undefined' && customCovers[t.path]) {
    return customCovers[t.path];
  }

  // 2. Cache album déjà rempli
  const albumKey = `${t.artist || ''}||${t.album || t.title || ''}`;
  if (_albumArtCache[albumKey]) return _albumArtCache[albumKey];

  // 3. Autre track du même album avec customCover
  if (typeof customCovers !== 'undefined' && t.album && t.artist && typeof allTracks !== 'undefined') {
    const sameAlbum = allTracks.find(x =>
      x.album === t.album && x.artist === t.artist && x.path !== t.path && customCovers[x.path]
    );
    if (sameAlbum) return customCovers[sameAlbum.path];
  }

  // 4. Cover stockée dans le track
  if (t.cover && typeof t.cover === 'string' && t.cover.length > 5) {
    return t.cover;
  }

  // 5. Fallback : fetch iTunes au moment du sync.
  // C'est lent (50-200ms par track), mais on n'a pas le choix : sans ça,
  // les morceaux jamais affichés au desktop n'auraient jamais de cover sur mobile.
  try {
    const q = encodeURIComponent(`${t.artist || ''} ${t.album || t.title || ''}`);
    if (!q.trim() || q === '%20') return null;

    // Essai 1 : recherche album
    let res = await fetch(`https://itunes.apple.com/search?term=${q}&limit=1&entity=album`);
    let data = await res.json();
    let url = data.results?.[0]?.artworkUrl100?.replace('100x100bb', '600x600bb');

    if (!url) {
      // Essai 2 : recherche song
      res = await fetch(`https://itunes.apple.com/search?term=${q}&limit=1&entity=song`);
      data = await res.json();
      url = data.results?.[0]?.artworkUrl100?.replace('100x100bb', '600x600bb');
    }

    if (url) {
      _albumArtCache[albumKey] = url;
      return url;
    }
  } catch (e) {
    console.warn('[resolveCoverForTrack] iTunes fetch failed:', t.title, e);
  }

  return null;
}

// Résout la meilleure URL de pochette disponible pour un track donné.
// Suit la même hiérarchie que le code d'affichage local du player (1→5),
// pour que ce qu'on voit dans le desktop corresponde à ce qu'on pousse
// vers le mobile via syncQueue.

const _artistPhotoCache = {}; // key: artist → url
const _plArtInFlight = new Set(); // cacheKeys en cours de fetch (anti-flood scroll)

function fetchPlArt(t, elId, _fallbackTracks, _fallbackIdx) {
  const el = document.getElementById(elId);
  if (!el) return;
  // Allow fallback walk when called with a tracks array (e.g. from group rows)
  const tryNext = () => {
    if(_fallbackTracks && _fallbackIdx + 1 < _fallbackTracks.length){
      fetchPlArt(_fallbackTracks[_fallbackIdx + 1], elId, _fallbackTracks, _fallbackIdx + 1);
    }
  };
  
  const cacheKey = (t.artist || '') + '||' + (t.album || t.title || '');
  
  // 1. per-track customCovers
  if (customCovers[t.path]) {
    _setImg(el, customCovers[t.path]);
    // Met aussi dans le cache album
    _albumArtCache[cacheKey] = customCovers[t.path];
    return;
  }
  
  // 2. album cache
  if (_albumArtCache[cacheKey]) {
    _setImg(el, _albumArtCache[cacheKey]);
    return;
  }
  
  const q = encodeURIComponent(`${t.artist || ''} ${t.album || t.title || ''}`);
  if (!q.trim() || q === '%20') { tryNext(); return; }

  // Anti-doublon : le scroll re-render les mêmes lignes en boucle. Sans ce garde,
  // le même album partait en fetch des dizaines de fois (cf. "Peer Gynt" ×3 dans
  // les logs) → flood iTunes → 429 → disjoncteur → iTunes coupé pour la session.
  if (_plArtInFlight.has(cacheKey)) return;
  _plArtInFlight.add(cacheKey);
  const _doneArt = () => _plArtInFlight.delete(cacheKey);

  // Passe par la file throttlée (3.2s, disjoncteur, backoff) au lieu d'un fetch
  // brut : c'est CE flood (un fetch par album visible à chaque scroll) qui saturait
  // iTunes. Repli Deezer (pas de rate-limit strict) si iTunes ne rend rien.
  _itunesThrottled(`https://itunes.apple.com/search?term=${q}&limit=1&entity=album`)
    .then(d => {
      const url = d?.results?.[0]?.artworkUrl100?.replace('100x100bb', '600x600bb');
      if (url) { _albumArtCache[cacheKey] = url; _saveAlbumArtCache(); _setImg(el, url); _doneArt(); return; }
      return _fetchDeezerArt(decodeURIComponent(q)).then(dz => {
        if (dz) { _albumArtCache[cacheKey] = dz; _saveAlbumArtCache(); _setImg(el, dz); }
        else { tryNext(); }
        _doneArt();
      });
    })
    .catch(() => { _doneArt(); tryNext(); });
}

function _setImg(el, url){
  const img=new Image();
  img.onload=()=>{
    el.innerHTML='';
    img.style.cssText='width:100%;height:100%;object-fit:cover;display:block;border-radius:inherit';
    el.appendChild(img);
  };
  img.onerror=()=>{   // URL morte : on purge le cache persistant pour re-résoudre plus tard
    let changed=false;
    for(const k in _albumArtCache){ if(_albumArtCache[k]===url){ delete _albumArtCache[k]; changed=true; } }
    if(changed) _saveAlbumArtCache();
  };
  img.src=url;
}

// Fetch + cache a representative photo of an artist.
// Strategy: top-1 album artwork iTunes (always available, looks iconic).
function fetchArtistPhoto(sampleTrack, elId){
  const el=document.getElementById(elId);
  if(!el || !sampleTrack || !sampleTrack.artist) return;
  const key = sampleTrack.artist;
  if(_artistPhotoCache[key]){
    _setImg(el, _artistPhotoCache[key]);
    return;
  }
  const q=encodeURIComponent(sampleTrack.artist);
  // Hit iTunes — chercher le plus représentatif (1 album top-1)
  fetch(`https://itunes.apple.com/search?term=${q}&limit=1&entity=album&attribute=artistTerm`)
    .then(r=>r.json()).then(d=>{
      let url=d.results?.[0]?.artworkUrl100?.replace('100x100bb','600x600bb');
      if(!url){
        // fallback: chercher avec artiste + titre du sample
        const q2=encodeURIComponent(`${sampleTrack.artist} ${sampleTrack.title||sampleTrack.album||''}`);
        return fetch(`https://itunes.apple.com/search?term=${q2}&limit=1&entity=album`)
          .then(r=>r.json()).then(d2=>{
            const u2=d2.results?.[0]?.artworkUrl100?.replace('100x100bb','600x600bb');
            if(u2){ _artistPhotoCache[key]=u2; _setImg(el,u2); }
          });
      }
      _artistPhotoCache[key]=url;
      _setImg(el,url);
    }).catch(()=>{});
}



// ── Mini queue state ──────────────────────────────────────────────
let _miniQueueLimit = 25;
let _miniQueueItems = [];
let _miniDragSrc = -1;
// Flag pour scroller vers le morceau courant seulement quand utile (changement
// de track / premier render), pas à chaque re-render. Sinon, le scrollIntoView
// remet l'user en haut et bloque l'atteinte du "+ 25 suivants".
let _miniScrollToNowOnce = true;

// « Lecture suivante » robuste : insère le morceau juste après le courant ET
// garde cohérents les index stockés (historique + ordre shuffle). Le splice brut
// décalait tout, et en shuffle ne changeait même pas l'ordre réellement joué.
// ── Réordonnancement de la file ──────────────────────────────────────────────
// En ALÉATOIRE, l'ordre visible est _shuffleOrder (la queue ne bouge pas) ; en
// séquentiel, on déplace dans queue en recalant qi et playbackHistory. L'ancien
// « Jouer ensuite » du menu contextuel splicait la queue sans toucher
// _shuffleOrder → déplacement invisible en shuffle + indexes corrompus.
function queuePlayNext(idx){
  if (idx === qi || !queue[idx]) return false;
  if (shuffle && _shuffleOrder && _shuffleOrder.length){
    const p = _shuffleOrder.indexOf(idx);
    if (p >= 0) _shuffleOrder.splice(p, 1);
    if (p >= 0 && p <= _shuffleCursor) _shuffleCursor = Math.max(0, _shuffleCursor - 1);
    const cur = _shuffleOrder.indexOf(qi);
    _shuffleOrder.splice((cur >= 0 ? cur : _shuffleCursor) + 1, 0, idx);
  } else {
    const [item] = queue.splice(idx, 1);
    const insertAt = (idx < qi) ? qi : qi + 1;
    queue.splice(insertAt, 0, item);
    if (idx < qi) qi--;
    for (let j = 0; j < playbackHistory.length; j++) {
      let h = playbackHistory[j];
      if (h === idx) { playbackHistory[j] = insertAt; continue; }
      if (h > idx) h--;
      if (h >= insertAt) h++;
      playbackHistory[j] = h;
    }
  }
  if (typeof computeNext === 'function') computeNext();
  if (typeof renderMiniQueue === 'function') renderMiniQueue();
  if (typeof renderDockQueue === 'function') renderDockQueue();
  return true;
}

// Déplace le morceau d'index queue srcIdx juste AVANT dstIdx (drag & drop).
function queueMoveBefore(srcIdx, dstIdx){
  if (srcIdx === dstIdx || !queue[srcIdx] || !queue[dstIdx]) return false;
  if (srcIdx === qi) return false; // on ne déplace pas le morceau en cours
  if (shuffle && _shuffleOrder && _shuffleOrder.length){
    const p = _shuffleOrder.indexOf(srcIdx);
    if (p < 0) return false;
    _shuffleOrder.splice(p, 1);
    if (p <= _shuffleCursor) _shuffleCursor = Math.max(0, _shuffleCursor - 1);
    let q = _shuffleOrder.indexOf(dstIdx);
    if (q < 0) q = _shuffleOrder.length;
    _shuffleOrder.splice(q, 0, srcIdx);
    if (q <= _shuffleCursor) _shuffleCursor++;
  } else {
    const [item] = queue.splice(srcIdx, 1);
    let at = dstIdx;
    if (srcIdx < dstIdx) at--;           // le retrait a décalé la cible
    queue.splice(at, 0, item);
    if (srcIdx < qi && at >= qi) qi--;
    else if (srcIdx > qi && at <= qi) qi++;
    for (let j = 0; j < playbackHistory.length; j++) {
      let h = playbackHistory[j];
      if (h === srcIdx) { playbackHistory[j] = at; continue; }
      if (h > srcIdx) h--;
      if (h >= at) h++;
      playbackHistory[j] = h;
    }
  }
  if (typeof computeNext === 'function') computeNext();
  if (typeof renderMiniQueue === 'function') renderMiniQueue();
  if (typeof renderDockQueue === 'function') renderDockQueue();
  return true;
}

function _playNextInsert(t){
  if(!queue.length) return false;
  const at = qi + 1;
  // L'insertion pousse d'un cran tous les index >= at → on les recale
  for(let j=0;j<playbackHistory.length;j++){ if(playbackHistory[j] >= at) playbackHistory[j]++; }
  if(_shuffleOrder && _shuffleOrder.length){
    for(let j=0;j<_shuffleOrder.length;j++){ if(_shuffleOrder[j] >= at) _shuffleOrder[j]++; }
  }
  queue.splice(at, 0, { ...t, url: pathToUrl(t.path) });
  // En shuffle : fait jouer ce morceau juste après le courant dans l'ordre shuffle
  if(shuffle && _shuffleOrder && _shuffleOrder.length){
    const cur = _shuffleOrder.indexOf(qi);
    _shuffleOrder.splice((cur >= 0 ? cur : _shuffleCursor) + 1, 0, at);
  }
  if(typeof renderMiniQueue === 'function') renderMiniQueue();
  return true;
}

function renderMiniQueue(){
  const lbl = document.getElementById('miniDrawerLabel');
  const list = document.getElementById('miniQList');
  if(!lbl || !list) return;

  _miniQueueItems = [];

  if(!queue.length){
    lbl.innerHTML = "File d’attente";
    list.innerHTML = "<div class='mini-q-empty'>Aucun morceau en lecture</div>";
    return;
  }

  // --- 1. LE PASSÉ (Historique) ---
  // Borné aux derniers joués : sinon tout l'historique s'empile EN TÊTE de la
  // liste et la fenêtre slice(0, _miniQueueLimit) ne montre que du déjà-joué,
  // repoussant l'actuel + le futur derrière le « +25 » (et empêchant même le
  // scroll-auto vers l'actuel, non rendu). Quelques joués suffisent comme repère.
  const _PAST_SHOWN = 4;
  playbackHistory
    .filter(idx => queue[idx] && idx !== qi)
    .slice(-_PAST_SHOWN)
    .forEach(idx => {
      _miniQueueItems.push({t: queue[idx], idx: idx, isPlayed: true});
    }); 

  // --- 2. LE PRÉSENT (Maintenant) ---
  // Le morceau qi est TOUJOURS isCurrent, jamais isPlayed
  if(queue[qi]){
    _miniQueueItems.push({t: queue[qi], idx: qi, isCurrent: true});
  }

  // --- 3. LE FUTUR ---
  if(shuffle && _shuffleOrder.length){
    const curPos = _shuffleOrder.indexOf(qi);
    const start = curPos >= 0 ? curPos + 1 : 0;
    for(let k = start; k < _shuffleOrder.length; k++){
      const idx = _shuffleOrder[k];
      // On n'ajoute pas le morceau actuel s'il est déjà dans la liste
      if(idx !== qi) _miniQueueItems.push({t: queue[idx], idx: idx});
    }
  } else {
    // Mode séquentiel : les morceaux après qi
    for(let k = 1; k < queue.length; k++){
      const i = (qi + k) % queue.length;
      if(i === qi) break; 
      if(i < qi && repeat !== 'all') break;
      _miniQueueItems.push({t: queue[i], idx: i});
    }
  }

  // Mise à jour des labels
  lbl.innerHTML = shuffle ? "Aléatoire" : "File d’attente";
  _miniRenderList();
}

// Drag & drop de la file d'attente : les items étaient draggable="true" mais
// AUCUN handler n'existait — on câble ici par délégation (une seule fois).
(function(){
  const list = document.getElementById('miniQList');
  if (!list) return;
  let _dragIdx = -1;
  list.addEventListener('dragstart', e => {
    const it = e.target.closest('.mini-q-item');
    if (!it || it.dataset.qidx == null) return;
    _dragIdx = parseInt(it.dataset.qidx);
    it.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(_dragIdx)); } catch(err) {}
  });
  list.addEventListener('dragover', e => {
    if (_dragIdx < 0) return;
    e.preventDefault(); // requis pour autoriser le drop
    e.dataTransfer.dropEffect = 'move';
    const it = e.target.closest('.mini-q-item');
    list.querySelectorAll('.mini-q-item.drag-over').forEach(x => x.classList.remove('drag-over'));
    if (it && it.dataset.qidx != null && parseInt(it.dataset.qidx) !== _dragIdx) it.classList.add('drag-over');
  });
  list.addEventListener('drop', e => {
    e.preventDefault();
    const it = e.target.closest('.mini-q-item');
    const src = _dragIdx; _dragIdx = -1;
    list.querySelectorAll('.drag-over,.dragging').forEach(x => x.classList.remove('drag-over', 'dragging'));
    if (src < 0 || !it || it.dataset.qidx == null) return;
    const dst = parseInt(it.dataset.qidx);
    if (dst === src) return;
    queueMoveBefore(src, dst);
  });
  list.addEventListener('dragend', () => {
    _dragIdx = -1;
    list.querySelectorAll('.drag-over,.dragging').forEach(x => x.classList.remove('drag-over', 'dragging'));
  });
})();

// ============================================================
// MENU CONTEXTUEL : clic-droit sur les items de la queue mini
// ============================================================
// Stocke l'index dans queue (pas dans _miniQueueItems) du morceau ciblé.
let _queueCtxTargetIdx = -1;

/**
 * Affiche le menu contextuel à la position du clic, pour le morceau d'index
 * `queueIdx` (index dans la queue globale, pas dans _miniQueueItems).
 */
function showQueueCtxMenu(ev, queueIdx) {
  ev.preventDefault();
  ev.stopPropagation();
  const menu = document.getElementById('queueCtxMenu');
  if (!menu) return;

  _queueCtxTargetIdx = queueIdx;
  const t = queue[queueIdx];
  if (!t) return;

  // Adapte les labels selon l'état (favori, sync)
  const favLabel = document.getElementById('queueCtxFavLabel');
  const favIcon = document.getElementById('queueCtxFavIcon');
  if (favLabel && favIcon) {
    const _star = (filled) => `<svg viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px;vertical-align:-2px" aria-hidden="true"><path d="M12 2.8l2.9 5.9 6.5.95-4.7 4.58 1.1 6.47L12 17.65 6.2 20.7l1.1-6.47L2.6 9.65l6.5-.95Z"/></svg>`;
    if (t.isFavorite) {
      favLabel.textContent = 'Retirer des favoris';
      favIcon.innerHTML = _star(true);
    } else {
      favLabel.textContent = 'Ajouter aux favoris';
      favIcon.innerHTML = _star(false);
    }
  }
  const syncLabel = document.getElementById('queueCtxSyncLabel');
  if (syncLabel) {
    syncLabel.textContent = syncSel.has(t.path) ? 'Retirer du Sync' : 'Ajouter au Sync';
  }
  const nsLabel = document.getElementById('queueCtxNoShufLabel');
  if (nsLabel && typeof _noShuffleSet !== 'undefined') {
    nsLabel.textContent = _noShuffleSet.has(t.path) ? "Réintégrer à l'aléatoire" : "Exclure de l'aléatoire";
  }

  // Désactive "Voir dans la bibliothèque" si on n'a pas trouvé le morceau dans allTracks
  const locateBtn = menu.querySelector('button[data-action="locate"]');
  if (locateBtn) {
    locateBtn.disabled = !allTracks.some(x => x.path === t.path);
  }

  // Positionne le menu au point de clic, en évitant le débordement écran
  menu.style.display = 'block';
  menu.classList.remove('on');
  // Force reflow pour que l'animation se déclenche
  void menu.offsetWidth;
  // Position après affichage (pour lire la taille réelle du menu)
  const vw = window.innerWidth, vh = window.innerHeight;
  const rect = menu.getBoundingClientRect();
  let x = ev.clientX, y = ev.clientY;
  if (x + rect.width > vw - 8) x = vw - rect.width - 8;
  if (y + rect.height > vh - 8) y = vh - rect.height - 8;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  // Active l'animation
  requestAnimationFrame(() => menu.classList.add('on'));
}

function hideQueueCtxMenu() {
  const menu = document.getElementById('queueCtxMenu');
  const sub = document.getElementById('queueCtxPlaylistSub');
  if (menu) { menu.classList.remove('on'); menu.style.display = 'none'; }
  if (sub)  { sub.classList.remove('on'); sub.style.display = 'none'; }
  _queueCtxTargetIdx = -1;
}

/**
 * Affiche le sous-menu "Ajouter à une playlist" listant les playlists user
 * (non smart, non system).
 */
function showQueueCtxPlaylistSub(ev) {
  const sub = document.getElementById('queueCtxPlaylistSub');
  if (!sub) return;
  const userPlaylists = (allLists || []).filter(pl => pl && !pl.smart && !pl.system);
  if (!userPlaylists.length) {
    toast('Aucune playlist personnelle disponible');
    return;
  }
  sub.innerHTML = userPlaylists.map((pl, idx) => {
    const realIdx = allLists.indexOf(pl);
    return `<button data-pl-idx="${realIdx}">📋 ${esc(pl.name)}</button>`;
  }).join('');
  sub.style.display = 'block';
  sub.classList.remove('on');
  void sub.offsetWidth;

  // Positionne à droite du bouton "Ajouter à une playlist"
  const trigger = document.getElementById('queueCtxPlaylist');
  const tRect = trigger.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  let x = tRect.right + 4, y = tRect.top;
  const subRect = sub.getBoundingClientRect();
  if (x + subRect.width > vw - 8) x = tRect.left - subRect.width - 4;
  if (y + subRect.height > vh - 8) y = vh - subRect.height - 8;
  sub.style.left = x + 'px';
  sub.style.top = y + 'px';
  requestAnimationFrame(() => sub.classList.add('on'));
}

// Câblage des actions
(function setupQueueCtxMenu() {
  const menu = document.getElementById('queueCtxMenu');
  const sub = document.getElementById('queueCtxPlaylistSub');
  if (!menu || !sub) return;

  // Click sur une action du menu principal
  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const idx = _queueCtxTargetIdx;
    if (idx < 0 || !queue[idx]) { hideQueueCtxMenu(); return; }
    const t = queue[idx];

    if (action === 'play') {
      hideQueueCtxMenu();
      playIdx(idx);
    } else if (action === 'next') {
      hideQueueCtxMenu();
      if (queuePlayNext(idx)) toast(`⇣ "${t.title}" sera joué ensuite`);
    } else if (action === 'fav') {
      hideQueueCtxMenu();
      // Trouve le track original dans allTracks pour conserver les références
      const orig = allTracks.find(x => x.path === t.path) || t;
      if (typeof toggleTrackFavorite === 'function') toggleTrackFavorite(orig);
    } else if (action === 'noshuf') {
      hideQueueCtxMenu();
      if (typeof toggleNoShuffleFor === 'function') toggleNoShuffleFor(t);
    } else if (action === 'sync') {
      hideQueueCtxMenu();
      if (syncSel.has(t.path)) {
        if (typeof removeSync === 'function') removeSync(t.path);
        toast(`✓ "${t.title}" retiré du Sync`);
      } else {
        syncSel.add(t.path);
        const orig = allTracks.find(x => x.path === t.path);
        if (orig && typeof _syncLinkAdd === 'function') _syncLinkAdd(orig, { manual: true });
        if (typeof updateSyncStats === 'function') updateSyncStats([...allTracks.filter(x => syncSel.has(x.path))]);
        if (typeof renderSyncQueue === 'function') renderSyncQueue();
        toast(`+ "${t.title}" → Sync`);
      }
    } else if (action === 'playlist') {
      // N'a PAS fermé le menu : on ouvre le sous-menu à la place
      showQueueCtxPlaylistSub(e);
    } else if (action === 'remove') {
      hideQueueCtxMenu();
      if (typeof dockRmQ === 'function') dockRmQ(idx, { stopPropagation: () => {} });
    } else if (action === 'edit') {
      hideQueueCtxMenu();
      if (typeof openCoverEdit === 'function') openCoverEdit();
    } else if (action === 'locate') {
      hideQueueCtxMenu();
      // Navigue dans la biblio jusqu'au morceau (au minimum, scroll-into-view)
      const lib = document.getElementById('si-lib');
      if (lib) lib.click();
      // Surligne / scroll vers la rangée correspondante
      setTimeout(() => {
        if (typeof scrollVirtualToPath === 'function') scrollVirtualToPath(t.path);
        else {
          // Fallback : recherche par titre
          const sb = document.getElementById('searchBar');
          if (sb) { sb.value = t.title; sb.dispatchEvent(new Event('input')); }
        }
      }, 100);
    }
  });

  // Click sur une playlist dans le sous-menu
  sub.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-pl-idx]');
    if (!btn) return;
    const plIdx = parseInt(btn.dataset.plIdx, 10);
    const pl = allLists[plIdx];
    const idx = _queueCtxTargetIdx;
    if (!pl || idx < 0 || !queue[idx]) { hideQueueCtxMenu(); return; }
    const t = queue[idx];
    pl.tracks = pl.tracks || [];
    if (pl.tracks.some(x => x.path === t.path)) {
      toast(`Déjà dans "${pl.name}"`);
    } else {
      pl.tracks.push(t);
      if (pl._sync && typeof _syncPushPlaylistToFirestore === 'function') _syncPushPlaylistToFirestore(pl);
      if (typeof scheduleListSave === 'function') scheduleListSave();
      renderSidebar();
      if (curPl === plIdx && typeof showPlaylist === 'function') showPlaylist(plIdx);
      toast(`+ "${t.title}" → ${pl.name}`);
    }
    hideQueueCtxMenu();
  });

  // Ferme le menu si click ailleurs
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target) && !sub.contains(e.target)) {
      hideQueueCtxMenu();
    }
  });
  // Ferme aussi sur Échap
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideQueueCtxMenu();
  });
})();

// Click simple : lance ce morceau à sa position actuelle dans la queue.
function miniQueueClick(idx){
  // Petite tempo pour laisser passer un éventuel double-clic
  if(window._miniQueueClickTimer) clearTimeout(window._miniQueueClickTimer);
  window._miniQueueClickTimer = setTimeout(()=>{
    playIdx(idx);
    window._miniQueueClickTimer = null;
  }, 220);
}

// Double-clic : si shuffle est actif, remélange et démarre à ce morceau.
// Sinon comportement identique au single click.
function miniQueueDblClick(idx, ev){
  if(ev) ev.stopPropagation();
  if(window._miniQueueClickTimer){
    clearTimeout(window._miniQueueClickTimer);
    window._miniQueueClickTimer = null;
  }
  if(shuffle){
    qi = idx;
    buildShuffleOrder();
    playIdx(idx);
    toast('↻ Ordre aléatoire remélangé');
  } else {
    playIdx(idx);
  }
}

function _miniRenderList(){
  const list = document.getElementById('miniQList');
  const visible = _miniQueueItems.slice(0, _miniQueueLimit);
  // Mémoriser le scrollTop pour le restaurer après innerHTML (sinon scroll remis à 0)
  const savedScrollTop = list.scrollTop;
  list.innerHTML = visible.map((item, pos) => {
    const now = item.isCurrent;
    const played = item.isPlayed; // Nouveau flag
    
    // On ajoute une classe 'played' si le morceau est passé
    let classes = "mini-q-item";
    if(now) classes += " now";
    if(played) classes += " played";

    return '<div class="' + classes + '" data-pos="' + pos + '" data-qidx="' + item.idx + '" draggable="' + (now ? 'false' : 'true') + '" oncontextmenu="showQueueCtxMenu(event, ' + item.idx + ')">'
      + '<span class="mini-q-handle">⠿</span>'
      + '<div class="mini-q-info" onclick="miniQueueClick(' + item.idx + ')" ondblclick="miniQueueDblClick(' + item.idx + ',event)">'
      + '<div class="mini-q-title">' + (played ? '✓ ' : '') + esc(item.t&&item.t.title||'') + '</div>'
      + '<div class="mini-q-art">' + esc(item.t&&item.t.artist||'') + '</div>'
      + '</div>'
      + '<button class="mini-q-rm" onclick="event.stopPropagation();dockRmQ(' + item.idx + ',{stopPropagation:()=>{}})" title="Retirer">✕</button>'
      + '</div>';
  }).join('');
  if(_miniQueueItems.length > _miniQueueLimit){
    const more = document.createElement('div');
    more.className = 'mini-q-more';
    const remaining = _miniQueueItems.length - _miniQueueLimit;
    const nextChunk = Math.min(25, remaining);
    more.textContent = `+ ${nextChunk} morceau${nextChunk!==1?'x':''} (${remaining} restant${remaining!==1?'s':''})`;
    const loadNext = () => {
      _miniQueueLimit += 25;
      _miniRenderList();
    };
    more.onclick = loadNext;
    list.appendChild(more);
    // Pas d'auto-load par IntersectionObserver : si la queue entière tient dans
    // la zone visible (ex: 30 morceaux dans 60vh), l'observer déclencherait en
    // cascade et afficherait tout d'un coup. On garde le clic manuel uniquement.
  }
  // Restaurer le scroll (sinon le innerHTML l'aurait remis à 0)
  list.scrollTop = savedScrollTop;
  // Scroll auto vers le morceau courant UNIQUEMENT lors d'un changement de track
  // ou au premier render — PAS à chaque re-render. Sans ça, un simple re-render
  // (après ajout/retrait) remet l'user en haut et l'empêche d'atteindre le bas
  // pour déclencher le chargement des 25 suivants.
  if(_miniScrollToNowOnce){
    _miniScrollToNowOnce = false;
    const nowEl = list.querySelector('.now');
    // On augmente le délai à 200ms pour laisser le navigateur respirer
    if(nowEl) setTimeout(()=>nowEl.scrollIntoView({block:'center', behavior:'smooth'}), 200);
  }
  // ── DRAG & DROP ── reorder existing OR drop external library tracks
  const items = list.querySelectorAll('.mini-q-item');
  // Helper: read multi-track payload from a library drag (dragstart sets 'tracks')
  const _readExternalTracks = (e) => {
    const raw = e.dataTransfer.getData('tracks') || e.dataTransfer.getData('track');
    if(!raw) return null;
    try {
      const v = JSON.parse(raw);
      const arr = Array.isArray(v) ? v : [v];
      return arr.length ? arr : null;
    } catch(_) { return null; }
  };
  // Insert external tracks into queue at logical position (matches the visual indicator).
  const _insertExternalAtLogical = (tracks, toLogicalPos) => {
    if(!tracks || !tracks.length) return;
    // Map logical _miniQueueItems position -> queue index for splice
    let queueInsertIdx;
    if(toLogicalPos >= _miniQueueItems.length){
      queueInsertIdx = queue.length;
    } else {
      const ref = _miniQueueItems[toLogicalPos];
      queueInsertIdx = ref ? ref.idx : queue.length;
    }
    const payload = tracks.map(t => ({...t, url:pathToUrl(t.path)}));
    queue.splice(queueInsertIdx, 0, ...payload);
    // Adjust qi if insertion happened at/before current
    if(queueInsertIdx <= qi) qi += payload.length;
    toast(payload.length === 1 ? `"${payload[0].title}" ajouté à la file` : `${payload.length} morceaux ajoutés à la file`);
    renderMiniQueue();
  };
  // ── Drop external library tracks onto Sync Smartphone sidebar item ────
function dropOnSyncSidebar(ev, el){
  ev.preventDefault();
  el.classList.remove('drop-hover');
  const raw = ev.dataTransfer.getData('tracks') || ev.dataTransfer.getData('track');
  if(!raw) return;
  let tracks;
  try {
    const v = JSON.parse(raw);
    tracks = Array.isArray(v) ? v : [v];
  } catch(_) { return; }
  tracks.forEach(t => syncSel.add(t.path));
  if(typeof updateSyncStats === 'function') updateSyncStats([...allTracks.filter(x=>syncSel.has(x.path))]);
  toast(tracks.length === 1 ? `"${tracks[0].title}" → Sync iPhone` : `${tracks.length} morceaux → Sync iPhone`);
  renderVirtual();
}

  items.forEach(el => {
    el.addEventListener('dragstart', e => {
      _miniDragSrc = parseInt(el.dataset.pos);
      el.classList.add('mini-dragging');
      // 'copyMove' permet à la fois la réorganisation interne (move) et le
      // drop vers une cible externe (copy, vu que le morceau reste aussi
      // dans la queue conformément à la décision UX).
      e.dataTransfer.effectAllowed = 'copyMove';
      try { e.dataTransfer.setDragImage(el, 20, 20); } catch(_){}

      // Pose les données du morceau dans dataTransfer pour permettre le drop
      // sur le panneau Sync, les playlists sidebar, etc. (qui utilisent
      // dataTransfer.getData('track') | 'tracks' via onDrop / dropOnSyncSidebar).
      const item = _miniQueueItems[_miniDragSrc];
      const t = item && item.t;
      if (t) {
        try {
          e.dataTransfer.setData('track', JSON.stringify(t));      // back-compat
          e.dataTransfer.setData('tracks', JSON.stringify([t]));   // multi-payload
        } catch(_) {}
      }
    });
    el.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = (_miniDragSrc === -1) ? 'copy' : 'move';
      const dragging = list.querySelector('.mini-dragging');
      if(dragging === el) return; // self
      items.forEach(i => i.classList.remove('mini-drop-above','mini-drop-below'));
      const bound = el.getBoundingClientRect();
      const above = (e.clientY - bound.top) < bound.height / 2;
      el.classList.add(above ? 'mini-drop-above' : 'mini-drop-below');
    });
    el.addEventListener('dragleave', () => {
      el.classList.remove('mini-drop-above','mini-drop-below');
    });
    el.addEventListener('drop', e => {
      e.preventDefault();
      e.stopPropagation();
      const targetPos = parseInt(el.dataset.pos);
      const above = el.classList.contains('mini-drop-above');
      let toLogicalPos = above ? targetPos : targetPos + 1;

      if(_miniDragSrc !== -1 && el !== list.querySelector('.mini-dragging')){
        // Internal reorder (existing behavior)
        if(_miniDragSrc < toLogicalPos) toLogicalPos--;
        if(toLogicalPos !== _miniDragSrc) applyQueueReorder(_miniDragSrc, toLogicalPos);
      } else if(_miniDragSrc === -1){
        // External drop from library
        const tracks = _readExternalTracks(e);
        _insertExternalAtLogical(tracks, toLogicalPos);
      }
      items.forEach(i => i.classList.remove('mini-drop-above','mini-drop-below','mini-dragging'));
      _miniDragSrc = -1;
    });
    el.addEventListener('dragend', () => {
      items.forEach(i => i.classList.remove('mini-drop-above','mini-drop-below','mini-dragging'));
      _miniDragSrc = -1;
    });
  });

  // Drop on the empty area of the list (or empty queue) → append
  list.addEventListener('dragover', e => {
    if(_miniDragSrc !== -1) return; // internal drag, items handle it
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if(!e.target.closest('.mini-q-item')) list.classList.add('mini-q-dropping');
  });
  list.addEventListener('dragleave', e => {
    if(e.target === list) list.classList.remove('mini-q-dropping');
  });
  list.addEventListener('drop', e => {
    if(_miniDragSrc !== -1) return;
    if(e.target.closest('.mini-q-item')) return; // item handler took it
    e.preventDefault();
    list.classList.remove('mini-q-dropping');
    const tracks = _readExternalTracks(e);
    _insertExternalAtLogical(tracks, _miniQueueItems.length); // append
  });
}

// Réordonne la queue en fonction des positions logiques dans _miniQueueItems.
// Gère correctement shuffle (réordonne _shuffleOrder) ET séquentiel (réordonne queue).
function applyQueueReorder(fromLogicalPos, toLogicalPos){
  if(fromLogicalPos === toLogicalPos) return;
  const fromItem = _miniQueueItems[fromLogicalPos];
  if(!fromItem) return;
  const fromQIdx = fromItem.idx;

  if(shuffle && _shuffleOrder.length){
    // En mode shuffle : réordonner _shuffleOrder (l'ordre de lecture).
    // _miniQueueItems[k] correspond à _shuffleOrder[pos_courant + k]
    // où pos_courant = _shuffleOrder.indexOf(qi).
    const curPos = _shuffleOrder.indexOf(qi);
    if(curPos < 0) return;
    const fromSPos = curPos + fromLogicalPos;
    let   toSPos   = curPos + toLogicalPos;
    if(fromSPos < 0 || fromSPos >= _shuffleOrder.length) return;
    if(toSPos   < 0 || toSPos   >= _shuffleOrder.length) toSPos = _shuffleOrder.length - 1;
    const moved = _shuffleOrder.splice(fromSPos, 1)[0];
    _shuffleOrder.splice(toSPos, 0, moved);
    computeNext();
  } else {
    // Mode séquentiel : _miniQueueItems[0] = qi, puis qi+1, qi+2, ... avec wrap si repeat='all'
    // Un reorder à la position 0 ne déplace rien (c'est le morceau en cours)
    // — on l'autorise mais ça ne change pas qi (le morceau en cours continue de jouer).
    const toItem = _miniQueueItems[toLogicalPos] || _miniQueueItems[_miniQueueItems.length-1];
    const toQIdx = toItem ? toItem.idx : fromQIdx;
    if(fromQIdx === toQIdx) return;
    // Capturer le morceau courant pour le retrouver après le splice
    const curTrack = queue[qi];
    const moved = queue.splice(fromQIdx, 1)[0];
    // dest dans la queue après splice : si on retire avant la cible, -1
    const dest = fromQIdx < toQIdx ? toQIdx - 1 : toQIdx;
    queue.splice(dest, 0, moved);
    // Retrouver qi sur la base du morceau (le plus fiable — évite les bugs de décalage)
    if(curTrack){
      const newQi = queue.findIndex(x => x.path === curTrack.path);
      if(newQi >= 0) qi = newQi;
    }
    computeNext();
  }

  renderDockQueue();
  renderMiniQueue();
  
}


// ── COVER EDIT ────────────────────────────────────
let coverEditTrack=null;
let customCovers={}; // path → dataURL

// ── Cache négatif des covers (Map séparée, persistée via IPC save-no-cover) ──
// path → timestamp(ms) du dernier échec. Empêche le re-fetch en boucle des
// albums sans pochette trouvable. TTL : au-delà, on réautorise un nouvel essai.
let _noCoverCache = {};                              // path → ts(ms)
const _NO_COVER_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 jours
// true = on a cherché récemment et rien trouvé → ne pas re-fetch
function _hasFreshNoCover(path){
  const ts = _noCoverCache[path];
  if(!ts) return false;
  if(Date.now() - ts >= _NO_COVER_TTL_MS){ delete _noCoverCache[path]; return false; }
  return true;
}
// Save throttlé (regroupe les écritures, comme scheduleSave pour les covers)
let _noCoverSaveTimer = null;
function _markNoCover(path){
  _noCoverCache[path] = Date.now();
  clearTimeout(_noCoverSaveTimer);
  _noCoverSaveTimer = setTimeout(() => {
    if(window.wt?.saveNoCover) window.wt.saveNoCover(_noCoverCache).catch(()=>{});
  }, 2000);
}


// ============================================================
// OUVRIR L'ÉDITEUR - Version instantanée (sans attendre)
// ============================================================

// ============================================================
window.openCoverEdit = function() {
  if (typeof nowPath === 'undefined' || !nowPath) return;
  
  const t = queue[qi];
  if (!t) return;
  
  const originalTrack = allTracks.find(x => x.path === t.path) || t;
  
  const albumTracks = (originalTrack.album && originalTrack.artist)
    ? allTracks.filter(x => x.album === originalTrack.album && x.artist === originalTrack.artist)
    : [originalTrack];
  
  albumTracks._primary = originalTrack;
  
  openOmniEditor(albumTracks, true);
};

function closeCoverEdit(){document.getElementById('coverEditOv')?.classList.remove('on');}

// ============================================================
// MISSING COVER SEARCH FUNCTIONS
// ============================================================

// iTunes cover search
async function fetchItunes(query) {
  try {
    const q = encodeURIComponent(query);
    const res = await fetch(`https://itunes.apple.com/search?term=${q}&media=music&entity=album&limit=8`);
    const data = await res.json();
    
    return (data.results || [])
      .filter(item => item.artworkUrl100)
      .map(item => ({
        album: item.collectionName,
        artist: item.artistName,
        year: item.releaseDate ? item.releaseDate.split('-')[0] : '',
        cover: item.artworkUrl100?.replace('100x100bb', '600x600bb') || '',
        source: 'iTunes',
        quality: 600
      }));
  } catch (e) {
    console.warn('[fetchItunes] error:', e);
    return [];
  }
}












function searchCoverOnline(){
  document.getElementById('cebSearchRow').style.display='flex';
  document.getElementById('cebResults').style.display='none';
  document.getElementById('cebQuery').focus();
}


function applyCover(url){
  if(!coverEditTrack)return;
  customCovers[coverEditTrack.path]=url;
  // Update preview
  document.getElementById('cebPreview').innerHTML=`<img src="${url}" style="width:100%;height:100%;object-fit:contain;display:block;background:var(--bg3)">`;
  document.querySelectorAll('.ceb-thumb').forEach(el=>el.classList.remove('chosen'));
  event.target.classList.add('chosen');
  // Update player art
  updateArtDisplay(url);
  toast('✓ Pochette mise à jour');
}
function uploadCoverFile(){document.getElementById('coverFileIn').click();}
function onCoverFile(e){
  const file=e.target.files[0]; if(!file)return;
  const reader=new FileReader();
  reader.onload=ev=>{
    const url=ev.target.result;
    if(coverEditTrack) customCovers[coverEditTrack.path]=url;
    document.getElementById('cebPreview').innerHTML=`<img src="${url}" style="width:100%;height:100%;object-fit:contain;display:block;background:var(--bg3)">`;
    updateArtDisplay(url); toast('✓ Pochette importée');
  };
  reader.readAsDataURL(file);
  e.target.value='';
}
function updateArtDisplay(url){
  const el=document.getElementById('pArt');
  if(el) el.innerHTML=`<img src="${url}" style="width:100%;height:100%;object-fit:cover;border-radius:8px">`;
  
  // ✅ ADD THIS - Update fullscreen if active
  if (typeof _fsActive !== 'undefined' && _fsActive) {
    const fsArt = document.getElementById('fsArtImg');
    if (fsArt) {
      fsArt.style.backgroundImage = `url("${url.replace(/"/g, '\\"')}")`;
      fsArt.classList.remove('no-art');
    }
  }
  
  // Legacy mini player disc — overlay was removed, guard against null
  const disc=document.getElementById('miniDisc');
  if(disc){
    disc.innerHTML=`<img src="${url}"><div style="position:absolute;width:16px;height:16px;border-radius:50%;background:var(--bg1);box-shadow:0 0 0 2px var(--bg3);z-index:2;top:50%;left:50%;transform:translate(-50%,-50%)"></div>`;
  }
  const wrap=document.getElementById('miniCoverWrap');
  if(wrap){
    if(!wrap.querySelector('img.bg-cover')){
      const bgImg=document.createElement('img');
      bgImg.className='bg-cover';
      bgImg.style.cssText='position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.25;filter:blur(8px)';
      wrap.prepend(bgImg);
    }
    wrap.querySelector('img.bg-cover').src=url;
  }
}

function fmt(s){if(!isFinite(s)||isNaN(s))return'–:––';return Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
function toast(msg){const el=document.getElementById('toast');el.textContent=msg;el.classList.add('on');clearTimeout(el._t);el._t=setTimeout(()=>el.classList.remove('on'),2500);}
function createCustomPlaylist(){
  const name=`Ma playlist ${allLists.filter(l=>l.custom).length+1}`;
  allLists.push({name,tracks:[],count:0,custom:true}); scheduleSave();
  renderSidebar();
  const i=allLists.length-1;
  setTimeout(()=>startRename(i),50);
  toast(`✓ Nouvelle playlist créée`);
}

// Allow dropping tracks onto playlist items in sidebar
document.getElementById('sbLists').addEventListener('dragover',e=>{
  e.preventDefault();
  const el=e.target.closest('.pl-item');
  if(el) el.style.background='rgba(200,90,69,.12)';
});
document.getElementById('sbLists').addEventListener('dragleave',e=>{
  const el=e.target.closest('.pl-item');
  if(el) el.style.background='';
});
document.getElementById('sbLists').addEventListener('drop',e=>{
  e.preventDefault();
  const el=e.target.closest('.pl-item');
  if(el) el.style.background='';
  try{
    const t=JSON.parse(e.dataTransfer.getData('track'));
    const items=document.getElementById('sbLists').querySelectorAll('.pl-item');
    const idx=[...items].indexOf(el);
    if(idx>=0 && allLists[idx]){
      const pl=allLists[idx];
      if(!pl.tracks.find(x=>x.path===t.path)){
        pl.tracks.push(t); pl.count=pl.tracks.length;
        renderSidebar();
        scheduleSave();  // Persiste la modif + déclenche Patch E (propagation Firestore)
        toast(`+ "${t.title}" → ${pl.name}`);
      } else toast(`Déjà dans "${pl.name}"`);
    }
  }catch{}
});

// ── SMART PLAYLISTS ───────────────────────────────
// Patch : champs étendus (genre, year, favorite, lastPlayed, neverPlayed)
// Type de chaque champ détermine les opérateurs proposés (text vs number vs bool vs date).
const SMART_FIELDS=[
  {v:'title',     l:'Titre',          type:'text'},
  {v:'artist',    l:'Artiste',        type:'text'},
  {v:'album',     l:'Album',          type:'text'},
  {v:'genre',     l:'Genre',          type:'text'},
  {v:'year',      l:'Année',          type:'number'},
  {v:'favorite',  l:'Favori',         type:'bool'},
  {v:'lastPlayed',l:'Écouté il y a',  type:'days'},
  {v:'neverPlayed',l:'Jamais écouté', type:'bool'},
];
const SMART_OPS=[
  {v:'contains',l:'contient',         types:['text']},
  {v:'is',      l:'est',              types:['text','number','bool']},
  {v:'not',     l:'ne contient pas',  types:['text']},
  {v:'gt',      l:'>',                types:['number','days']},
  {v:'lt',      l:'<',                types:['number','days']},
];

// Renvoie les opérateurs valides pour un type de champ donné
function _smartOpsFor(fieldType){
  return SMART_OPS.filter(o => o.types.includes(fieldType));
}
function _smartFieldType(fieldVal){
  const f = SMART_FIELDS.find(x => x.v === fieldVal);
  return f ? f.type : 'text';
}

function openSmartModal(){
  editingSmartIdx=-1; smartRules=[{field:'favorite',op:'is',val:''}];
  document.getElementById('smartName').value='Ma Smart Playlist';
  document.getElementById('ovSmart').classList.add('on');
  renderSmartRules(); updateSmartCount();
}
function closeSmartModal(){
  document.getElementById('ovSmart').classList.remove('on');
  // Patch : nettoie le preview pour qu'il soit reconstruit proprement au prochain open
  const prev = document.getElementById('smartPreview');
  if(prev && prev.parentNode) prev.parentNode.removeChild(prev);
}

function addSmartRule(){
  smartRules.push({field:'title',op:'contains',val:''});
  renderSmartRules(); updateSmartCount();
}
function removeSmartRule(i){
  smartRules.splice(i,1);
  renderSmartRules(); updateSmartCount();
}
function renderSmartRules(){
  document.getElementById('smartRules').innerHTML=smartRules.map((r,i)=>{
    const fieldType = _smartFieldType(r.field);
    const validOps = _smartOpsFor(fieldType);
    // Si l'op courant n'est pas valide pour ce type, on bascule sur le premier op valide
    if(!validOps.find(o => o.v === r.op)){
      r.op = validOps[0]?.v || 'is';
    }
    // Pour bool (favorite, neverPlayed) : pas d'input "valeur" — la règle est juste "Favori est vrai"
    const isBool = fieldType === 'bool';
    // Pour days : input numérique + suffixe "jours"
    const isDays = fieldType === 'days';
    const isNum  = fieldType === 'number';

    let inputHtml;
    if(isBool){
      // Pas d'input — la règle s'évalue toujours à "vrai" pour ce champ
      inputHtml = `<div style="flex:1;font-family:var(--font-body);font-size:11px;color:var(--t3);padding:6px 8px">—</div>`;
    } else if(isDays){
      inputHtml = `<input class="rule-in" type="number" min="0" value="${esc(r.val)}" placeholder="Nombre de jours…"
        oninput="smartRules[${i}].val=this.value;updateSmartCount()" style="flex:1">
        <span style="font-family:var(--font-body);font-size:10px;color:var(--t3);align-self:center;margin-right:6px">jours</span>`;
    } else if(isNum){
      inputHtml = `<input class="rule-in" type="number" value="${esc(r.val)}" placeholder="Valeur…"
        oninput="smartRules[${i}].val=this.value;updateSmartCount()">`;
    } else {
      inputHtml = `<input class="rule-in" value="${esc(r.val)}" placeholder="Valeur…"
        oninput="smartRules[${i}].val=this.value;updateSmartCount()">`;
    }

    return `
    <div class="rule-row">
      <select class="rule-sel" onchange="smartRules[${i}].field=this.value;renderSmartRules();updateSmartCount()">
        ${SMART_FIELDS.map(f=>`<option value="${f.v}"${r.field===f.v?' selected':''}>${f.l}</option>`).join('')}
      </select>
      <select class="rule-sel" onchange="smartRules[${i}].op=this.value;updateSmartCount()" ${isBool?'style="display:none"':''}>
        ${validOps.map(o=>`<option value="${o.v}"${r.op===o.v?' selected':''}>${o.l}</option>`).join('')}
      </select>
      ${inputHtml}
      ${smartRules.length>1?`<div class="rule-del" onclick="removeSmartRule(${i})">✕</div>`:''}
    </div>`;
  }).join('');
}
function evalSmartRules(){
  const now = Date.now();
  return allTracks.filter(t=>smartRules.every(r=>{
    const fieldType = _smartFieldType(r.field);

    // ── Champs booléens (favori / jamais écouté) ──
    if(fieldType === 'bool'){
      if(r.field === 'favorite') return t.isFavorite === true;
      if(r.field === 'neverPlayed') return !t.playCount || t.playCount === 0;
      return false;
    }

    // ── Champ "jours depuis dernière écoute" ──
    if(fieldType === 'days'){
      if(!t.lastPlayed) return false;
      const daysSince = (now - new Date(t.lastPlayed).getTime()) / 86400000;
      const v = parseFloat(r.val) || 0;
      if(r.op === 'gt') return daysSince > v;
      if(r.op === 'lt') return daysSince < v;
      return false;
    }

    // ── Champ numérique (année) ──
    if(fieldType === 'number'){
      const tv = parseFloat(t[r.field]);
      const rv = parseFloat(r.val);
      if(isNaN(tv) || isNaN(rv)) return false;
      if(r.op === 'is') return tv === rv;
      if(r.op === 'gt') return tv > rv;
      if(r.op === 'lt') return tv < rv;
      return false;
    }

    // ── Champ texte (title, artist, album, genre) ──
    const tv = String(t[r.field] || '').toLowerCase();
    const rv = String(r.val || '').toLowerCase();
    if(r.op === 'contains') return tv.includes(rv);
    if(r.op === 'is') return tv === rv;
    if(r.op === 'not') return !tv.includes(rv);
    return true;
  }));
}
function updateSmartCount(){
  const matches=evalSmartRules();
  const n=matches.length;
  document.getElementById('smartMatchCt').textContent=`${n.toLocaleString()} morceau${n!==1?'x':''} correspondant${n!==1?'s':''}`;
 // Live preview — max 8 morceaux affichés
  // Patch : on cible le .mf À L'INTÉRIEUR de la modal smart, pas le premier .mf du document
  let prev=document.getElementById('smartPreview');
  if(!prev){
    const modal = document.getElementById('ovSmart').querySelector('.modal');
    const mf = modal.querySelector('.mf');
    if(!mf){ console.warn('[updateSmartCount] .mf not found in smart modal, skip preview'); return; }
    prev=document.createElement('div');
    prev.id='smartPreview';
    prev.style.cssText='max-height:160px;overflow-y:auto;border-top:.5px solid var(--ln)';
    modal.insertBefore(prev, mf);
  }
  if(!n){prev.innerHTML='<div style="padding:12px 18px;font-family:var(--font-body);font-size:11px;color:var(--t3)">Aucun morceau ne correspond</div>';return;}
  prev.innerHTML=matches.slice(0,8).map(t=>`
    <div style="display:flex;align-items:center;gap:10px;padding:7px 18px;border-bottom:.5px solid rgba(255,255,255,.03)">
      <div style="width:6px;height:6px;border-radius:50%;background:var(--acc);flex-shrink:0;opacity:.6"></div>
      <div style="flex:1;min-width:0">
        <div style="font-family:var(--font-body);font-size:11px;color:var(--t1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.title)}</div>
        <div style="font-family:var(--font-body);font-size:10px;color:var(--t3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.artist||'')}</div>
      </div>
      <div style="font-family:var(--font-title);font-size:9px;color:var(--t3);flex-shrink:0">${t.sz}</div>
    </div>`).join('')+
    (n>8?`<div style="padding:8px 18px;font-family:var(--font-title);font-size:9px;color:var(--t3);letter-spacing:.05em">… et ${n-8} autre${n-8>1?'s':''}</div>`:'');
}
function applySmartPlaylist(){
  const name=document.getElementById('smartName').value.trim()||'Smart Playlist';
  const tracks=evalSmartRules();
  allLists.push({name,tracks,count:tracks.length,smart:true,rules:[...smartRules]}); scheduleSave();
  renderSidebar(); closeSmartModal();
  toast(`✓ "${name}" · ${tracks.length} morceaux`);
}
document.getElementById('ovSmart').addEventListener('click',e=>{if(e.target===document.getElementById('ovSmart'))closeSmartModal();});

document.getElementById('ov').addEventListener('click',e=>{if(e.target===document.getElementById('ov'))closeModal();});

// ── TRACK CONTEXT MENU LOGIC ────────────────────────────
let _tctxTrack = null, _tctxFiltIdx = -1;

// Purge la pochette du morceau ET de tout son album (les covers sont une
// affaire d'album) : customCovers, cache album, marqueurs « pas de cover »,
// puis relance la recherche — désormais VALIDÉE (album/artiste qui recoupent),
// donc les pollutions type Arc→Unplugged ne reviennent pas.
function tctxPurgeCover(){
  const sel = _tctxTrack;
  hideTrackCtxMenu();
  purgeCoverFor(sel);
}

// Purge depuis l'ÉDITEUR : même cœur, puis rafraîchit la vignette de la modale.
function omniPurgeCover(){
  purgeCoverFor(_omniSpecificRef);
  const preview = document.getElementById('omniCoverPreview');
  if (preview) {
    preview.style.backgroundImage = '';
    preview.innerHTML = '<span style="font-size:9px;color:var(--t3)">purgée — recherche…</span>';
  }
  const box = document.querySelector('#batchOv .batch-box');
  if (box) box.style.removeProperty('--omni-bg');
}

function purgeCoverFor(sel){
  if (!sel || !sel.path) return;
  const t = (typeof allTracks !== 'undefined' && allTracks.find(x => x.path === sel.path)) || sel;
  const sameAlbum = (typeof allTracks !== 'undefined' && t.album)
    ? allTracks.filter(x => x.album === t.album && x.artist === t.artist)
    : [t];
  let purged = 0;
  for (const x of sameAlbum) {
    if (customCovers[x.path]) { delete customCovers[x.path]; purged++; }
    if (typeof _noCoverCache !== 'undefined' && _noCoverCache[x.path]) delete _noCoverCache[x.path];
  }
  const albumKey = `${t.artist || ''}||${t.album || t.title || ''}`;
  if (typeof _albumArtCache !== 'undefined' && _albumArtCache[albumKey]) {
    delete _albumArtCache[albumKey];
    if (typeof _saveAlbumArtCache === 'function') _saveAlbumArtCache();
  }
  if (typeof scheduleSave === 'function') scheduleSave();
  if (window.wt && window.wt.saveNoCover && typeof _noCoverCache !== 'undefined') {
    try { window.wt.saveNoCover(_noCoverCache).catch(() => {}); } catch(e) {}
  }
  if (typeof toast === 'function') toast(`Pochette purgée (${sameAlbum.length} morceau${sameAlbum.length > 1 ? 'x' : ''}) — nouvelle recherche…`);
  // Relance immédiate sur le morceau ciblé (les autres se re-résoudront au play/scroll)
  if (typeof autoFetchArtwork === 'function') autoFetchArtwork(t);
  // Rafraîchit l'affichage si c'est le morceau en cours
  if (typeof nowPath !== 'undefined' && nowPath === t.path && typeof fetchArt === 'function') fetchArt(t);
  if (typeof renderVirtual === 'function') renderVirtual();
}

function showTrackCtxMenu(ev, t, filtIdx) {
  _tctxTrack = t;
  _tctxFiltIdx = filtIdx;

  const menu = document.getElementById('trackCtxMenu');
  const selN = selectedPaths.size;
  if (selN >= 2 && selectedPaths.has(t.path)) {
    document.getElementById('tctxTitle').textContent = `${selN} morceaux sélectionnés`;
    document.getElementById('tctxSub').textContent = '';
  } else {
    document.getElementById('tctxTitle').textContent = t.title || '–';
    document.getElementById('tctxSub').textContent = [t.artist, _displayAlbum(t.album), t.year].filter(Boolean).join(' · ') || '–';
  }
  menu.classList.add('on');
  
  // Positioning logic
  let x = ev.clientX, y = ev.clientY;
  // Hauteur RÉELLE (l'estimation fixe à 180 était trop courte → menu coupé en bas).
  const mw = menu.offsetWidth || 240, mh = menu.offsetHeight || 180;
  if (x + mw > window.innerWidth)  x = window.innerWidth  - mw - 8;
  if (y + mh > window.innerHeight) y = window.innerHeight - mh - 8;
  if (x < 8) x = 8;
  if (y < 8) y = 8;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

// 1. Right-click on a track -> "Modifier les infos & pochette"
// app.html
function tctxOpenHarmonizedEditor(clickedTrack) {
  // 1. Use the passed parameter, fallback to global if necessary
  const target = clickedTrack || _tctxTrack;

  if (!target) {
    console.error("No track data available for editing");
    return;
  }
  
  // 2. Close menu immediately
  hideTrackCtxMenu();
  
  // 3. Use the local 'target' variable to avoid the 'null' error
  // We identify siblings for the "Apply to Album" checkbox logic
  const albumTracks = (target.album && target.artist)
    ? allTracks.filter(x => x.album === target.album && x.artist === target.artist)
    : [target];

  // 4. Important: We need the editor to know WHICH track was the primary click
  // so it can show the correct Title in the input field.
  // We can pass the primary track as an extra property on the array.
  albumTracks._primary = target;

  openOmniEditor(albumTracks, false); 
}

function tctxSaveEdit(){
  if(!_tctxTrack) return;

  // ── BATCH ALBUM MODE : on applique à tous les morceaux de l'album en 1 coup
  if(_tctxBatchAlbum && _tctxBatchAlbum.length){
    const nA=document.getElementById('tctxArtist').value.trim();
    const nAl=document.getElementById('tctxAlbum').value.trim();
    const nGGlobal=document.getElementById('tctxGenre').value.trim(); // bucket parmi les 15
    const nGStyle=document.getElementById('tctxStyle').value.trim();  // style libre
    const nY=document.getElementById('tctxYear').value.trim();
    // Résoudre le bucket : si global choisi → prendre. Sinon, tenter de mapper le style libre.
    let newBucket = '';
    let newStyle = nGStyle;
    if(nGGlobal){
      newBucket = nGGlobal;
    } else if(nGStyle){
      const mapped = (typeof clientMapGenre === 'function') ? clientMapGenre(nGStyle) : null;
      newBucket = mapped || nGStyle; // fallback : on stocke le style tel quel dans genre
    }
    const batch=_tctxBatchAlbum;
    const batchPaths=new Set(batch.map(t=>t.path));
    let count=0;
    allTracks.forEach(t=>{
      if(!batchPaths.has(t.path)) return;
      if(nA) t.artist=nA;
      if(nAl) t.album=nAl;
      if(newBucket) t.genre=newBucket;
      if(nGStyle || nGGlobal) t.genreStyle = newStyle; // même vide, on écrit pour clear l'ancien
      if(nY&&!isNaN(parseInt(nY))) t.year=parseInt(nY);
      t._userModified=true;
      _clearUnidentifiedIfComplete(t);
      const qi_track=queue.findIndex(q=>q.path===t.path);
      if(qi_track>=0){
        Object.assign(queue[qi_track],{artist:t.artist,album:t.album,genre:t.genre,genreStyle:t.genreStyle,year:t.year,_userModified:true});
      }
      count++;
    });
    _tctxBatchAlbum=null; // reset flag
    hideTrackCtxMenu();
    renderVirtual(); scheduleSave(); scheduleMetaSave();
    toast(`✓ ${count} morceaux mis à jour`);
    return;
  }

  const t=allTracks.find(x=>x.path===_tctxTrack.path);
  if(!t){ hideTrackCtxMenu(); return; }
  const nT=document.getElementById('tctxTitleIn')?.value.trim()||'';
  const nA=document.getElementById('tctxArtist').value.trim();
  const nAl=document.getElementById('tctxAlbum').value.trim();
  const nGGlobal=document.getElementById('tctxGenre').value.trim(); // bucket
  const nGStyle=document.getElementById('tctxStyle').value.trim();  // style libre
  const nY=document.getElementById('tctxYear').value.trim();
  // Résoudre bucket : global prioritaire, sinon mapping du style libre
  let newBucket = '';
  let newStyle = nGStyle;
  if(nGGlobal){
    newBucket = nGGlobal;
  } else if(nGStyle){
    const mapped = (typeof clientMapGenre === 'function') ? clientMapGenre(nGStyle) : null;
    newBucket = mapped || nGStyle;
  }
  if(nT) t.title=nT;
  if(nA) t.artist=nA;
  if(nAl) t.album=nAl;
  if(newBucket) t.genre=newBucket;
  if(nGStyle || nGGlobal) t.genreStyle = newStyle;
  if(nY&&!isNaN(parseInt(nY))) t.year=parseInt(nY);
  t._userModified=true; // user edit: protected from auto-overwrite
  _clearUnidentifiedIfComplete(t);
  const qi_track=queue.findIndex(q=>q.path===t.path);
  if(qi_track>=0){ Object.assign(queue[qi_track],{title:t.title,artist:t.artist,album:t.album,genre:t.genre,genreStyle:t.genreStyle,year:t.year,_userModified:true}); }

  // Album inheritance: propose to apply changes to all tracks of the same album.
  // Match siblings by ORIGINAL album (before rename), not the new value.
  const albumOrig = _editorOpenSnapshot?.album ?? t.album;
  const albumNow  = t.album;
  if(albumOrig && (newBucket || nY || nA || nAl)){
    // Find siblings using the album NAME as it was when editing started.
    const siblings = allTracks.filter(x => x.path !== t.path && x.album === albumOrig);
    const needGenre  = newBucket ? siblings.filter(x => x.genre !== newBucket) : [];
    const needYear   = nY        ? siblings.filter(x => String(x.year || '') !== String(nY)) : [];
    const needArtist = nA        ? siblings.filter(x => x.artist !== nA) : [];
    const needAlbum  = nAl       ? siblings.filter(x => x.album !== nAl) : [];
    const affected = [...new Set([...needGenre, ...needYear, ...needArtist, ...needAlbum])];
    if(affected.length > 0){
      hideTrackCtxMenu();
      const msg = `Appliquer aussi à ${affected.length} autre${affected.length>1?'s':''} morceau${affected.length>1?'x':''} de l'album "${esc(albumOrig)}" ?`;
      if(confirm(msg)){
        affected.forEach(x => {
          if(newBucket) x.genre = newBucket;
          if(nGStyle || nGGlobal) x.genreStyle = newStyle;
          if(nY && !isNaN(parseInt(nY))) x.year = parseInt(nY);
          if(nA)  x.artist = nA;
          if(nAl) x.album  = nAl;
          x._userModified = true;
          if(typeof _clearUnidentifiedIfComplete === 'function') _clearUnidentifiedIfComplete(x);
          // Sync queue copies
          const qi_x = queue.findIndex(q => q.path === x.path);
          if(qi_x >= 0){
            Object.assign(queue[qi_x], {
              artist: x.artist, album: x.album, genre: x.genre, genreStyle: x.genreStyle, year: x.year, _userModified: true
            });
          }
        });
        toast(`✓ Album "${albumNow}" mis à jour (${affected.length} morceau${affected.length>1?'x':''})`);
      }
    } else { hideTrackCtxMenu(); }
  } else { hideTrackCtxMenu(); }

  renderVirtual(); scheduleSave(); scheduleMetaSave();
  toast('✓ Infos mises à jour');
}

// Dismiss on click outside or Escape
document.addEventListener('click',ev=>{
  const menu=document.getElementById('trackCtxMenu');
  if(menu.classList.contains('on')&&!menu.contains(ev.target)) hideTrackCtxMenu();
  const grp=document.getElementById('grpCtxMenu');
  if(grp.classList.contains('on')&&!grp.contains(ev.target)) hideGrpCtxMenu();
  const pp=document.getElementById('plPickerEl');
  if(pp.classList.contains('on')&&!pp.contains(ev.target)&&!grp.contains(ev.target)&&!menu.contains(ev.target)) hidePlPicker();
});
document.addEventListener('keydown',ev=>{ if(ev.key==='Escape'){hideTrackCtxMenu();hideGrpCtxMenu();hidePlPicker();}});

function hideTrackCtxMenu(){
  document.getElementById('trackCtxMenu').classList.remove('on');
  _tctxTrack=null; _tctxFiltIdx=-1;
  _tctxBatchAlbum=null; // fin de session : sortir du mode batch
}
// Helper: tracks the ctx-menu acts on (selection if multi, else just clicked track).
function _tctxTargetTracks(){
  if(selectedPaths.size >= 2 && _tctxTrack && selectedPaths.has(_tctxTrack.path)){
    return filtered.filter(x => selectedPaths.has(x.path));
  }
  return _tctxTrack ? [_tctxTrack] : [];
}
function tctxPlay(){
  const ts = _tctxTargetTracks();
  if(!ts.length){ hideTrackCtxMenu(); return; }
  if(ts.length === 1 && _tctxFiltIdx >= 0){
    playFrom(_tctxFiltIdx);
  } else {
    queue = ts.map(t => ({...t, url:pathToUrl(t.path)}));
    setPlayContext('flat', `${ts.length} morceaux`);
    playIdx(0);
  }
  hideTrackCtxMenu();
}
function tctxAddNext(){
  const ts = _tctxTargetTracks();
  if(!ts.length){ hideTrackCtxMenu(); return; }
  if(queue.length){
    ts.forEach((t, idx) => queue.splice(qi + 1 + idx, 0, {...t, url:pathToUrl(t.path)}));
    toast(ts.length === 1 ? `"${ts[0].title}" → lecture suivante` : `${ts.length} morceaux → lecture suivante`);
  } else {
    queue = ts.map(t => ({...t, url:pathToUrl(t.path)}));
    setPlayContext('flat', `${ts.length} morceaux`);
    playIdx(0);
  }
  hideTrackCtxMenu();
}
function tctxAddQueue(){
  const ts = _tctxTargetTracks();
  if(!ts.length){ hideTrackCtxMenu(); return; }
  ts.forEach(t => queue.push({...t, url:pathToUrl(t.path)}));
  toast(ts.length === 1 ? `"${ts[0].title}" → file d'attente` : `${ts.length} morceaux → file d'attente`);
  if(typeof renderDockQueue === 'function') renderDockQueue();
  hideTrackCtxMenu();
}
function tctxAddSync(){
  const ts = _tctxTargetTracks();
  if(!ts.length){ hideTrackCtxMenu(); return; }
  ts.forEach(t => syncSel.add(t.path));
  if(typeof updateSyncStats === 'function') updateSyncStats([...allTracks.filter(x=>syncSel.has(x.path))]);
  toast(ts.length === 1 ? `"${ts[0].title}" → Sync iPhone` : `${ts.length} morceaux → Sync iPhone`);
  renderVirtual();
  hideTrackCtxMenu();
}
function tctxReveal(){
  if(!_tctxTrack) { hideTrackCtxMenu(); return; }
  if(window.wt?.revealInFinder) window.wt.revealInFinder(_tctxTrack.path);
  hideTrackCtxMenu();
}


// ── THEME / A11Y ──────────────────────────────────
let _theme='dark', _a11y=false;

function toggleTheme(){
  _theme=_theme==='dark'?'light':'dark';
  document.documentElement.setAttribute('data-theme',_theme==='light'?'light':'');
  const lbl=document.getElementById('themeLabel');
  const ico=document.getElementById('themeIcon');
  if(_theme==='light'){
    if(lbl) lbl.textContent='Sombre';
    if(ico) ico.innerHTML='<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>';
  } else {
    if(lbl) lbl.textContent='Clair';
    if(ico) ico.innerHTML='<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';
  }
  // Save preference
  try{ localStorage.setItem('wt_theme',_theme); }catch{}
}

function toggleA11y(){
  _a11y=!_a11y;
  document.documentElement.setAttribute('data-a11y',_a11y?'on':'');
  const btn=document.getElementById('btnA11y');
  if(btn) btn.classList.toggle('on',_a11y);
  toast(_a11y?'Mode Accessibilité activé':'Mode Accessibilité désactivé');
  try{ localStorage.setItem('wt_a11y',_a11y?'1':'0'); }catch{}
}

// Restore preferences on load
(function restorePrefs(){
  try{
    const t=localStorage.getItem('wt_theme');
    if(t==='light') toggleTheme();
    const a=localStorage.getItem('wt_a11y');
    if(a==='1') toggleA11y();
  }catch{}
})();

// ── SORT BY YEAR ───────────────────────────────────
// ── PLAY CONTEXT BADGE ────────────────────────────
let _playContext={type:'all',name:''};

function setPlayContext(type, name){
  _playContext={type,name};
  updatePlayCtxBadge();
  // Update queue source label
  const src=document.getElementById('dockQueueSource');
  if(!src) return;
  const icons={all:'',playlist:'≡',artist:'',album:'◉',genre:'◈',year:'📅',flat:''};
  const labels={all:'',playlist:'Playlist',artist:'Artiste',album:'Album',genre:'Genre',year:'Année',flat:''};
  if(type==='all'||type==='flat'||!name){
    src.style.display='none';
  } else {
    src.textContent=`${labels[type]||type} — ${name}`;
    src.style.display='';
  }
}
function updatePlayCtxBadge(){
  const badge=document.getElementById('playCtxBadge');
  const icon=document.getElementById('playCtxIcon');
  const label=document.getElementById('playCtxLabel');
  const nameEl=document.getElementById('playCtxName');
  if(!badge) return;
  const icons={all:'♪',playlist:'≡',artist:'👤',album:'◉',genre:'◈',flat:'♪'};
  const labels={all:'Bibliothèque',playlist:'Playlist',artist:'Artiste',album:'Album',genre:'Genre',flat:'Titres'};
  if(_playContext.type==='all'&&!_playContext.name){badge.style.display='none';return;}
  badge.style.display='flex';
  if(icon) icon.textContent=icons[_playContext.type]||'♪';
  if(label) label.textContent=labels[_playContext.type]||'';
  if(nameEl) nameEl.textContent=_playContext.name?` · ${_playContext.name}`:'';
}

// Patch playFrom/playArtist/playAlbum to set context
const _origPlayFrom=playFrom;
window.playFrom=function(i){
  if(curPl>=0 && allLists[curPl]) setPlayContext('playlist', allLists[curPl].name);
  else setPlayContext('all','');
  _origPlayFrom(i);
};
const _origPlayArtist=playArtist;
window.playArtist=function(artist){
  setPlayContext('artist',artist);
  _origPlayArtist(artist);
};
const _origPlayAlbum=playAlbum;
window.playAlbum=function(artist,album){
  setPlayContext('album',album);
  _origPlayAlbum(artist,album);
};

// ── GROUP CONTEXT MENU ─────────────────────────────
let _grpTracks=null;
let _grpCtxIsAlbum=false;

function showGrpCtxMenu(ev, title, sub, ct, getTracksFn, isAlbum=false){
  if (ev.button !== 2) return;
  
  _grpTracks = getTracksFn;
  _grpCtxIsAlbum = !!isAlbum;
  const menu = document.getElementById('grpCtxMenu');
  
  document.getElementById('grpCtxTitle').textContent = title;
  document.getElementById('grpCtxSub').textContent = sub ? (sub + ' · ' + ct) : ct;

  menu.querySelectorAll('.grp-ctx-edit, .grp-ctx-edit-sep').forEach(el => {
    el.style.display = _grpCtxIsAlbum ? '' : 'none';
  });

  menu.classList.add('on');
  
  // Positionnement comme trackCtxMenu
  let x = ev.clientX, y = ev.clientY;
  // Hauteur RÉELLE (au lieu d'une estimation) → plus de menu coupé en bas d'écran.
  const mw = menu.offsetWidth || 230, mh = menu.offsetHeight || 220;
  if (x + mw > window.innerWidth)  x = window.innerWidth  - mw - 8;
  if (y + mh > window.innerHeight) y = window.innerHeight - mh - 8;
  if (x < 8) x = 8;
  if (y < 8) y = 8;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  
  hideTrackCtxMenu();
}

// Recherche en ligne par LOT depuis le clic droit d'un groupe (artiste ou album).
// Applique direct (genre + année + album si vide) — résultats dans « Corrigé ».
// Pour un ARTISTE on étend aux collabs (même artiste principal, cf _corrGroupKey).
function bulkSearchGroup(){
  const base = (typeof _grpTracks === 'function') ? (_grpTracks() || []) : [];
  let tracks = base;
  if (!_grpCtxIsAlbum && base.length) {
    const solo = _corrSoloKeys(allTracks);
    const k = _corrGroupKey(base[0], solo).key;
    // N'étendre aux collabs que pour un VRAI groupe artiste (tous les morceaux
    // partagent la même clé). Sur une vue Année/Genre le « groupe » couvre
    // plusieurs artistes → on garde le bucket tel quel, sinon on se limiterait
    // à tort au seul artiste du 1er morceau (d'où le faux « rien à compléter »).
    const sameArtist = base.every(t => _corrGroupKey(t, solo).key === k);
    if (sameArtist) tracks = (allTracks || []).filter(t => _corrGroupKey(t, solo).key === k);
  }
  const elig = tracks.filter(t => t && t.path && !t._userModified && !t._ignored);
  if (typeof hideGrpCtxMenu === 'function') hideGrpCtxMenu();
  if (!elig.length) { if (typeof toast === 'function') toast('Rien à compléter (tout est manuel ou verrouillé)'); return; }
  if (typeof enrichQueue !== 'undefined' && enrichQueue.addForce) enrichQueue.addForce(elig, { priority: 20 });
  if (typeof toast === 'function') toast(`🔎 Recherche en ligne sur ${elig.length} morceau(x)… Ce qui manquait (année/genre/album) ira dans « Corrigé ».`);
}
if (typeof window !== 'undefined') window.bulkSearchGroup = bulkSearchGroup;

function hideGrpCtxMenu(){ 
  const menu = document.getElementById('grpCtxMenu');
  menu.classList.remove('on'); 
  _grpTracks = null; 
  _grpCtxIsAlbum = false; 
}

function grpCtxPlay(){
  if(!_grpTracks) return;
  const ts=_grpTracks();
  if(!ts.length) return;
  queue=ts.map(t=>({...t,url:pathToUrl(t.path)}));
  const title=document.getElementById('grpCtxTitle').textContent;
  setPlayContext('album',title);
  playIdx(0); hideGrpCtxMenu();
}
function grpCtxAddQueue(){
  if(!_grpTracks) return;
  const ts=_grpTracks();
  ts.forEach(t=>queue.push({...t,url:pathToUrl(t.path)}));
  toast(`+${ts.length} morceau${ts.length!==1?'x':''} ajouté${ts.length!==1?'s':''} à la file`);
  hideGrpCtxMenu();
}
function grpCtxAddSync(){
  if(!_grpTracks) return;
  const ts=_grpTracks();
  let added=0;
  ts.forEach(t=>{
    if(t.path && !syncSel.has(t.path)){ syncSel.add(t.path); added++; }
  });
  const title=document.getElementById('grpCtxTitle').textContent;
  if(added===0){
    toast(`"${title}" — déjà dans Sync`);
  } else {
    toast(`✓ "${title}" → +${added} morceau${added!==1?'x':''} au Sync`);
  }
  // Refresh sync display + counters
  updateSyncStats([...allTracks.filter(x=>syncSel.has(x.path))]);
  if(typeof renderSyncQueue==='function' && document.getElementById('syncView')?.classList.contains('on')){
    renderSyncQueue();
  }
  // Refresh main list so the sync checkboxes update
  if(typeof renderVirtual==='function') renderVirtual();
  hideGrpCtxMenu();
}
function grpCtxNewPlaylist(){
  if(!_grpTracks) return;
  const ts=_grpTracks();
  const title=document.getElementById('grpCtxTitle').textContent;
  allLists.push({name:title,tracks:ts,count:ts.length,custom:true});
  renderSidebar(); scheduleSave();
  toast(`✓ Playlist "${title}" créée · ${ts.length} morceaux`);
  hideGrpCtxMenu();
}
function grpCtxSmartPlaylist(){
  hideGrpCtxMenu();
  const title=document.getElementById('grpCtxTitle').textContent;
  // Pre-fill smart modal with album name
  editingSmartIdx=-1;
  smartRules=[{field:'album',op:'contains',val:title}];
  document.getElementById('smartName').value=title;
  document.getElementById('ovSmart').classList.add('on');
  renderSmartRules(); updateSmartCount();
}
function grpCtxAddToPlaylist(){
  if(!_grpTracks) return;
  const menu=document.getElementById('grpCtxMenu');
  const r=menu.getBoundingClientRect();
  openPlPicker(r.right+4, r.top, _grpTracks, ()=>hideGrpCtxMenu());
}



// 2. Click on Mini-Player Cover
// ============================================================
// OUVRIR L'ÉDITEUR DE POCHEtte - Version PRO avec attente
// ============================================================


// État "batch album" pour tctxSaveEdit
let _tctxBatchAlbum = null;

// ── PLAYLIST PICKER ───────────────────────────────
let _ppGetTracks=null, _ppOnDone=null;

function openPlPicker(x, y, getTracksFn, onDone){
  _ppGetTracks=getTracksFn; _ppOnDone=onDone||null;
  const pp=document.getElementById('plPickerEl');
  // Build list
  const list=document.getElementById('plPickerList');
  list.innerHTML=allLists.length
    ? allLists.map((pl,i)=>`<div class="pl-picker-item" onclick="plPickerAdd(${i})">${esc(pl.name)} <span style="color:var(--t3);font-family:var(--font-mono);font-size:9px;margin-left:auto">${pl.count}</span></div>`).join('')
    : '<div style="padding:8px 12px;font-family:var(--font-body);font-size:11px;color:var(--t3)">Aucune playlist</div>';
  pp.classList.add('on');
  const pw=200, ph=Math.min(280, 32+(allLists.length||0)*34);
  let fx=x, fy=y;
  if(fx+pw>window.innerWidth) fx=window.innerWidth-pw-8;
  if(fy+ph>window.innerHeight) fy=window.innerHeight-ph-8;
  pp.style.left=fx+'px'; pp.style.top=fy+'px';
}
function hidePlPicker(){ document.getElementById('plPickerEl').classList.remove('on'); _ppGetTracks=null; _ppOnDone=null; }

function plPickerAdd(i){
  if(!_ppGetTracks||!allLists[i]) return;
  const ts=_ppGetTracks();
  const pl=allLists[i];
  let added=0;
  ts.forEach(t=>{ if(!pl.tracks.find(x=>x.path===t.path)){pl.tracks.push(t);added++;} });
  pl.count=pl.tracks.length;
  renderSidebar(); scheduleSave();
  toast(`✓ ${added} morceau${added!==1?'x':''} → "${pl.name}"`);
  hidePlPicker(); if(_ppOnDone) _ppOnDone();
}
function plPickerNewPlaylist(){
  if(!_ppGetTracks) return;
  const ts=_ppGetTracks();
  const name=`Playlist ${allLists.filter(l=>l.custom).length+1}`;
  allLists.push({name,tracks:ts,count:ts.length,custom:true});
  renderSidebar(); scheduleSave();
  toast(`✓ "${name}" créée · ${ts.length} morceaux`);
  hidePlPicker(); if(_ppOnDone) _ppOnDone();
}

// Patch tctxOpenPlPicker for track ctx menu
function tctxOpenPlPicker(){
  const ts = _tctxTargetTracks();
  if(!ts.length) return;
  const menu=document.getElementById('trackCtxMenu');
  const r=menu.getBoundingClientRect();
  openPlPicker(r.right+4, r.top+80, ()=>ts, ()=>hideTrackCtxMenu());
}

// Restore customCovers if main sends them (future-proof IPC channel)
window.wt.on('coversRestored', covers=>{ if(covers) Object.assign(customCovers,covers); });

// ── NAVIGATE TO ARTIST / ALBUM / GENRE / YEAR ────────────────────
// Refonte navigation desktop : on déplie TOUTE la chaîne accordéon
// (groupe → sous-artiste → sous-album) puis on cible la LIGNE DU MORCEAU
// (type:'track'), pas le bandeau parent.
//
// Pourquoi pas scrollIntoView sur un élément DOM ? La liste est virtualisée
// (renderGrouped ne crée le DOM que pour les rows visibles). Un morceau hors
// viewport n'existe pas encore dans le DOM → querySelector renverrait null.
// On recalcule donc les rows via buildGroupedRows, on lit la position y de la
// track cible, et on pose lw.scrollTop directement. Robuste, sans dépendre du
// DOM. Le rendu virtuel suit le scroll et matérialise la bonne row.

// Calcule les clés accordéon à déplier pour atteindre un morceau `t` dans le
// `mode` donné. Retourne { groupKey (artistExpanded), subKeys[] (albumExpanded) }.
function _expandChainFor(mode, t){
  const artist = t.artist || '(Artiste inconnu)';
  const album  = t.album  || '(Album inconnu)';
  const genre  = t.genre  || '(Sans genre)';
  if(mode==='artist'){
    return { groupKey: artist, subKeys: [artist+'||'+album] };
  }
  if(mode==='album'){
    return { groupKey: 'AL_'+album, subKeys: [] };
  }
  if(mode==='genre'){
    const g='GN_'+genre, a=g+'|'+artist, ab=a+'|'+album;
    return { groupKey: g, subKeys: [a, ab] };
  }
  if(mode==='year'){
    const yr=t.year||0;
    let bk;
    if(!yr) bk='unknown';
    else if(yr>=1910){ const dec=Math.floor(yr/10)*10; bk='dec-'+dec; }
    else { const c=Math.floor((yr-1)/100)+1; bk='cent-'+c; }
    const g='YR_'+bk, a=g+'|'+artist, ab=a+'|'+album;
    return { groupKey: g, subKeys: [a, ab] };
  }
  return { groupKey: null, subKeys: [] };
}

// Déplie la chaîne menant à `targetPath` (ou au morceau en cours) puis scrolle
// la liste jusqu'à la LIGNE DU MORCEAU. Si targetPath est absent, on se
// contente de déplier + scroller au bandeau de tête (clic depuis la vue plate
// sur un nom d'artiste/album, sans morceau précis à cibler).
function _navScrollToTrack(mode, targetPath){
  const t = targetPath
    ? (filtered.find(x=>x.path===targetPath) || allTracks.find(x=>x.path===targetPath))
    : null;

  // 1) Déplier la chaîne. Si on a un morceau cible, on suit sa chaîne complète.
  //    Sinon (clic flat sans path), on déplie juste le groupe de tête déduit
  //    de l'argument passé (géré par les wrappers via un faux track partiel).
  if(t){
    const {groupKey, subKeys} = _expandChainFor(mode, t);
    if(groupKey) artistExpanded.add(groupKey);
    subKeys.forEach(k=>albumExpanded.add(k));
  }
  renderVirtual();
  updateBreadcrumb();

  // 2) Recalculer les rows et trouver la position de la track (ou du groupe).
  const lw=document.getElementById('lw');
  if(!lw) return;
  setTimeout(()=>{
    const {rows}=buildGroupedRows(mode);
    let targetY=null;
    if(t){
      const hit=rows.find(r=>r.type==='track' && r.t && r.t.path===t.path);
      if(hit) targetY=hit.y;
    }
    // Fallback : si pas de track ciblée (pas de path, ou track introuvable
    // dans le mode courant), on vise le bandeau de tête.
    if(targetY===null){
      const {groupKey} = t ? _expandChainFor(mode,t) : { groupKey:_navHeadKey };
      const head=rows.find(r=>(r.key===groupKey));
      if(head) targetY=head.y;
    }
    if(targetY===null) return;
    // Centrer dans la fenêtre visible (clamp aux bornes).
    const target=Math.max(0, targetY - (lw.clientHeight/2) + 40);
    lw.scrollTo({top:target, behavior:'smooth'});
  },160);
}

// Clé de groupe de tête mémorisée pour le fallback "clic flat sans path".
let _navHeadKey=null;

function navigateToArtist(artist, targetPath){
  if(!artist) return;
  setViewMode('artist', true);
  _navHeadKey = artist;
  _navScrollToTrack('artist', targetPath);
}

function navigateToAlbum(album, targetPath){
  if(!album) return;
  setViewMode('album', true);
  _navHeadKey = 'AL_'+album;
  // En vue album sans morceau cible, on déplie quand même le groupe pour
  // montrer son contenu (cohérent avec l'ancien comportement).
  if(!targetPath) artistExpanded.add('AL_'+album);
  _navScrollToTrack('album', targetPath);
}

function navigateToGenre(genre, targetPath){
  if(!genre) return;
  setViewMode('genre', true);
  _navHeadKey = 'GN_'+genre;
  if(!targetPath) artistExpanded.add('GN_'+genre);
  _navScrollToTrack('genre', targetPath);
}

function navigateToYear(year, targetPath){
  const yr = year || 0;
  let key;
  if(!yr){ key='unknown'; }
  else if(yr>=1910){ const dec=Math.floor(yr/10)*10; key='dec-'+dec; }
  else { const c=Math.floor((yr-1)/100)+1; key='cent-'+c; }
  setViewMode('year', true);
  _navHeadKey = 'YR_'+key;
  if(!targetPath) artistExpanded.add('YR_'+key);
  _navScrollToTrack('year', targetPath);
}

// Depuis le fullscreen : ferme l'overlay puis va à la liste groupée
// correspondante du morceau EN COURS. On passe son path → ciblage du morceau.
function _fsNavTo(kind){
  const t = queue[qi];
  if(!t) return;
  closeFullscreen();
  setTimeout(()=>{
    if(kind==='artist') navigateToArtist(t.artist || '(Artiste inconnu)', t.path);
    else if(kind==='album') navigateToAlbum(t.album || '(Album inconnu)', t.path);
    else if(kind==='genre') navigateToGenre(t.genre || '(Sans genre)', t.path);
    else if(kind==='year') navigateToYear(t.year || 0, t.path);
  }, 120);
}

// Appelé au changement de tab : déplie la chaîne + scrolle vers le MORCEAU
// en cours. NE PASSE PAS par navigateToX (qui rappellerait setViewMode →
// récursion) : viewMode est déjà positionné par l'appelant.
function goToCurrentInView(){
  const t = queue[qi];
  if(!t) return;  // rien en lecture → pas de scroll
  if(viewMode!=='artist' && viewMode!=='album' && viewMode!=='genre' && viewMode!=='year') return;
  const {groupKey, subKeys} = _expandChainFor(viewMode, t);
  if(groupKey) artistExpanded.add(groupKey);
  subKeys.forEach(k=>albumExpanded.add(k));
  renderVirtual();
  const lw=document.getElementById('lw');
  if(!lw) return;
  setTimeout(()=>{
    const {rows}=buildGroupedRows(viewMode);
    const hit=rows.find(r=>r.type==='track' && r.t && r.t.path===t.path);
    let targetY = hit ? hit.y : null;
    if(targetY===null){
      const head=rows.find(r=>r.key===groupKey);
      if(head) targetY=head.y;
    }
    if(targetY===null) return;
    const target=Math.max(0, targetY - (lw.clientHeight/2) + 40);
    lw.scrollTo({top:target, behavior:'smooth'});
  },160);
}

// ══════════════════════════════════════════════════════════════
// MODE FULLSCREEN IMMERSIF
// Pochette à gauche grande, infos + détails éditables à droite,
// flèches précédent/suivant ultra-fines sur les bords.
// ══════════════════════════════════════════════════════════════
let _fsActive = false;

// Limite d'affichage de la queue dans le drawer fullscreen. Étendue via
// le bouton "+ N restants" qui appelle _fsLoadMoreQueue().
let _fsQueueLimit = 25;

/**
 * Étend la queue affichée dans le drawer fullscreen, par paliers de 50.
 * Re-render automatique.
 */
function _fsLoadMoreQueue() {
  _fsQueueLimit += 50;
  _fsRenderQueue();
}

/**
 * Reset la limite quand on ouvre/ferme le drawer (état frais à chaque ouverture).
 */
function _fsResetQueueLimit() {
  _fsQueueLimit = 25;
}

function toggleFullscreen(){
  const ov = document.getElementById('fsOverlay');
  if(!ov) return;
  if(_fsActive){
    closeFullscreen();
  } else {
    openFullscreen();
  }
}

function openFullscreen() {
  const ov = document.getElementById('fsOverlay');
  if (!ov) return;
  _fsActive = true;
  _fsRefresh();
  
  // Force display and add class for animation
  ov.style.display = 'flex';
  requestAnimationFrame(() => ov.classList.add('on'));
  
  // IMPORTANT: Set tabindex to make the overlay focusable for keyboard events
  ov.setAttribute('tabindex', '0');
  ov.focus();
  
  // Use capture phase to ensure we can stop propagation before it reaches the editor
  document.addEventListener('keydown', _fsKey, true);
  
  // Prevent body scroll when fullscreen is open
  document.body.style.overflow = 'hidden';

  // Visualiseur réactif : démarre avec l'overlay (init lazy du graphe
  // Web Audio au premier fullscreen — on est dans un geste utilisateur).
  if (typeof _fsVizStart === 'function') _fsVizStart();
  // C202 : aligne le fader volume fullscreen sur l'état courant
  if (typeof _fsVolSync === 'function') _fsVolSync();
}

function closeFullscreen() {
  const ov = document.getElementById('fsOverlay');
  if (!ov) return;
  _fsActive = false;
  ov.classList.remove('on');
  ov.removeAttribute('tabindex');
  setTimeout(() => {
    if (!_fsActive && ov) ov.style.display = 'none';
    document.querySelectorAll('.fs-detail-edit').forEach(el => _fsCommitDetail(el.dataset.field));
  }, 260);
  
  // Remove the listener (must match the capture flag)
  document.removeEventListener('keydown', _fsKey, true);
  
  // Restore body scroll
  document.body.style.overflow = '';

  // Visualiseur réactif : stoppe la boucle rAF (zéro CPU hors fullscreen).
  if (typeof _fsVizStop === 'function') _fsVizStop();
}

function _fsKey(e) {
  if (!_fsActive) return;
  
  // ✅ IMPORTANT: Don't intercept keys if user is typing in an input or textarea
  const target = e.target;
  const isTyping = target.tagName === 'INPUT' || 
                   target.tagName === 'TEXTAREA' || 
                   target.isContentEditable ||
                   target.classList?.contains('batch-in') ||
                   target.classList?.contains('rule-in') ||
                   target.id === 'omniSearchIn' ||
                   target.id === 'smartName';
  
  // Spacebar - toggle play/pause (only if not typing)
  if ((e.code === 'Space' || e.key === ' ' || e.key === 'Space') && !isTyping) {
    e.preventDefault();
    e.stopPropagation();
    if (au.paused) {
      au.play();
    } else {
      au.pause();
    }
    // Update the play button icon in fullscreen
    const fsPlayIcon = document.getElementById('fsPlayIcon');
    if (fsPlayIcon) {
      fsPlayIcon.innerHTML = au.paused ? 
        '<polygon points="6 3 20 12 6 21 6 3"/>' : 
        '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
    }
    return;
  }
  
  // Escape - close fullscreen (only if not typing).
  // Si le drawer queue est ouvert, Echap ferme d'abord le drawer (pas le fullscreen).
  if (e.key === 'Escape' && !isTyping) {
    const drawer = document.getElementById('fsQDrawer');
    if (drawer && drawer.classList.contains('open')) {
      e.preventDefault();
      _fsToggleQueue();
      return;
    }
    e.preventDefault();
    closeFullscreen();
    return;
  }

  // Q - toggle file d'attente (drawer)
  if ((e.key === 'q' || e.key === 'Q') && !isTyping) {
    e.preventDefault();
    _fsToggleQueue();
    return;
  }

  // Arrow Right - next track (only if not typing)
  if (e.key === 'ArrowRight' && !isTyping) {
    e.preventDefault();
    nextTrack();
    return;
  }
  
  // Arrow Left - previous track (only if not typing)
  if (e.key === 'ArrowLeft' && !isTyping) {
    e.preventDefault();
    prevTrack();
    return;
  }
}

// Rafraîchir l'affichage fullscreen selon le morceau courant
function _fsRefresh() {
  const t = queue[qi];
  const fsTitle  = document.getElementById('fsTitle');
  const fsArtist = document.getElementById('fsArtist');
  const fsAlbum  = document.getElementById('fsAlbum');
  const fsYear   = document.getElementById('fsYear');
  const fsGenre  = document.getElementById('fsGenre');

  if (!t) {
    if (fsTitle)  { fsTitle.textContent = '–';  fsTitle.title = ''; }
    if (fsArtist) { fsArtist.textContent = '–'; fsArtist.title = ''; }
    if (fsYear)   fsYear.textContent = '';
    if (fsGenre)  { fsGenre.textContent = ''; fsGenre.style.color = ''; }
    if (fsAlbum)  { fsAlbum.textContent = ''; fsAlbum.title = ''; }
    _fsRefreshCtrls();
    return;
  }

  // Mise à jour des textes — title= sert de tooltip natif quand le texte est tronqué
  const tTitle  = t.title  || '–';
  const tArtist = t.artist || '–';
  const tAlbum  = t.album  || '';
  const tYear   = t.year   || '';
  const tGenre  = t.genre  || '';

  if (fsTitle)  { fsTitle.textContent  = tTitle;  fsTitle.title  = tTitle; }
  if (fsArtist) { fsArtist.textContent = tArtist; fsArtist.title = tArtist; }
  if (fsAlbum)  { fsAlbum.textContent  = tAlbum;  fsAlbum.title  = tAlbum; }
  // Transparence : un champ vide n'est plus muet. « recherche en cours… »
  // pendant la vérification play→auto, « introuvable en ligne » si la recherche
  // a déjà eu lieu sans résultat fiable (persisté entre les sessions).
  const _checkedNoInfo = !!(t._autoProcessed && (t._autoOutcome === 'refused' || t._autoOutcome === 'empty'));
  const _stateTxt = t._verifying ? 'recherche en cours…' : (_checkedNoInfo ? 'introuvable en ligne' : '');
  if (fsYear) {
    fsYear.textContent = tYear || _stateTxt || '—';
    fsYear.style.opacity = tYear ? '' : '.55';
    fsYear.style.fontStyle = tYear ? '' : 'italic';
  }

  // Genre : applique la couleur de genre comme valeur ET comme hue de fond
  if (fsGenre) {
    fsGenre.textContent = tGenre || _stateTxt || '—';
    fsGenre.title = tGenre;
    fsGenre.style.color = tGenre ? getGenreColor(tGenre) : '';
    fsGenre.style.opacity = tGenre ? '' : '.55';
    fsGenre.style.fontStyle = tGenre ? '' : 'italic';
  }

  // Dégradé d'ambiance teinté par le genre — variable CSS sur l'overlay
  const fsOverlay = document.getElementById('fsOverlay');
  if (fsOverlay) {
    fsOverlay.style.setProperty('--fs-hue', getGenreColorRgba(tGenre, 0.22));
  }

  // Artwork (inchangé)
  const fsArt = document.getElementById('fsArtImg');
  let coverUrl = null;
  if (typeof customCovers !== 'undefined' && customCovers[t.path]) {
    coverUrl = customCovers[t.path];
  } else if (t._art) {
    coverUrl = t._art;
  } else {
    const playerImg = document.getElementById('pArt')?.querySelector('img');
    if (playerImg && playerImg.src && !playerImg.src.includes('data:image/svg')) {
      coverUrl = playerImg.src;
    }
  }
  if (fsArt) {
    if (coverUrl && coverUrl.length > 20) {
      fsArt.style.backgroundImage = `url("${coverUrl.replace(/"/g, '\\"')}")`;
      fsArt.classList.remove('no-art');
    } else {
      fsArt.style.backgroundImage = 'none';
      fsArt.classList.add('no-art');
    }
  }

  _fsRefreshCtrls();

  // État du sound-wave : pause si audio en pause, sinon anime
  const fsOv = document.getElementById('fsOverlay');
  if (fsOv) {
    const isPaused = (typeof au !== 'undefined' && au && au.paused);
    fsOv.classList.toggle('paused', isPaused);
  }
// Handle queue : indicateur visuel "has-items" si la queue a plus que le
  // morceau courant (au moins 1 morceau à venir).
  const fsHandle = document.getElementById('fsQueueHandle');
  if (fsHandle) {
    const hasUpcoming = queue.length > 1;
    fsHandle.classList.toggle('has-items', hasUpcoming);
  }
  // Maj favori
  if (typeof updatePlayingFavoriteUI === 'function') updatePlayingFavoriteUI();

  // Note : on n'appelle plus checkFsOverflow (marquee remplacé par fs-text-clamp)
}



// Mettre à jour l'état des boutons de contrôle (shuffle/repeat/sync on/off)
function _fsRefreshCtrls(){
  const sh = document.getElementById('fsShuffleBtn');
  const sy = document.getElementById('fsSyncBtn');
  if(sh) sh.classList.toggle('on', shuffle);
  // Repeat: utiliser updateRepeatUI qui gère icône + classe
  if(typeof updateRepeatUI === 'function') updateRepeatUI();
  const t = queue[qi];
  if(sy) sy.classList.toggle('on', !!(t && t.path && syncSel.has(t.path)));
  if(typeof _refreshNoShuffleBtn === 'function') _refreshNoShuffleBtn();
  if(typeof _refreshSleepBtn === 'function') _refreshSleepBtn();
  if(typeof _fsRefreshTransport === 'function') _fsRefreshTransport();
}

// ── FULLSCREEN — Transport avancé v2 : slider de vitesse + boucle A-B + seek ──
// Vitesse : slider continu 0.5×→2× (pitch préservé par Chromium — idéal pour
// travailler un passage) ; defaultPlaybackRate → la vitesse survit au
// changement de piste ; clic sur le libellé = retour 1×.
// Boucle A-B : boutons A et B séparés (façon Music Speed Changer) — chaque clic
// (re)pose son point à la position actuelle, repères visibles sur la barre,
// ✕ efface. Effacée au changement de piste, active même hors fullscreen.
let _fsLoopA = null, _fsLoopB = null;

function _fsSpeedSet(rate){
  rate = Math.max(0.25, Math.min(2, rate || 1));
  au.playbackRate = rate;
  au.defaultPlaybackRate = rate;
  _fsRefreshTransport();
}
function _fsSpeedReset(){ _fsSpeedSet(1); }

// Chips A et B en TOGGLE : clic sur un point non posé = le poser à la position
// actuelle ; clic sur un point posé = le retirer (puis re-clic pour le reposer
// ailleurs). La boucle tourne dès que A et B sont posés tous les deux.
function _fsLoopSetA(){
  if(_fsLoopA != null){
    _fsLoopA = null;
    if(typeof toast === 'function') toast('Point A retiré');
  } else {
    _fsLoopA = au.currentTime || 0;
    if(_fsLoopB != null && _fsLoopB <= _fsLoopA + 0.3) _fsLoopB = null; // B devenu invalide → à reposer
    if(typeof toast === 'function') toast(_fsLoopB != null ? 'Boucle A-B active' : 'Point A posé — pose B pour boucler');
  }
  _fsRefreshTransport();
}
function _fsLoopSetB(){
  if(_fsLoopB != null){
    _fsLoopB = null;
    if(typeof toast === 'function') toast('Point B retiré — re-clique sur B pour le poser ailleurs');
    _fsRefreshTransport();
    return;
  }
  const b = au.currentTime || 0;
  if(_fsLoopA == null) _fsLoopA = 0; // pas de A → boucle depuis le début
  if(b <= _fsLoopA + 0.3){ if(typeof toast === 'function') toast('B doit être après A'); return; }
  _fsLoopB = b;
  if(typeof toast === 'function') toast('Boucle A-B active');
  _fsRefreshTransport();
}
function _fsClearLoop(){
  const had = (_fsLoopA != null || _fsLoopB != null);
  _fsLoopA = null; _fsLoopB = null;
  if(had && typeof toast === 'function') toast('Boucle A-B effacée');
  _fsRefreshTransport();
}

// Maj des libellés/états du transport (slider, chips A/B, repères sur la barre)
function _fsRefreshTransport(){
  const rate = au.playbackRate || 1;
  document.querySelectorAll('.fs-speed-chip').forEach(b => {
    b.classList.toggle('on', Math.abs(parseFloat(b.dataset.rate) - rate) < 0.001);
  });
  const a = _fsLoopA, b = _fsLoopB, dur = au.duration || 0;
  const pct = v => dur ? Math.max(0, Math.min(100, (v / dur) * 100)) : 0;
  const btnA = document.getElementById('fsLoopABtn');
  const btnB = document.getElementById('fsLoopBBtn');
  const btnX = document.getElementById('fsLoopClearBtn');
  if(btnA){ btnA.classList.toggle('set', a != null); btnA.textContent = a != null ? 'A ' + fmt(a) : 'A'; }
  if(btnB){ btnB.classList.toggle('set', b != null); btnB.textContent = b != null ? 'B ' + fmt(b) : 'B'; }
  if(btnX) btnX.style.display = (a != null || b != null) ? '' : 'none';
  const tA = document.getElementById('fsSeekTickA');
  const tB = document.getElementById('fsSeekTickB');
  if(tA){ const on = a != null && dur; tA.style.display = on ? 'block' : 'none'; if(on) tA.style.left = pct(a) + '%'; }
  if(tB){ const on = b != null && dur; tB.style.display = on ? 'block' : 'none'; if(on) tB.style.left = pct(b) + '%'; }
  const seg = document.getElementById('fsSeekLoop');
  if(seg){
    if(a != null && b != null && dur){
      seg.style.left = pct(a) + '%';
      seg.style.width = Math.max(0.5, pct(b) - pct(a)) + '%';
      seg.style.display = 'block';
    } else seg.style.display = 'none';
  }
}



// Clic sur la barre fullscreen → seek direct
(function(){
  const bar = document.getElementById('fsSeekBar');
  if(!bar) return;
  bar.addEventListener('mousedown', e => {
    if(!au.duration) return;
    const r = bar.getBoundingClientRect();
    au.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * au.duration;
    e.preventDefault();
  });
})();

// Menu de veille (lune en haut à droite) : choix explicite au lieu du cycle.
function _fsSleepMenuToggle(ev){
  if(ev) ev.stopPropagation();
  const pop = document.getElementById('fsSleepPop');
  if(!pop) return;
  const open = pop.classList.toggle('open');
  if(open) _fsSleepMarkActive();
}
function _fsSleepMarkActive(){
  const pop = document.getElementById('fsSleepPop');
  if(!pop) return;
  pop.querySelectorAll('.fs-sleep-opt').forEach(b => {
    const v = b.dataset.min;
    b.classList.toggle('on', b.dataset.noact ? _sleepChosen === 'tracks' : String(_sleepChosen) === v);
  });
}
(function(){
  const pop = document.getElementById('fsSleepPop');
  if(!pop) return;
  pop.addEventListener('click', e => {
    const b = e.target.closest('.fs-sleep-opt');
    if(!b) return;
    e.stopPropagation();
    if(b.dataset.noact) return; // ligne « Au bout de N morceaux » : bouton OK dédié
    const v = b.dataset.min;
    if(v === 'eot') setSleepEndOfTrack();
    else setSleep(parseInt(v) || 0);
    _fsSleepMarkActive();
    pop.classList.remove('open');
  });
  document.addEventListener('click', e => {
    if(!pop.classList.contains('open')) return;
    if(e.target.closest('#fsSleepPop') || e.target.closest('#fsSleepTop')) return;
    pop.classList.remove('open');
  });
})();

// timeupdate dédié : progression fullscreen + application de la boucle A-B.
au.addEventListener('timeupdate', () => {
  if(_fsLoopA != null && _fsLoopB != null && au.currentTime >= _fsLoopB){
    au.currentTime = _fsLoopA;
  }
  if(typeof _fsActive !== 'undefined' && _fsActive && au.duration){
    const p = (au.currentTime / au.duration) * 100;
    const f = document.getElementById('fsSeekFill'); if(f) f.style.width = p + '%';
    const c = document.getElementById('fsCur'); if(c) c.textContent = fmt(au.currentTime);
    const d = document.getElementById('fsDur'); if(d) d.textContent = fmt(au.duration);
  }
});

// Récupère l'URL de la pochette actuellement affichée dans le miniplayer
function _fsCurrentArtUrl(){
  const pArt = document.getElementById('pArt');
  const img = pArt?.querySelector('img');
  return img?.src || null;
}

// ============================================================
// FULLSCREEN — Drawer file d'attente
// ============================================================

/**
 * Toggle l'ouverture/fermeture du drawer file d'attente fullscreen.
 * Quand ouvert, le handle "FILE D'ATTENTE" se cache (CSS via .q-open).
 */
function _fsToggleQueue() {
  const drawer = document.getElementById('fsQDrawer');
  const overlay = document.getElementById('fsOverlay');
  if (!drawer || !overlay) return;

  const isOpen = drawer.classList.toggle('open');
  overlay.classList.toggle('q-open', isOpen);

  if (isOpen) {
    _fsResetQueueLimit();
    _fsRenderQueue();
    // Click outside ferme le drawer. Délai pour ne pas catcher le click
    // qui vient d'ouvrir le drawer lui-même.
    setTimeout(() => {
      document.addEventListener('click', _fsHandleClickOutside, true);
    }, 50);
  } else {
    document.removeEventListener('click', _fsHandleClickOutside, true);
  }
}

/**
 * Ferme le drawer si l'user clique en dehors. Le drawer lui-même + le handle
 * (qui sert de toggle) restent cliquables sans fermer.
 */
function _fsHandleClickOutside(e) {
  const drawer = document.getElementById('fsQDrawer');
  const handle = document.getElementById('fsQueueHandle');
  if (!drawer) return;
  // Si le click est dans le drawer ou sur le handle, ne pas fermer
  if (drawer.contains(e.target)) return;
  if (handle && handle.contains(e.target)) return;
  // Sinon, ferme
  _fsToggleQueue();
}
/**
 * Render la file d'attente dans le drawer fullscreen. Réutilise la même
 * structure HTML que la mini queue (.mini-q-item, .mini-q-rm, etc.) pour
 * que les listeners drag-drop et clic-droit fonctionnent de la même façon.
 */
function _fsRenderQueue() {
  const list = document.getElementById('fsQList');
  const lbl = document.getElementById('fsQDrawerLabel');
  const ct = document.getElementById('fsQDrawerCt');
  if (!list) return;

  if (!queue.length) {
    if (lbl) lbl.textContent = "File d'attente";
    if (ct) ct.textContent = '';
    list.innerHTML = "<div class='mini-q-empty'>Aucun morceau en lecture</div>";
    return;
  }

  // Construit la même structure que _miniQueueItems
  const items = [];
  // Passé (historique)
  playbackHistory.forEach(idx => {
    if (queue[idx] && idx !== qi) {
      items.push({ t: queue[idx], idx: idx, isPlayed: true });
    }
  });
  // Présent
  if (queue[qi]) items.push({ t: queue[qi], idx: qi, isCurrent: true });
  // Futur
  if (shuffle && _shuffleOrder.length) {
    const curPos = _shuffleOrder.indexOf(qi);
    const start = curPos >= 0 ? curPos + 1 : 0;
    for (let k = start; k < _shuffleOrder.length; k++) {
      const idx = _shuffleOrder[k];
      if (idx !== qi) items.push({ t: queue[idx], idx: idx });
    }
  } else {
    for (let k = 1; k < queue.length; k++) {
      const i = (qi + k) % queue.length;
      if (i === qi) break;
      if (i < qi && repeat !== 'all') break;
      items.push({ t: queue[i], idx: i });
    }
  }

  // Labels (compteur sur TOUS les morceaux, pas juste affichés)
  if (lbl) lbl.textContent = shuffle ? 'Aléatoire' : "File d'attente";
  if (ct) ct.textContent = `· ${items.length} morceau${items.length !== 1 ? 'x' : ''}`;

  // Pagination : on n'affiche que les `_fsQueueLimit` premiers items.
  // Bouton "+ Plus" pour étendre, même UX que la mini queue.
  const totalItems = items.length;
  const limit = _fsQueueLimit;
  const visibleItems = items.slice(0, limit);
  const remaining = totalItems - visibleItems.length;

  // Render des items visibles (même structure que renderMiniQueue)
  let html = visibleItems.map((item, pos) => {
    const now = item.isCurrent;
    const played = item.isPlayed;
    let classes = 'mini-q-item';
    if (now) classes += ' now';
    if (played) classes += ' played';

    return '<div class="' + classes + '" data-pos="' + pos + '" draggable="true" '
      + 'oncontextmenu="showQueueCtxMenu(event, ' + item.idx + ')">'
      + '<span class="mini-q-handle">⠿</span>'
      + '<div class="mini-q-info" onclick="miniQueueClick(' + item.idx + ')">'
      + '<div class="mini-q-title">' + (played ? '✓ ' : '') + esc(item.t && item.t.title || '') + '</div>'
      + '<div class="mini-q-art">' + esc(item.t && item.t.artist || '') + '</div>'
      + '</div>'
      + '<button class="mini-q-rm" onclick="event.stopPropagation();dockRmQ(' + item.idx + ',{stopPropagation:()=>{}})" title="Retirer">✕</button>'
      + '</div>';
  }).join('');

  // Bouton "+ N morceaux" si on n'affiche pas tout
  if (remaining > 0) {
    html += '<div class="mini-q-more" onclick="_fsLoadMoreQueue()">'
      + '+ ' + remaining + ' morceau' + (remaining > 1 ? 'x' : '') + ' restant'
      + (remaining > 1 ? 's' : '') + '</div>';
  }

  list.innerHTML = html;

  // ── Attache les listeners drag-drop sur les items du fs drawer ──
  // Logique identique à _miniRenderList mais ciblée sur fsQList.
  const els = list.querySelectorAll('.mini-q-item');
  els.forEach(el => {
    el.addEventListener('dragstart', e => {
      _miniDragSrc = parseInt(el.dataset.pos);
      el.classList.add('mini-dragging');
      e.dataTransfer.effectAllowed = 'copyMove';
      try { e.dataTransfer.setDragImage(el, 20, 20); } catch (_) {}

      // Pose les données du morceau pour drop externe (Sync, playlists, etc.)
      const localItems = items; // capture par closure
      const item = localItems[_miniDragSrc];
      const t = item && item.t;
      if (t) {
        try {
          e.dataTransfer.setData('track', JSON.stringify(t));
          e.dataTransfer.setData('tracks', JSON.stringify([t]));
        } catch (_) {}
      }
    });
    el.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = (_miniDragSrc === -1) ? 'copy' : 'move';
      const dragging = list.querySelector('.mini-dragging');
      if (dragging === el) return;
      els.forEach(i => i.classList.remove('mini-drop-above', 'mini-drop-below'));
      const bound = el.getBoundingClientRect();
      const above = (e.clientY - bound.top) < bound.height / 2;
      el.classList.add(above ? 'mini-drop-above' : 'mini-drop-below');
    });
    el.addEventListener('dragleave', () => {
      el.classList.remove('mini-drop-above', 'mini-drop-below');
    });
    el.addEventListener('drop', e => {
      e.preventDefault();
      e.stopPropagation();
      const targetPos = parseInt(el.dataset.pos);
      const above = el.classList.contains('mini-drop-above');
      let toLogicalPos = above ? targetPos : targetPos + 1;

      if (_miniDragSrc !== -1 && el !== list.querySelector('.mini-dragging')) {
        if (_miniDragSrc < toLogicalPos) toLogicalPos--;
        if (toLogicalPos !== _miniDragSrc) applyQueueReorder(_miniDragSrc, toLogicalPos);
      }
      els.forEach(i => i.classList.remove('mini-drop-above', 'mini-drop-below', 'mini-dragging'));
      _miniDragSrc = -1;
      // Re-render pour refléter le nouvel ordre
      setTimeout(_fsRenderQueue, 50);
    });
    el.addEventListener('dragend', () => {
      els.forEach(i => i.classList.remove('mini-drop-above', 'mini-drop-below', 'mini-dragging'));
      _miniDragSrc = -1;
    });
  });
}

async function verifyMetadata(artist, album) {
  const query = encodeURIComponent(`${artist} ${album}`);
  const results = { years: [], genres: [], covers: [] };

  // 1. Appel iTunes
  const pItunes = fetch(`https://itunes.apple.com/search?term=${query}&entity=album&limit=1`)
    .then(r => r.json())
    .then(data => {
      if (data.results?.[0]) {
        const res = data.results[0];
        if (res.releaseDate) results.years.push(new Date(res.releaseDate).getFullYear());
        if (res.primaryGenreName) results.genres.push(res.primaryGenreName);
        results.covers.push(res.artworkUrl100.replace('100x100bb', '600x600bb'));
      }
    }).catch(() => null);

  // 2. Appel MusicBrainz
  const pMB = fetch(`https://musicbrainz.org/ws/2/release/?query=release:${encodeURIComponent(album)}%20AND%20artist:${encodeURIComponent(artist)}&fmt=json`)
    .then(r => r.json())
    .then(data => {
      if (data.releases?.[0]) {
        const date = data.releases[0].date;
        if (date) results.years.push(parseInt(date.substring(0, 4)));
      }
    }).catch(() => null);

  // Attendre les deux (ou trois) réponses
  await Promise.all([pItunes, pMB]);

  // LOGIQUE DE VÉRIFICATION :
  // On prend l'année la plus ancienne (souvent la vraie date de sortie)
  const finalYear = results.years.length > 0 ? Math.min(...results.years) : null;
  
  // On prend le premier genre trouvé (ou on compare)
  const finalGenre = results.genres[0] || "Divers";

  return {
    year: finalYear,
    genre: finalGenre,
    cover: results.covers[0] || null,
    isVerified: results.years.length > 1 // Vrai si les deux sources ont répondu
  };
}

// --- Vérification automatique en arrière-plan ---

async function backgroundMetadataCheck(track) {
  // 1. Définition du "doute" : est-ce que les infos sont incomplètes ?
  const hasDoubt = !track.year || !track.genre || track.genre === 'Unknown' || track.genre === 'Divers';
  
  // Si on a déjà toutes les infos, on ne fait rien
  if (!hasDoubt) return;

  console.log(`[Auto-Check] Recherche d'infos pour : ${track.artist} - ${track.title}`);

  const query = encodeURIComponent(`${track.artist} ${track.title}`);
  const results = { years: [], genres: [] };

  try {
    // Appel iTunes (très rapide pour le genre et l'année)
    const itunesRes = await fetch(`https://itunes.apple.com/search?term=${query}&entity=song&limit=1`);
    const itunesData = await itunesRes.json();
    
    if (itunesData.results?.[0]) {
      const info = itunesData.results[0];
      if (info.releaseDate) results.years.push(new Date(info.releaseDate).getFullYear());
      if (info.primaryGenreName) results.genres.push(info.primaryGenreName);
    }

    // Si on a trouvé des infos, on les sauvegarde silencieusement
    if (results.years.length > 0 || results.genres.length > 0) {
      const updatedMeta = {
        [track.path]: {
          year: results.years[0] || track.year,
          genre: results.genres[0] || track.genre,
          autoVerified: true // Marqueur pour ne plus y revenir
        }
      };

      // Envoi au main.js pour sauvegarde dans prefs.json
      await ipcRenderer.invoke('save-track-meta', updatedMeta);
      
      // Mise à jour locale de l'objet track pour éviter de relancer la recherche
      track.year = results.years[0] || track.year;
      track.genre = results.genres[0] || track.genre;
    }
  } catch (err) {
    // Échec silencieux pour ne pas déranger l'utilisateur
    console.warn("[Auto-Check] API indisponible ou erreur réseau");
  }
}

// 4. Déclenchement automatique au changement de morceau
// À ajouter dans votre fonction de lecture existante dans app.html
function onTrackStart(track) {
  // Vos fonctions de lecture habituelles...
  
  // Lancement de la vérification en arrière-plan sans 'await' 
  // pour ne pas bloquer le démarrage de l'audio
  backgroundMetadataCheck(track);
}
const libBtn = document.getElementById('si-lib');

if (libBtn) {
  libBtn.addEventListener('dblclick', (e) => {
    e.preventDefault();

    // 1. Si le mode shuffle est éteint, on l'allume via ta fonction
    // Si il est déjà allumé, on le laisse ainsi pour ne pas l'éteindre
    if (!shuffle) {
      toggleShuffle(); 
    }

    // 2. Lancer la lecture aléatoire
    if (queue.length > 0) {
      // On s'assure que l'ordre est prêt (même si toggleShuffle le fait déjà)
      if (_shuffleOrder.length === 0) buildShuffleOrder();
      
      // On choisit un morceau au hasard
      const rnd = Math.floor(Math.random() * queue.length);
      playIdx(rnd);
    }
  });
}

//OMNITOOL

let _omniTargetTracks = [];
let _omniPendingCoverUrl = null;

// OMNITOOL logic

function openOmniEditor(tracks, startOnCover = false) {
  if (!tracks || (!tracks.length && !tracks._primary)) return;
  
  _omniSpecificRef = tracks._primary || tracks[0];
  _omniTargetTracks = tracks;

  const t = _omniSpecificRef;

  document.getElementById('batchOv').classList.add('on');
  document.body.classList.add('omni-open'); // floute le fullscreen derrière (cf. style.css)
  
  const strip = document.getElementById('omniResults');
  if (strip) {
    strip.style.display = "none";
    strip.innerHTML = "";
    // Purge les styles inline hérités d'une session précédente (flexWrap/gap de
    // runOmniSearch, mode colonne du chemin « aucune pochette ») — sinon l'état
    // d'une recherche contamine la mise en page de la suivante.
    strip.style.flexDirection = "";
    strip.style.overflowX = "";
    strip.style.flexWrap = "";
    strip.style.gap = "";
    strip.style.justifyContent = "";
  }

  // Nettoie les chips/popovers/loading d'une éventuelle session précédente
  if (typeof _clearConsolidatedPickers === 'function') _clearConsolidatedPickers();
  window._lastConsolidatedMeta = null;
  
  // Titre
  document.getElementById('omniTitle').value = t.title || "";
  document.getElementById('omniMainTitle').textContent = "Édition";
  document.getElementById('omniSubtitle').textContent = t.title || "Morceau inconnu";
  document.getElementById('omniArtist').value = t.artist || "";
  document.getElementById('omniAlbum').value = t.album || "";
  document.getElementById('omniYear').value = t.year || "";
 document.getElementById('omniStyle').value = t.genreStyle || "";
  
  // Snapshot pour le bouton « revenir » (après remplissage des champs)
  setTimeout(() => { if(typeof _captureOmniSnapshot === 'function') _captureOmniSnapshot(); }, 50);
  if (typeof _omniRefreshHeaderBtns === 'function') _omniRefreshHeaderBtns();
  
  // Genre
  const genreSelect = document.getElementById('omniGenre');
  if (genreSelect && t.genre) {
    let found = false;
    for (let i = 0; i < genreSelect.options.length; i++) {
      if (genreSelect.options[i].value === t.genre) {
        genreSelect.selectedIndex = i;
        found = true;
        break;
      }
    }
    if (!found) {
      genreSelect.selectedIndex = 0;
      document.getElementById('omniStyle').value = t.genre;
    }
  }
  
document.getElementById('omniSearchIn').value = `${t.artist || ""} ${t.album || ""}`.trim();
// C223 : champ MORCEAU — artiste + titre
{
  const _osT2 = document.getElementById('omniSearchTrack');
  if (_osT2) _osT2.value = `${t.artist || ""} ${t.title || ""}`.trim();
}

  // === POCHETTE : VÉRIFIER TOUS LES CACHES ===
  let activeCover = null;
  
  // 1. Cache par chemin (customCovers)
  if (typeof customCovers !== 'undefined' && customCovers[t.path]) {
    activeCover = customCovers[t.path];
  }
  
  // 2. Cache par album (artist||album)
  if (!activeCover && typeof _albumArtCache !== 'undefined') {
    const albumKey = `${t.artist || ''}||${t.album || ''}`;
    if (_albumArtCache[albumKey]) {
      activeCover = _albumArtCache[albumKey];
    }
  }
  
  // 3. Cache par chemin inverse (autre morceau du même album)
  if (!activeCover && t.album && t.artist) {
    const sameAlbumTrack = allTracks.find(x => 
      x.album === t.album && x.artist === t.artist && x.path !== t.path && customCovers[x.path]
    );
    if (sameAlbumTrack) {
      activeCover = customCovers[sameAlbumTrack.path];
    }
  }
  
  // 4. (retiré) L'image du player n'est PAS une source fiable : en éditant un
  //    morceau qui n'est pas celui en lecture, on héritait de SA pochette (fond
  //    périmé). Les caches 1-3 + t.cover restent track-spécifiques.
  
  // 5. Cover stockée dans le track
  if (!activeCover && t.cover && t.cover.length > 5) {
    activeCover = t.cover;
  }
  
  _omniPendingCoverUrl = activeCover || null;
  updateOmniPreview(activeCover);
  
  // ✅ NETTOYER L'ANCIEN INTERVALLE
  if (window._omniCleanup) {
    clearInterval(window._omniCleanup);
    window._omniCleanup = null;
  }
  
  // SURVEILLANCE retirée : ce polling 500ms repiochait la pochette du PLAYER
  // (fond périmé en éditant un autre morceau) et se battait avec le throttle/
  // cache → scintillement old/new. Les pochettes tardives pour CE morceau sont
  // déjà poussées par updateEditorCoverIfOpen (appelée par les fetch d'artwork).
  
  const inheritRow = document.getElementById('omniInheritRow');
  if (inheritRow) {
    inheritRow.style.display = t.album ? 'block' : 'none';
    document.getElementById('omniInheritAlbum').checked = false;
  }

  if (startOnCover) {
    setTimeout(() => document.getElementById('omniSearchIn').focus(), 100);
  }
}

// Appeler cette fonction quand une pochette est chargée (dans fetchArt, autoFetchArtwork)
function updateEditorCoverIfOpen(trackPath, coverUrl) {
  // Vérifier si l'éditeur est ouvert et concerne ce morceau
  const batchOv = document.getElementById('batchOv');
  if (!batchOv || !batchOv.classList.contains('on')) return;
  
  if (_omniSpecificRef && _omniSpecificRef.path === trackPath) {
    if (!_omniPendingCoverUrl || _omniPendingCoverUrl !== coverUrl) {
      _omniPendingCoverUrl = coverUrl;
      updateOmniPreview(coverUrl);
    }
  }
}

function applyOmniData(cover, year, album) {
  if (cover) {
    _omniPendingCoverUrl = cover; // Variable pour le futur enregistrement
    // Mise à jour du background sharp (ton style préféré)
    document.querySelector('.batch-box').style.setProperty('--omni-bg', `url('${cover}')`);
  }
  if (year) document.getElementById('omniYear').value = year;
  if (album) document.getElementById('omniAlbum').value = album;
  
  toast("Données appliquées depuis la source");
}

/**
 * Updates the immersive background of the batch box
 * @param {string} url - The URL of the album cover
 */
/**
 * Updates the background image of the edit box using a CSS variable
 */
function updateOmniPreview(url) {
  const box = document.querySelector('.batch-box');
  if (box) {
    if (url && url.length > 20 && !url.includes('blob:')) {
      box.style.setProperty('--omni-bg', `url('${url}')`);
    } else {
      box.style.setProperty('--omni-bg', 'none');
    }
  }
}

/**
 * Handle clicking a search result (Add this to your search result loop)
 */
function onSelectCover(url) {
    _omniPendingCoverUrl = url;
    updateOmniPreview(url); // Instantly updates the box background
}

function handleOmniResultClick(url) {
    _omniPendingCoverUrl = url;
    updateOmniPreview(url);
    const status = document.getElementById('omniStatus');
    if (status) status.textContent = "Pochette sélectionnée";
}

// Replacement for grpCtxEditAlbum (Right-click on an Album/Group)
function grpCtxEditAlbum() {
  if (!_grpTracks) return;
  const ts = typeof _grpTracks === 'function' ? _grpTracks() : _grpTracks;
  if (!ts || !ts.length) { hideGrpCtxMenu(); return; }
  
  hideGrpCtxMenu();
  // Open the Omni-Editor with the full array of tracks (Batch Mode)
  openOmniEditor(ts, false); 
}

// Replacement for _fsOpenEditor (Clicking cover in Fullscreen/Mini-player)
function _fsOpenEditor() {
  const t = queue[qi];
  if (!t || !t.path) return;
  
  // Find all tracks of the same album to allow batch editing
  const albumTracks = t.album 
    ? allTracks.filter(x => x.album === t.album && x.artist === t.artist)
    : [t];

  // Open the Omni-Editor focused on the cover search
  openOmniEditor(albumTracks, true);
}

// Remplacez la fonction saveOmniChanges existante par celle-ci

// ============================================================
// SAVE OMNI CHANGES
// ────────────────────────────────────────────────────────────
// Trois cas de figure :
//   1. Édition d'UN seul morceau (sans "Appliquer à tout l'album")
//      → tous les champs s'appliquent, y compris le titre.
//   2. Édition MULTI-sélection (sans "Appliquer à tout l'album")
//      → titre JAMAIS propagé (unique par morceau).
//      → artiste/album/année/genre/cover propagés à la sélection.
//   3. "Appliquer à tout l'album" coché
//      → titre JAMAIS propagé.
//      → on cherche TOUS les morceaux qui partagent l'album+artiste D'ORIGINE
//        de la référence (avant la moindre mutation), et on leur applique
//        artiste/album/année/genre/cover.
//
// Règle transversale : une valeur vide dans le formulaire n'efface jamais
// une valeur existante (sécurité contre la perte de données).
// ============================================================
// ── Sélecteur de pistes de l'album (recherche en ligne) ───────────────────────
// Retour visuel « ça tourne » pour les boutons d'action de la tracklist.
// Désactive le bouton, fait tourner un ↻ (Web Animations API, hors thread principal),
// puis restaure — ou affiche brièvement un libellé de fin (ex. « ✓ appliqué »).
function _omniSpinBtn(btn, busyLabel){
  if (!btn) return () => {};
  const orig = btn.innerHTML, pe = btn.style.pointerEvents, op = btn.style.opacity;
  btn.style.pointerEvents = 'none';
  btn.style.opacity = '.65';
  btn.innerHTML = '<span data-spin="1" style="display:inline-block;">↻</span> ' + (busyLabel || '');
  const sp = btn.querySelector('[data-spin]');
  const anim = (sp && sp.animate)
    ? sp.animate([{ transform:'rotate(0deg)' }, { transform:'rotate(360deg)' }], { duration: 700, iterations: Infinity })
    : null;
  return (doneLabel) => {
    if (anim) { try { anim.cancel(); } catch (_) {} }
    if (doneLabel) {
      btn.innerHTML = doneLabel;
      setTimeout(() => { btn.innerHTML = orig; btn.style.pointerEvents = pe; btn.style.opacity = op; }, 1100);
    } else {
      btn.innerHTML = orig; btn.style.pointerEvents = pe; btn.style.opacity = op;
    }
  };
}

async function _renderAlbumTracklist(artist, album, host) {
  if (!host || !album || !window.wt || !window.wt.fetchAlbumTracklist) return;
  const old = document.getElementById('omniTracklistBox'); if (old) old.remove();
  const box = document.createElement('div');
  box.id = 'omniTracklistBox';
  box.style.cssText = 'margin-top:12px; width:100%;';
  box.innerHTML = '<div style="font-size:9px;color:var(--t3);font-weight:600;letter-spacing:.04em;padding:4px 0;">PISTES DE L\'ALBUM…</div>';
  host.appendChild(box);
  let data = null;
  try { data = await window.wt.fetchAlbumTracklist(artist || '', album || ''); } catch (_) {}
  const tracks = (data && data.tracks) || [];
  if (!tracks.length) { box.remove(); return; }
  // Quels titres de l'album officiel possèdes-tu réellement ? (lève l'ambiguïté
  // « j'ai 2 morceaux mais la liste en montre 12 »). Match par titre normalisé
  // (accents/ponctuation/parenthèses retirés → "Moonloop (Live)" = "Moonloop").
  const _normTl = v => String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s*\([^)]*\)\s*/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  const _ownedTl = new Set(
    ((typeof _omniTargetTracks !== 'undefined' && _omniTargetTracks) || [])
      .map(t => _normTl(t && t.title)).filter(Boolean));
  let _ownedCount = 0;
  const rows = tracks.map((tr, idx) => {
    const num = tr.disc ? `${tr.disc}-${tr.n || idx + 1}` : (tr.n || idx + 1);
    const owned = _ownedTl.has(_normTl(tr && tr.title)); if (owned) _ownedCount++;
    return `<div class="omni-tl-row" data-idx="${idx}" data-owned="${owned ? 1 : 0}" style="display:flex;gap:12px;align-items:center;padding:8px 12px;border-radius:9px;cursor:pointer;transition:background .12s;border:.5px solid transparent;${owned ? '' : 'opacity:.4;'}">`
      + `<span style="font-family:var(--font-mono);font-size:10px;color:${owned ? 'var(--acc)' : 'var(--t3)'};font-weight:700;min-width:28px;text-align:right;">${num}</span>`
      + `<span style="font-size:12.5px;letter-spacing:.01em;color:${owned ? 'var(--t1)' : 'var(--t2)'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(tr.title)}</span>`
      + (owned ? '<span style="margin-left:auto;width:6px;height:6px;border-radius:50%;background:var(--acc);flex-shrink:0;box-shadow:0 0 6px rgba(200,90,69,.6);" title="Dans ta bibliothèque"></span>' : '')
      + `</div>`;
  }).join('');
  box.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px;">'
    + `<div style="flex:1;min-width:0;font-size:9px;color:var(--t3);font-weight:600;letter-spacing:.04em;">PISTES DE L'ALBUM (${_ownedCount}/${tracks.length} chez toi) — clic pour remplir</div>`
    + '<div style="display:flex;gap:12px;white-space:nowrap;flex-shrink:0;">'
    + '<div id="omniTlYears" style="font-size:10px;color:var(--acc);cursor:pointer;" title="Cherche en ligne l\'année d\'ORIGINE de chaque morceau (compilations : pas l\'année de la compil) — résultats dans Corrigé">↻ années par titre</div>'
    + '<div id="omniTlAll" style="font-size:10px;color:var(--acc);cursor:pointer;" title="Applique chaque titre au morceau correspondant, dans l\'ordre">⤓ titres (par ordre)</div>'
    + '</div></div>'
    + `<div style="display:flex;flex-direction:column;gap:2px;max-height:220px;overflow-y:auto;">${rows}</div>`;
  box.querySelectorAll('.omni-tl-row').forEach(row => {
    row.addEventListener('mouseenter', () => { if (!row.dataset.sel) { row.style.background = 'rgba(255,255,255,.06)'; row.style.borderColor = 'rgba(255,255,255,.08)'; } });
    row.addEventListener('mouseleave', () => { if (!row.dataset.sel) { row.style.background = ''; row.style.borderColor = 'transparent'; } });
    row.addEventListener('click', () => {
      const tr = tracks[parseInt(row.dataset.idx, 10)]; if (!tr) return;
      const ti = document.getElementById('omniTitle');
      if (ti) { ti.value = tr.title; ti.dispatchEvent(new Event('input', { bubbles: true })); }
      box.querySelectorAll('.omni-tl-row').forEach(r => { r.style.background = ''; delete r.dataset.sel; });
      row.dataset.sel = '1'; row.style.background = 'rgba(200,90,69,.16)';
    });
  });
  const allBtn = document.getElementById('omniTlAll');
  if (allBtn) allBtn.addEventListener('click', () => {
    const stop = _omniSpinBtn(allBtn, 'application…');
    // 60ms : laisse le spinner s'afficher avant le travail synchrone
    setTimeout(() => { _applyTracklistByOrder(tracks); stop('✓ appliqué'); }, 60);
  });
  const yrBtn = document.getElementById('omniTlYears');
  if (yrBtn) yrBtn.addEventListener('click', () => {
    const tg = (typeof _omniTargetTracks !== 'undefined' && _omniTargetTracks) ? _omniTargetTracks : [];
    const elig = tg.filter(t => t && t.path && !t._userModified && !t._ignored);
    if (!elig.length) { toast('Rien à compléter (tout est manuel/verrouillé)'); return; }
    if (typeof enrichQueue !== 'undefined' && enrichQueue.addForce) {
      const stop = _omniSpinBtn(yrBtn, 'recherche…');
      enrichQueue.addForce(elig, { priority: 20 });
      toast(`🔎 Recherche des années d'origine sur ${elig.length} morceau(x)… → « Corrigé »`);
      // garde le spinner tant que la file travaille (plafond 10s pour ne jamais coller)
      const t0 = Date.now();
      const poll = setInterval(() => {
        const busy = (enrichQueue._inflight > 0) || (enrichQueue._queue && enrichQueue._queue.length > 0);
        const el = Date.now() - t0;
        if ((!busy && el > 1200) || el > 10000) { clearInterval(poll); stop('✓ lancé → Corrigé'); }
      }, 400);
    }
  });
}

function _applyTracklistByOrder(tracks) {
  const targetsRaw = (typeof _omniTargetTracks !== 'undefined' && _omniTargetTracks && _omniTargetTracks.length)
    ? [..._omniTargetTracks] : [];
  if (targetsRaw.length < 2) { toast('Cet album n\'a qu\'un seul morceau ici'); return; }

  // Le scan dérive les titres DU NOM DE FICHIER (il retire un préfixe « NN »).
  // Ce numéro de fichier = l'ordre de l'album. On s'aligne LÀ-DESSUS, jamais sur
  // l'ordre d'affichage (qui suit le tri courant et n'a aucune raison de
  // correspondre) — sinon les titres atterrissent sur les mauvais fichiers.
  const _fileNo = (t) => {
    const base = (t && t.path) ? String(t.path).split(/[\\/]/).pop() : '';
    const m = base.match(/^\s*(\d{1,3})[\s._\-]/);
    return m ? parseInt(m[1], 10) : null;
  };
  const numbered = targetsRaw.filter(t => _fileNo(t) != null).length;

  // Pas (assez) de fichiers numérotés → aucun alignement fiable. On REFUSE plutôt
  // que d'écrire des titres faux (mieux vide que faux). L'empreinte est la voie sûre.
  if (numbered < Math.ceil(targetsRaw.length * 0.7)) {
    toast('⚠ Fichiers non numérotés : alignement non fiable. Utilise « Rechercher » (empreinte) piste par piste.');
    return;
  }

  // Tri par n° de fichier = ordre album, puis correspondance par position.
  const targets = targetsRaw.slice().sort((a, b) => (_fileNo(a) ?? 1e9) - (_fileNo(b) ?? 1e9));
  const n = Math.min(targets.length, tracks.length);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const track = targets[i];
    const title = tracks[i] && tracks[i].title;
    if (!track || !title || track.title === title) continue;
    track.title = title;
    track._userModified = true;
    delete track._autoFixed;
    if (typeof _clearUnidentifiedIfComplete === 'function') _clearUnidentifiedIfComplete(track);
    if (typeof schedulePropagateTrackUpdate === 'function') schedulePropagateTrackUpdate(track);
    count++;
  }
  if (typeof renderVirtual === 'function') renderVirtual();
  if (typeof renderMiniQueue === 'function') renderMiniQueue();
  if (typeof scheduleSave === 'function') scheduleSave();
  if (typeof scheduleMetaSave === 'function') scheduleMetaSave();
  toast(`✓ ${count} titre${count > 1 ? 's' : ''} appliqué${count > 1 ? 's' : ''} (aligné par n° de fichier) — vérifie l'album`);
}

// Boutons favori + sync iPhone dans l'en-tête de l'éditeur (à côté du ✕).
function _omniRefreshHeaderBtns(){
  const t = (typeof _omniSpecificRef !== 'undefined') ? _omniSpecificRef : null;
  const fav = document.getElementById('omniFavBtn');
  const syn = document.getElementById('omniSyncBtn');
  if(fav){ const on = !!(t && t.isFavorite); fav.textContent = on ? '★' : '☆'; fav.style.color = on ? '#E8B84B' : ''; fav.title = on ? '★ Favori' : '☆ Favoriser'; }
  if(syn && t){ const on = (typeof syncSel !== 'undefined') && syncSel.has(t.path); syn.style.color = on ? '#C85A45' : ''; syn.title = on ? 'Dans le Sync iPhone' : 'Ajouter au Sync iPhone'; }
}
function _omniToggleFav(){
  const t = (typeof _omniSpecificRef !== 'undefined') ? _omniSpecificRef : null;
  if(!t || typeof toggleTrackFavorite !== 'function') return;
  Promise.resolve(toggleTrackFavorite(t)).then(_omniRefreshHeaderBtns).catch(_omniRefreshHeaderBtns);
}
function _omniToggleSync(){
  const t = (typeof _omniSpecificRef !== 'undefined') ? _omniSpecificRef : null;
  if(!t || !t.path || typeof syncSel === 'undefined') return;
  if(syncSel.has(t.path)){ syncSel.delete(t.path); if(typeof _syncLinkRemove==='function') _syncLinkRemove(t,{manual:true}); }
  else { syncSel.add(t.path); if(typeof _syncLinkAdd==='function') _syncLinkAdd(t,{manual:true}); }
  if(typeof updateSyncStats==='function') updateSyncStats([...allTracks.filter(x=>syncSel.has(x.path))]);
  if(typeof renderVirtual==='function') renderVirtual();
  _omniRefreshHeaderBtns();
}

function saveOmniChanges() {
  if (!_omniTargetTracks || !_omniTargetTracks.length) {
    toast('Aucun morceau sélectionné');
    return;
  }

  // ── 1. Récupération du contexte ─────────────────────────────
  const ref = _omniSpecificRef || _omniTargetTracks[0];
  const inherit = document.getElementById('omniInheritAlbum')?.checked || false;
  const isSingle = _omniTargetTracks.length === 1 && !inherit;

  // ⚠️ Capturer les valeurs NORMALISÉES de la référence AVANT toute mutation
  const normalize = (str) => (str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\[[^\]]*\]/g, '')        // Supprime [Disc 1] [Live]
    .replace(/\([^)]*\)/g, '')          // Supprime (Deluxe Edition)
    .replace(/[\s\-_]+/g, ' ')          // Normalise espaces
    .trim();
  
  const origAlbumNorm = normalize(ref?.album);
  const origArtistNorm = normalize(ref?.artist);
  const origAlbumRaw = ref?.album || '';
  const origArtistRaw = ref?.artist || '';

  // ── 2. Lecture des valeurs du formulaire ────────────────────
  const newTitle = document.getElementById('omniTitle')?.value.trim() || '';
  const newArtist = document.getElementById('omniArtist')?.value.trim() || '';
  const newAlbum = document.getElementById('omniAlbum')?.value.trim() || '';
  const newYearRaw = document.getElementById('omniYear')?.value.trim() || '';
  const newGenreGlobal = document.getElementById('omniGenre')?.value || '';
  const newGenreStyle = document.getElementById('omniStyle')?.value.trim() || '';

  let newYear = null;
  if (newYearRaw && !isNaN(parseInt(newYearRaw))) {
    const yearNum = parseInt(newYearRaw);
   if (yearNum >= 1400 && yearNum <= new Date().getFullYear() + 1) {
      newYear = yearNum;
    }
  }

  // Bucket canonique : global explicite prioritaire ; sinon dérivé du style
  // libre via clientMapGenre (« R&B/Soul » → « Soul, Funk & Disco » au lieu d'un
  // genre parasite). Style non mappable → pas de bucket imposé (reste en style).
  let finalGenre = '';
  if (newGenreGlobal) {
    finalGenre = newGenreGlobal;
  } else if (newGenreStyle) {
    const _mapped = (typeof clientMapGenre === 'function') ? clientMapGenre(newGenreStyle) : null;
    finalGenre = _mapped || '';
  }

  // C197 : le champ style est PRÉREMPLI depuis la référence — s'il revient
  // vide, c'est un effacement volontaire. Sans ça, `if (newGenreStyle && …)`
  // rendait l'effacement structurellement impossible (vide = falsy = ignoré).
  const styleCleared = !newGenreStyle && !!(ref && ref.genreStyle);

  // ── 3. Sélectionner la liste des morceaux à modifier ───────
  // Match siblings by normalized ALBUM (artist may be empty for compilations).
  // If original artist exists, also require artist match — otherwise album-only.
  let targets;
  if (inherit && origAlbumRaw) {
    const isCompilation = !origArtistRaw || origArtistRaw.trim() === '';
    if (isCompilation) {
      // Compilation/OST/Various Artists: match by album name alone.
      targets = allTracks.filter(t => normalize(t.album) === origAlbumNorm);
      console.log(`[saveOmniChanges] Mode compilation (album seul) — ${targets.length} morceaux ciblés`);
      if (targets.length === 0) {
        targets = allTracks.filter(t => t.album === origAlbumRaw);
        console.log(`[saveOmniChanges] Fallback compilation égalité stricte — ${targets.length} morceaux`);
      }
    } else {
      // Regular album: match by normalized album + artist.
      targets = allTracks.filter(t => {
        const tAlbumNorm = normalize(t.album);
        const tArtistNorm = normalize(t.artist);
        return tAlbumNorm === origAlbumNorm && tArtistNorm === origArtistNorm;
      });
      console.log(`[saveOmniChanges] Mode "tout l'album" — ${targets.length} morceaux ciblés après normalisation`);
      if (targets.length === 0) {
        targets = allTracks.filter(t => t.album === origAlbumRaw && t.artist === origArtistRaw);
        console.log(`[saveOmniChanges] Fallback égalité stricte — ${targets.length} morceaux`);
      }
    }
  } else {
    targets = [..._omniTargetTracks];
    console.log(`[saveOmniChanges] Mode normal — ${targets.length} morceaux ciblés`);
  }

  // Si toujours aucun morceau trouvé, on applique au moins à la référence
  if (targets.length === 0 && inherit && ref) {
    targets = [ref];
    console.warn('[saveOmniChanges] Aucun morceau trouvé, fallback sur la référence seule');
  }

  // Compil/best-of/B.O./Various : année, GENRE et ARTISTE sont PROPRES à chaque
  // morceau → en mode « tout l'album » on ne les propage PAS (l'auto s'en charge,
  // par morceau). Seuls le morceau édité (ref) bouge ; l'album et la cover, eux,
  // restent album-wide. Album normal → propagation classique.
  const _albPerTrack = inherit && (
    (!origArtistRaw || !origArtistRaw.trim()) ||
    /greatest hits|best of|the very best|anthology|the essential|definitive|\bcollection\b|compilation|soundtrack|bande originale|\bost\b/i.test(origAlbumRaw || '')
  );

  // La COVER est TOUJOURS album-wide (une pochette = un album, même une compil) —
  // indépendamment de la case « tout l'album ». On calcule le groupe album ici.
  const coverGroup = origAlbumRaw
    ? allTracks.filter(t => normalize(t.album) === origAlbumNorm &&
        ((!origArtistRaw || !origArtistRaw.trim()) || normalize(t.artist) === origArtistNorm))
    : [ref];

  // ── 4. Appliquer les modifications ──────────────────────────
  let modifiedCount = 0;
  for (const track of targets) {
    let changed = false;

    // TITRE : UNIQUEMENT en édition simple
    if (isSingle && newTitle && track.title !== newTitle) {
      track.title = newTitle;
      changed = true;
    }
    
    if (newArtist && (!_albPerTrack || track === ref) && track.artist !== newArtist) {
      track.artist = newArtist;
      changed = true;
    }
    
    if (newAlbum && track.album !== newAlbum) {
      track.album = newAlbum;
      changed = true;
    }
    
    if (newYear && (!_albPerTrack || track === ref) && track.year !== newYear) {
      track.year = newYear;
      changed = true;
    }
    
    if (finalGenre && (!_albPerTrack || track === ref) && track.genre !== finalGenre) {
      track.genre = finalGenre;
      changed = true;
    }
    if (newGenreStyle && (!_albPerTrack || track === ref) && track.genreStyle !== newGenreStyle) {
      track.genreStyle = newGenreStyle;   // style libre, indépendant du bucket
      changed = true;
    }
    // C197 : effacement volontaire du style (champ prérempli vidé puis Enregistrer)
    if (styleCleared && (!_albPerTrack || track === ref) && track.genreStyle) {
      delete track.genreStyle;
      changed = true;
    }
    
    if (changed) {
      track._userModified = true;
      delete track._autoFixed;
      _clearUnidentifiedIfComplete(track);
      modifiedCount++;
      // Patch B : propage la modif vers le mobile si le morceau y est déjà
      schedulePropagateTrackUpdate(track);
    }
  }

  // ── Cover : album-wide systématique (sur tout le groupe album) ──────────
  const _coverChanged = [];
  if (_omniPendingCoverUrl) {
    for (const ct of coverGroup) {
      if (customCovers[ct.path] !== _omniPendingCoverUrl) {
        customCovers[ct.path] = _omniPendingCoverUrl;
        ct._art = _omniPendingCoverUrl;
        ct._userModified = true;
        schedulePropagateTrackUpdate(ct);
        _coverChanged.push(ct);
      }
    }
    if (_coverChanged.length) modifiedCount = Math.max(modifiedCount, _coverChanged.length);
  }

  // ── 5. Mettre à jour la queue ──────────────────────────────
  const targetPathsSet = new Set([...targets, ..._coverChanged].map(t => t.path));
  queue.forEach((qTrack, qIdx) => {
    if (targetPathsSet.has(qTrack.path)) {
      const fresh = allTracks.find(t => t.path === qTrack.path);
      if (fresh) queue[qIdx] = { ...fresh, url: pathToUrl(fresh.path) };
    }
  });

  // ── 6. Mettre à jour les playlists ─────────────────────────
  allLists.forEach(pl => {
    if (!pl.tracks) return;
    let needsUpdate = false;
    pl.tracks.forEach((plTrack, idx) => {
      if (targetPathsSet.has(plTrack.path)) {
        const fresh = allTracks.find(t => t.path === plTrack.path);
        if (fresh) { pl.tracks[idx] = fresh; needsUpdate = true; }
      }
    });
    if (needsUpdate) pl.count = pl.tracks.length;
  });

  // ── 7. Mettre à jour l'affichage ────────────────────────────
  if (_omniPendingCoverUrl) {
    const pArt = document.getElementById('pArt');
    if (pArt && targetPathsSet.has(nowPath)) {
      pArt.innerHTML = `<img src="${_omniPendingCoverUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:8px">`;
    }
    if (typeof _fsActive !== 'undefined' && _fsActive) {
      const fsArt = document.getElementById('fsArtImg');
      if (fsArt && targetPathsSet.has(nowPath)) {
        fsArt.style.backgroundImage = `url("${_omniPendingCoverUrl.replace(/"/g, '\\"')}")`;
        fsArt.classList.remove('no-art');
      }
    }
  }

  // ── 8. Toast ────────────────────────────────────────────────
  const plural = modifiedCount > 1 ? 'x' : '';
  if (inherit) toast(`✓ ${modifiedCount} morceau${plural} de l'album mis à jour`);
  else toast(`✓ ${modifiedCount} morceau${plural} mis à jour`);

  // ── 9. Refresh + persistance ────────────────────────────────
  if (typeof _inCompleteBucket !== 'undefined' && _inCompleteBucket && typeof _rebuildCurrentBucket === 'function') {
    // On est dans une vue filtrée (à compléter / fichiers traités) : on la
    // reconstruit pour que le morceau édité en sorte, sans revenir à toute la biblio.
    filtered = _rebuildCurrentBucket();
  } else if (curPl >= 0 && allLists[curPl]) {
    filtered = [...allLists[curPl].tracks];
  } else {
    filtered = [...allTracks];
  }
  
  const searchQ = document.getElementById('searchIn')?.value.trim();
  if (searchQ) {
    const q = searchQ.toLowerCase();
    filtered = filtered.filter(t =>
      (t.title || '').toLowerCase().includes(q) ||
      (t.artist || '').toLowerCase().includes(q) ||
      (t.album || '').toLowerCase().includes(q)
    );
  }
  
  if (typeof applySortToFiltered === 'function') applySortToFiltered();
  if (typeof renderVirtual === 'function') renderVirtual();
  if (typeof renderMiniQueue === 'function') renderMiniQueue();
  if (typeof updateBreadcrumb === 'function') updateBreadcrumb();
  if (typeof scheduleSave === 'function') scheduleSave();
  if (typeof scheduleMetaSave === 'function') scheduleMetaSave();

  _omniPendingCoverUrl = null;
  _omniSpecificRef = null;
  _omniTargetTracks = null;
    // ── 10a. Rafraîchir le MINI-PLAYER et l'overlay de la pochette
  if (typeof qi !== 'undefined' && queue && queue[qi] && targetPathsSet.has(queue[qi].path)) {
    const _np = queue[qi];
    const _pT = document.getElementById('pTitle');
    if (_pT) { _pT.textContent = _np.title || '–'; if (typeof checkTitleOverflow === 'function') checkTitleOverflow(); }
    const _pS = document.getElementById('pSub');
    if (_pS) {
      const _pa = _np.artist || '';
      _pS.innerHTML = _pa
        ? `<span style="color:#C85A45;font-family:'Inter',sans-serif;font-style:italic;letter-spacing:.04em">${esc(_pa)}</span>`
        : '–';
    }
    if (typeof _refreshPlayerOverlay === 'function') _refreshPlayerOverlay(_np);
    if (typeof fetchArt === 'function') fetchArt(_np);
    // C194 : le fullscreen ne se rafraîchissait JAMAIS après un save —
    // seuls le mini-player et l'overlay étaient re-rendus. queue[qi] a
    // pourtant été reconstruit depuis allTracks à l'étape 5 : il suffit
    // de re-render le DOM fullscreen (titre/album/année/genre/hue).
    if (typeof _fsActive !== 'undefined' && _fsActive && typeof _fsRefresh === 'function') _fsRefresh();
  }
  closeBatch();
}



// L'écouteur double-clic reste en dessous, bien séparé
document.addEventListener('dblclick', (e) => {
    const isMusicRow = e.target.closest('.ag-row, .playlist-row, .track-item, [data-path]');
    if (!isMusicRow) {
        hideGrpCtxMenu();
    }
}, true);

// Specifically block double-clicks from triggering menus on headers/background
document.addEventListener('dblclick', (e) => {
    // 1. Check if the double-click happened on a track row or an album group
    const isMusicRow = e.target.closest('.ag-row, .playlist-row, .track-item, [data-path]');

    // 2. If it is NOT a row (e.g., you clicked a header or empty space), force hide the menu
    if (!isMusicRow) {
        hideGrpCtxMenu();
    }
}, true); // 'true' is vital: it catches the event before any other logic can use it
// Fonction de débogage à exécuter dans la console
function debugOmni() {
  console.log('=== DEBUG OMNI ===');
  console.log('1. Morceau courant (queue[qi]):', queue[qi]);
  console.log('2. Morceau dans allTracks:', allTracks.find(t => t.path === queue[qi]?.path));
  console.log('3. customCovers:', customCovers);
  console.log('4. Genre du morceau:', queue[qi]?.genre);
  
  // Simule l'ouverture de l'éditeur
  const t = queue[qi];
  if (t) {
    console.log('5. Titre qui devrait apparaître:', t.title);
    console.log('6. Artiste:', t.artist);
    console.log('7. Album:', t.album);
    console.log('8. Année:', t.year);
  }
}
// Initialiser une seule fois
if (!window.coverSearchCache) window.coverSearchCache = new Map();
window.addEventListener('resize', () => {
  if (typeof _fsActive !== 'undefined' && _fsActive) {
    setTimeout(checkFsOverflow, 100);
  }
});




// Get free key at https://developers.google.com/custom-search/v1/intro
const GOOGLE_CX = 'YOUR_SEARCH_ENGINE_ID'; // Create at https://cse.google.com
const GOOGLE_KEY = 'YOUR_API_KEY';




// Force refresh fullscreen artwork
function _fsRefreshArt() {
  if (!_fsActive) return;
  
  const t = queue[qi];
  if (!t) return;
  
  const fsArt = document.getElementById('fsArtImg');
  if (!fsArt) return;
  
  // Get the current cover URL
  let coverUrl = null;
  
  // Check custom covers first
  if (typeof customCovers !== 'undefined' && customCovers[t.path]) {
    coverUrl = customCovers[t.path];
  }
  // Check if there's an image in the player
  else {
    const playerImg = document.getElementById('pArt')?.querySelector('img');
    if (playerImg && playerImg.src && !playerImg.src.includes('data:image/svg')) {
      coverUrl = playerImg.src;
    }
  }
  
  // Apply the cover
  if (coverUrl) {
    fsArt.style.backgroundImage = `url("${coverUrl.replace(/"/g, '\\"')}")`;
    fsArt.classList.remove('no-art');
  } else {
    fsArt.style.backgroundImage = 'none';
    fsArt.classList.add('no-art');
  }
  // Si le drawer queue est ouvert, mettre à jour son contenu aussi
  const fsDrawer = document.getElementById('fsQDrawer');
  if (fsDrawer && fsDrawer.classList.contains('open')) {
    _fsRenderQueue();
  }
}






// Global function to apply cover from search results
window.applyCoverFromSearch = function(coverUrl, year, album) {
  console.log('[applyCoverFromSearch]', { coverUrl, year, album });
  
  if (coverUrl && coverUrl.length > 20) {
    if (typeof _omniPendingCoverUrl !== 'undefined') {
      _omniPendingCoverUrl = coverUrl;
    }
    if (typeof updateOmniPreview === 'function') {
      updateOmniPreview(coverUrl);
    }
    toast('✓ Pochette sélectionnée');
  }
  
  if (year && document.getElementById('omniYear')) {
    const currentYear = new Date().getFullYear();
    const yearNum = parseInt(year);
    if (yearNum >= 1400 && yearNum <= currentYear) {
      document.getElementById('omniYear').value = year;
      toast(`✓ Année mise à jour: ${year}`);
    }
  }
  
  if (album && document.getElementById('omniAlbum')) {
    document.getElementById('omniAlbum').value = album;
  }
};

// Also handle Enter key in the search input
document.addEventListener('DOMContentLoaded', function() {
  const searchInput = document.getElementById('omniSearchIn');
  if (searchInput) {
    searchInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (typeof window.runOmniSearch === 'function') {
          window.runOmniSearch();
        } else {
          console.error('[Enter] runOmniSearch not defined');
        }
      }
    });
  }
});
// ── COLUMN FILTER (Genre + Année headers) ─────────────
const _cfState = {
  field: null,           // 'genre' or 'year'
  selected: new Set(),   // values currently kept (empty = no filter)
  all: [],               // [{value, count}] for the active field
};
// Persist selections per field across re-opens
const _cfActiveFilters = { genre: null, year: null }; // null = no filter, Set = active

function _cfBuildOptions(field){
  const counts = new Map();
  for(const t of allTracks){
    const v = (t[field] || '').trim() || '(vide)';
    counts.set(v, (counts.get(v)||0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({value, count}))
    .sort((a,b) => {
      if(field === 'year'){
        const na = parseInt(a.value)||0, nb = parseInt(b.value)||0;
        if(na && nb) return nb - na; // newest first
      }
      return a.value.localeCompare(b.value, 'fr', {sensitivity:'base'});
    });
}

function openColFilter(field, anchorEl){
  _cfState.field = field;
  _cfState.all = _cfBuildOptions(field);
  // Restore previously applied selection, or default to "all selected"
  _cfState.selected = _cfActiveFilters[field]
    ? new Set(_cfActiveFilters[field])
    : new Set(_cfState.all.map(o => o.value));
  document.getElementById('cfSearch').value = '';
  _cfRenderList();
  // Position dropdown under the header
  const r = anchorEl.getBoundingClientRect();
  const dd = document.getElementById('colFilter');
  dd.style.left = Math.min(r.left, window.innerWidth - 256) + 'px';
  dd.style.top  = (r.bottom + 4) + 'px';
  dd.classList.add('on');
  setTimeout(() => document.getElementById('cfSearch').focus(), 50);
}

function closeColFilter(){
  document.getElementById('colFilter').classList.remove('on');
  _cfState.field = null;
}

function _cfRenderList(){
  const list = document.getElementById('cfList');
  const q = (document.getElementById('cfSearch').value || '').toLowerCase().trim();
  const items = _cfState.all.filter(o => !q || o.value.toLowerCase().includes(q));
  list.innerHTML = items.map(o => {
    const checked = _cfState.selected.has(o.value);
    const safe = o.value.replace(/"/g,'&quot;');
    return `<div class="cf-row${checked?' checked':''}" data-v="${safe}">
      <div class="cf-cb"></div>
      <div class="cf-label">${esc(o.value)}</div>
      <div class="cf-count">${o.count}</div>
    </div>`;
  }).join('') || '<div style="padding:14px;color:var(--t3);text-align:center">Aucun résultat</div>';
  list.querySelectorAll('.cf-row').forEach(row => {
    row.addEventListener('click', () => {
      const v = row.dataset.v;
      if(_cfState.selected.has(v)) _cfState.selected.delete(v);
      else _cfState.selected.add(v);
      row.classList.toggle('checked');
    });
  });
}

function cfSelectAll(){ _cfState.all.forEach(o => _cfState.selected.add(o.value)); _cfRenderList(); }
function cfClearAll(){ _cfState.selected.clear(); _cfRenderList(); }

function cfApply(){
  if(!_cfState.field) return;
  const allCount = _cfState.all.length;
  const selCount = _cfState.selected.size;
  // If all selected (or none) → no filter
  if(selCount === 0 || selCount === allCount){
    _cfActiveFilters[_cfState.field] = null;
  } else {
    _cfActiveFilters[_cfState.field] = new Set(_cfState.selected);
  }
  _updateFilterIndicators();
  closeColFilter();
  applyFilters();
}

function _updateFilterIndicators(){
  ['genre','year'].forEach(f => {
    const id = f === 'genre' ? 'sh-genre' : 'sh-year';
    const el = document.getElementById(id);
    if(!el) return;
    el.classList.toggle('filter-active', !!_cfActiveFilters[f]);
  });
}

// Hook into your existing filter pipeline.
// `applyFilters` should already exist somewhere in your code (the function that recomputes `filtered`).
// We monkey-patch to layer the column filters on top.
(function(){
  if(typeof applyFilters !== 'function') return;
  const _origApplyFilters = applyFilters;
  window.applyFilters = function(...args){
    _origApplyFilters.apply(this, args);
    // After base filtering, narrow further by active column filters
    if(_cfActiveFilters.genre){
      filtered = filtered.filter(t => _cfActiveFilters.genre.has((t.genre || '').trim() || '(vide)'));
    }
    if(_cfActiveFilters.year){
      filtered = filtered.filter(t => _cfActiveFilters.year.has((t.year || '').toString().trim() || '(vide)'));
    }
    if(typeof renderVirtual === 'function') renderVirtual();
  };
})();



// Search box live filter
document.addEventListener('DOMContentLoaded', () => {
  const s = document.getElementById('cfSearch');
  if(s) s.addEventListener('input', _cfRenderList);
  const c = document.getElementById('cfClear');
  if(c) c.addEventListener('click', () => { document.getElementById('cfSearch').value=''; _cfRenderList(); });
  // Close on outside click
  document.addEventListener('mousedown', (ev) => {
    const dd = document.getElementById('colFilter');
    if(!dd?.classList.contains('on')) return;
    if(ev.target.closest('#colFilter')) return;
    if(ev.target.closest('[data-filterable]')) return;
    closeColFilter();
  });
});

// ── PERSISTENCE LOCALE DES FAVORIS (fallback) ──
function _saveFavoritesToLocalStorage() {
  if (!allTracks) return;
  const favs = {};
  for (const t of allTracks) {
    if (t.isFavorite) favs[t.path] = true;
  }
  try {
    localStorage.setItem('wt_favorites', JSON.stringify(favs));
  } catch(e) {}
}

function _loadFavoritesFromLocalStorage() {
  if (!allTracks) return;
  try {
    const favs = JSON.parse(localStorage.getItem('wt_favorites') || '{}');
    for (const [path, isFav] of Object.entries(favs)) {
      const track = allTracks.find(t => t.path === path);
      if (track && isFav) track.isFavorite = true;
    }
  } catch(e) {}
}

function _toggleSpMenu(){
  const btn = document.getElementById('spGo');
  if(!btn) return;
  btn.style.display = (btn.style.display === 'none') ? 'block' : 'none';
}

function _stableTrackId(t) {
  if (!t) return '';
  let artistSlug = (t.artist || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  let titleSlug = (t.title || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!artistSlug) artistSlug = 'unknown';
  if (!titleSlug) {
    const filename = (t.path || '').split(/[/\\]/).pop() || '';
    titleSlug = filename.replace(/\.[^/.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!titleSlug) titleSlug = 'track';
  }
  return `${artistSlug}__${titleSlug}`;
}
