/* ============================================================================
 * WAVE TUNE — auto-resolve-core.js
 * CŒUR SANS INTERFACE du moteur AUTO (refonte « du global vers le précis »).
 *
 * RÔLE : exposer des résolveurs PURS (aucun DOM, aucune écriture de window._lastX,
 * aucun toast) qui reproduisent la consolidation du moteur de la « Recherche »
 * (searchCrossReference) — afin de brancher l'enrichQueue / un moteur de lot
 * dessus SANS recâbler l'éditeur.
 *
 * NE MODIFIE RIEN d'existant. Réutilise les globals déjà en place :
 *   unifiedSearch, _searchByTrack, clientMapGenre, clientMapChild,
 *   _corrGroupKey, _corrSoloKeys, _splitArtistFeat, _normArtistKey,
 *   _extractYearClue, _extractTitleYear, _composerFromTags  (tous gardés en typeof).
 *
 * À charger dans app.html APRÈS app-logic.js (classic script, mêmes globals).
 *
 * Expose : window.autoResolve = {
 *   resolveTrack, resolveArtistGenre, resolveAlbumYear, buildAutoResolvePlan,
 *   config
 * }
 *
 * NOTE : ce fichier RÉSOUT (renvoie des données pures). Il n'APPLIQUE rien et ne
 * touche pas l'enrichQueue — le branchement application/lot est l'étape suivante.
 * ========================================================================== */
(function () {
  'use strict';

  // ── Réglages (valeurs par défaut — voir décisions à confirmer dans le chat) ──
  const config = {
    // Album avec STRICTEMENT moins de morceaux que ce seuil → année résolue
    // AU MORCEAU plutôt qu'au niveau album (décision 3).
    MIN_ALBUM_TRACKS_FOR_ALBUM_YEAR: 4,
    // Genre/artiste (décision 1) : 'dominant' = un seul genre par artiste (le plus
    // fréquent sur les échantillons). L'exception par album/morceau pourra se
    // superposer plus tard sans changer cette base.
    GENRE_STRATEGY: 'dominant',
    // Nombre max de morceaux échantillonnés pour décider le genre d'un artiste.
    GENRE_SAMPLE_SIZE: 2,
  };

  // ── Détecteurs (regex calquées sur app-logic.js pour un comportement identique) ─
  function _isCompTrack(t) {
    if (!t) return false;
    if (t.path && /\/Compilations\//i.test(t.path)) return true;
    return /various|compilation|soundtrack|bande originale|\bost\b|greatest hits|best of|the very best|anniversary|billboard|top\s*\d{2,}|collection|anthology|\blive\b|en concert|en vivo/i
      .test((t.album || '') + ' ' + (t.artist || ''));
  }
  function _albTagReliable(album) {
    const v = String(album || '').trim();
    return !!(v && !/^\[?\s*(unknown|inconnu|untitled|sans titre|various|va)(\s+(album|artists?))?\s*\]?$/i.test(v));
  }
  // Œuvre CLASSIQUE détectée (regex calquée sur _looksClassical d'app-logic.js).
  // Sert à : forcer le genre « Classical & Opera » et n'accepter que l'année de
  // COMPOSITION (jamais une date d'enregistrement moderne).
  function _looksClassicalWork(artist, album, title) {
    const _al = (album || '') + ' ' + (title || '');
    if (/\b(symphony|sinfonia|concerto|sonata|quartet|quintet|prelude|nocturne|fugue|cantata)\b[\s.]*(no\.?\s*\d|n\.?\s*\d|in\s+[a-g]\b|\d)/i.test(_al)) return true;
    if (/\b(op\.?\s*\d|k\.?\s*\d{2,}|bwv\s*\d|hob\b)/i.test(_al)) return true;
    if (/\b(requiem|vigil|oratorio|mass\s+in|te\s+deum|magnificat)\b/i.test(_al)) return true;
    if (/\b(don giovanni|le nozze di figaro|cosi fan tutte|die zauberflote|the magic flute|la traviata|rigoletto|il trovatore|nabucco|aida|otello|carmen|faust|la boheme|la bohème|tosca|madama butterfly|turandot|the barber of seville|il barbiere|the marriage of figaro|fidelio|tannhauser|tannhäuser|lohengrin|parsifal|tristan und isolde|the ring|der ring|orfeo|peter grimes|the rake's progress|wozzeck|porgy and bess|messiah|st\.? matthew passion|st\.? john passion|the well-tempered clavier|goldberg variations|brandenburg|water music|music for the royal fireworks|the four seasons|le quattro stagioni|stabat mater|missa solemnis|carmina burana|bolero|boléro|peer gynt|pictures at an exhibition|swan lake|the nutcracker|sleeping beauty|romeo and juliet|firebird|petrushka|the rite of spring|la mer|clair de lune|nocturnes|preludes|etudes|nuages gris|gymnopedies|gymnopédies|gnossiennes)\b/i.test(_al)) return true;
    if (artist) {
      const _parts = String(artist).trim().split(/\s+/);
      if (_parts.length >= 3 && _parts.every(p => /^[A-ZÀ-Ý]/.test(p))) return true;
    }
    return false;
  }
  // B1 (soundtrack) : l'« artiste » renvoyé par le match album EST en fait le nom
  // de l'album/soundtrack (« Kill Bill, » pour « Kill Bill, Vol. 1 »). Détecte ce
  // cas pour le rejeter. NE PAS utiliser sur le classique (le compositeur est
  // légitimement dans l'album « Beethoven: Symphony… »).
  function _artistLooksLikeAlbum(artist, album) {
    const na = String(artist || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (na.length < 4) return false;
    // Album débarrassé de « Vol. N / Disc N / CD N / Part N » et d'un « (…) » final.
    const nl = String(album || '')
      .replace(/[,:\-]?\s*(vol\.?|volume|disc|cd|part|pt)\.?\s*\d+.*$/i, '')
      .replace(/\s*[\(\[][^)\]]*[\)\]]\s*$/, '')
      .toLowerCase().replace(/[^a-z0-9]/g, '');
    if (nl.length < 4) return false;
    // JUNK uniquement si l'artiste EST (à peu près) TOUT l'album (« Kill Bill, » =
    // « Kill Bill, Vol. 1 »), JAMAIS un simple préfixe « Artiste - Album » (sinon
    // on effacerait le vrai artiste, ex. The Doors / « The Doors - Greatest Hits »).
    return na === nl;
  }
  function _safeYearClue(album, title, query) {
    try { return (typeof _extractYearClue === 'function') ? _extractYearClue(album, title, query) : null; }
    catch (e) { return null; }
  }
  function _safeTitleYear(title) {
    try { return (typeof _extractTitleYear === 'function') ? _extractTitleYear(title) : null; }
    catch (e) { return null; }
  }
  function _safeNormArtist(s) {
    try { return (typeof _normArtistKey === 'function') ? _normArtistKey(s) : String(s || '').toLowerCase().trim(); }
    catch (e) { return String(s || '').toLowerCase().trim(); }
  }
  function _safeComposerFromTags(album, artist) {
    try { return (typeof _composerFromTags === 'function') ? _composerFromTags(album, artist) : null; }
    catch (e) { return null; }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // resolveTrack(track) — résolveur PUR au MORCEAU.
  // Port de la consolidation de searchCrossReference (sans DOM ni écriture de
  // window._lastBestMatch). Renvoie des données pures ou null.
  // → { artist, album, year, yearSource, genre, cover, title, isComp, isClassical }
  // ──────────────────────────────────────────────────────────────────────────
  async function resolveTrack(track) {
    if (!track) return null;
    if (typeof unifiedSearch !== 'function') return null;

    const yearClue  = _safeYearClue(track.album, track.title, '');
    const titleYear = _safeTitleYear(track.title);

    // Queries STRUCTURÉES uniquement (jamais de chaîne libre côté auto).
    const searchQueries = [];
    if (track.artist && track.album) searchQueries.push({ artist: track.artist, album: track.album });
    if (track.artist && track.title) searchQueries.push({ artist: track.artist, album: track.title });
    if (searchQueries.length === 0) {
      if (track.album)      searchQueries.push({ artist: '', album: track.album });
      else if (track.title) searchQueries.push({ artist: '', album: track.title });
    }
    if (searchQueries.length === 0) return null;

    const allResults = await Promise.all(searchQueries.map(q => unifiedSearch(q)));

    // Recherche par PISTE (débloque compils/B.O. — année & artiste d'origine).
    const isCompEarly = _isCompTrack(track);
    if (typeof _searchByTrack === 'function') {
      try {
        const tr = await _searchByTrack(track, titleYear || yearClue, isCompEarly);
        for (const r of (tr || [])) allResults.push(r);
      } catch (e) { /* silencieux */ }
    }

    // _pickBest : 1er résultat qui a le champ (avec prédicat de source optionnel).
    function _pickBest(field, sourcePredicate) {
      for (const r of allResults) {
        const m = r && r.bestMatch;
        if (m && m[field] && (!sourcePredicate || sourcePredicate(m.yearSource || m.genreSource || ''))) return m;
      }
      return null;
    }
    const _matchYear =
        _pickBest('year', s => /Wikipedia/i.test(s))
     || _pickBest('year', s => !/iTunes|Deezer/i.test(s))
     || _pickBest('year', null);
    const _matchGenre  = _pickBest('genre', null);
    const _matchArtist = _pickBest('artist', null) || _pickBest('album', null);

    // Meilleur candidat PISTE (recherche par titre), avec bonus année/artiste.
    const _trackResults = allResults.filter(r => r && r.bestMatch && /titre/i.test(r.bestMatch.source || ''));
    let _trackBest = null, _tbScore = -1;
    for (const tr of _trackResults) {
      const m = tr.bestMatch; if (!m) continue;
      let sc = m.score || 0;
      if (yearClue && m.year && Math.abs(parseInt(m.year) - yearClue) <= 2) sc += 40;
      if (track.artist && m.artist && m.artist.toLowerCase().includes(track.artist.toLowerCase())) sc += 30;
      if (sc > _tbScore) { _tbScore = sc; _trackBest = m; }
    }
    if (_trackBest && _tbScore < 60) _trackBest = null;

    // CLASSIQUE : œuvre détectée (regex de référence) OU genre/marqueur classique.
    // Pour une œuvre classique on IGNORE l'interprète (date récente) et on ne
    // gardera QUE l'année de composition.
    const _isClassical = _looksClassicalWork(track.artist, track.album, track.title)
                      || /classical|classique|opera|orchestral/i.test((_matchGenre?.genre || '') + ' ' + (_trackBest?.genre || ''));
    const _trackUsable = _trackBest && !_isClassical;

    const _albArtist = _matchArtist?.artist || '';
    const _composer  = _isClassical ? _safeComposerFromTags(track.album || '', track.artist || _albArtist) : null;
    const _isComp    = _isCompTrack(track)
                    || /various|compilation|soundtrack|bande originale|\bost\b|greatest hits|best of|the very best|anniversary|billboard|top\s*\d{2,}|collection|anthology|\blive\b|en concert|en vivo/i
                         .test(_albArtist + ' ' + (_matchArtist?.album || '') + ' ' + (track.album || ''));
    const _reliableAlb = _albTagReliable(track.album);

    // Préférer l'artiste de la recherche par TITRE s'il colle au tag et que
    // l'album-match diverge (corrige "ACDC Back" / "Fleetwood").
    const _akTag = _safeNormArtist(track.artist || '');
    const _akAlb = _safeNormArtist(_albArtist);
    const _akTrk = _trackUsable ? _safeNormArtist(_trackBest.artist || '') : '';
    const _preferTrackArtist = !!(_akTag && _akTrk && _akTrk === _akTag && _akAlb !== _akTag);

    let _finalArtist = (_isComp && _trackUsable) ? _trackBest.artist
                       : (_composer
                          || (_preferTrackArtist ? _trackBest.artist : null)
                          || _albArtist
                          || (_trackUsable ? _trackBest.artist : null)
                          || null);

    const _resolvedAlbum = (_reliableAlb ? track.album
               : ((_trackUsable && _trackBest.album) ? _trackBest.album : (track.album || _matchArtist?.album || null)));

    // B1 (soundtrack) : artiste = nom de l'album/soundtrack → faux. On laisse vide
    // (mieux vaut revue que faux), sauf classique (compositeur dans l'album, géré).
    if (!_isClassical && _artistLooksLikeAlbum(_finalArtist, _resolvedAlbum)) _finalArtist = null;

    // Année.
    const _wikiYear  = /Wikipedia/i.test(_matchYear?.yearSource || '') ? _matchYear.year : null;
    const _trackYear = (_trackUsable && _trackBest.year) ? parseInt(_trackBest.year) : null;
    let _finalYear, _finalYearSrc;
    if (_isClassical) {
      // Œuvre classique : SEULE la composition compte (Wikipedia ou année du titre).
      // On n'écrit JAMAIS une date d'enregistrement moderne comme année de l'œuvre
      // (mieux vaut vide → revue, que faux). 'jamais d'auto-écriture du faux'.
      _finalYear = _wikiYear || titleYear || null;
      _finalYearSrc = _wikiYear ? _matchYear.yearSource : (titleYear ? 'année du titre' : null);
    } else {
      // Wikipedia(composition) > titre > piste(1re sortie) > indice > album.
      _finalYear = _wikiYear || titleYear || _trackYear || yearClue || (_matchYear?.year || null);
      _finalYearSrc = _wikiYear ? _matchYear.yearSource
                    : (titleYear ? 'année du titre'
                    : (_trackYear ? 'recherche par titre'
                    : (yearClue ? 'indice album' : (_matchYear?.yearSource || null))));
    }

    // Genre : œuvre classique → toujours « Classical & Opera » (jamais un genre faux
    // type Jazz plaqué par une recherche bancale).
    let _finalGenre = _matchGenre?.genre || _trackBest?.genre || null;
    if (_isClassical) _finalGenre = 'Classical & Opera';

    return {
      title:  (_trackUsable && _trackBest.title) ? _trackBest.title : (track.title || null),
      artist: _finalArtist,
      album:  _resolvedAlbum,
      year:   _finalYear,
      yearSource: _finalYearSrc,
      genre:  _finalGenre,
      // Tag genre BRUT (avant mapping bucket) pour déduire l'enfant via clientMapChild.
      genreRaw: _isClassical ? null : (_matchGenre?.genre || _trackBest?.genre || null),
      cover:  (_trackUsable && _trackBest.cover) ? _trackBest.cover : null,
      isComp: _isComp,
      isClassical: _isClassical,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // resolveArtistGenre(artist, sampleTracks) — UN genre par ARTISTE (global).
  // 1 résolution / artiste fusionné, appliquée à tous ses morceaux. Échantillonne
  // quelques morceaux bien taggés, mappe via clientMapGenre, garde le DOMINANT.
  // → { genre, source } ou null.
  // ──────────────────────────────────────────────────────────────────────────
  async function resolveArtistGenre(artist, sampleTracks) {
    if (typeof unifiedSearch !== 'function') return null;
    const tracks = (sampleTracks || []).slice();
    // Échantillon : morceaux à album fiable et non-comp (le genre d'artiste se lit
    // mieux sur un vrai album studio), DÉDOUBLONNÉS par album (1 morceau/album) pour
    // profiter du cache — 2 albums distincts suffisent à fixer un genre dominant.
    const seenAlb = new Set();
    const samples = [];
    for (const t of tracks) {
      if (!t || !t.album || !_albTagReliable(t.album) || _isCompTrack(t)) continue;
      const ak = String(t.album).toLowerCase().trim();
      if (seenAlb.has(ak)) continue;
      seenAlb.add(ak);
      samples.push(t);
      if (samples.length >= config.GENRE_SAMPLE_SIZE) break;
    }
    const probe = samples.length ? samples : tracks.slice(0, config.GENRE_SAMPLE_SIZE);
    if (!probe.length && artist) probe.push({ artist: artist, album: '', title: '' });

    const tally = new Map(); // genreMappé → { value, count, source, raw }
    for (const t of probe) {
      let res = null;
      try { res = await resolveTrack(t); } catch (e) { res = null; }
      const raw = res && res.genre;
      if (!raw) continue;
      const rawTag = (res && res.genreRaw) ? res.genreRaw : raw; // tag précis pour l'enfant
      const mapped = (typeof clientMapGenre === 'function') ? (clientMapGenre(raw) || raw) : raw;
      if (!mapped) continue;
      const k = String(mapped).toLowerCase().trim();
      const cur = tally.get(k) || { value: mapped, count: 0, source: (res.genre ? 'auto (artiste)' : '?'), raw: null };
      cur.count += 1;
      if (!cur.raw && rawTag) cur.raw = rawTag;
      tally.set(k, cur);
    }
    if (!tally.size) return null;
    // DOMINANT : le genre le plus fréquent sur l'échantillon.
    let best = null;
    for (const v of tally.values()) if (!best || v.count > best.count) best = v;
    if (!best) return null;
    return { genre: best.value, raw: best.raw || null, source: best.source };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // resolveAlbumYear(artist, album, tracks) — UNE année par ALBUM (global).
  // First-release de l'album, appliquée aux morceaux de l'album. REPLI AU MORCEAU
  // (renvoie { perTrack:true }) si comp/best-of/soundtrack/live OU album trop petit.
  // → { year, yearSource } | { perTrack:true, reason } | null
  // ──────────────────────────────────────────────────────────────────────────
  async function resolveAlbumYear(artist, album, tracks) {
    const list = (tracks || []).filter(Boolean);
    // Repli au morceau si compil/B.O./live (l'année album serait celle de la compil).
    const anyComp = list.some(_isCompTrack)
      || _isCompTrack({ artist: artist || '', album: album || '' });
    if (anyComp) return { perTrack: true, reason: 'comp/best-of/soundtrack/live' };
    // Repli au morceau si trop peu de morceaux pour être fiable (décision 3).
    if (list.length > 0 && list.length < config.MIN_ALBUM_TRACKS_FOR_ALBUM_YEAR) {
      return { perTrack: true, reason: 'album trop petit (' + list.length + ' < ' + config.MIN_ALBUM_TRACKS_FOR_ALBUM_YEAR + ')' };
    }
    if (typeof unifiedSearch !== 'function') return null;
    if (!album || !_albTagReliable(album)) return { perTrack: true, reason: 'album tag absent/junk' };

    // Résolution album : on résout un morceau représentatif (porte la même
    // cascade d'année que la Recherche, 1re sortie privilégiée).
    const rep = list[0] || { artist: artist || '', album: album, title: '' };
    let res = null;
    try { res = await resolveTrack({ artist: artist || rep.artist || '', album: album, title: rep.title || '' }); }
    catch (e) { res = null; }
    if (res && res.year) return { year: res.year, yearSource: res.yearSource || 'auto (album)' };
    return null;
  }

  // Score de complétude (artiste presque complet = traité en 1er, vérif rapide).
  function _completeness(tracks) {
    if (!tracks.length) return 0;
    let n = 0;
    for (const t of tracks) {
      let s = 0;
      if (t.artist) s++;
      if (t.album && _albTagReliable(t.album)) s++;
      if (t.year) s++;
      if (t.genre) s++;
      n += s / 4;
    }
    return n / tracks.length; // 0..1
  }

  // ──────────────────────────────────────────────────────────────────────────
  // _groupLibrary(library) — regroupe par ARTISTE FUSIONNÉ → ALBUM en GARDANT les
  // OBJETS morceaux (refs), triés du fort volume/presque complet vers la niche.
  // Sert et au plan PUR (sérialisé en chemins) et au moteur de lot (refs).
  // → [ { key, name, tracks:[ref], _completeness, albums:[ { album, tracks:[ref],
  //       isComp, tooSmall, albReliable, yearScope, yearReplyReason } ] } ]
  // ──────────────────────────────────────────────────────────────────────────
  function _groupLibrary(library) {
    const lib = (library || []).filter(t => t && (t.artist || t.album || t.title));
    const soloKeys = (typeof _corrSoloKeys === 'function') ? _corrSoloKeys(lib) : new Set();
    const groupKey = (t) => (typeof _corrGroupKey === 'function')
      ? _corrGroupKey(t, soloKeys)
      : { key: _safeNormArtist(t.artist || ''), name: t.artist || 'Artiste inconnu', feat: '' };

    const artists = new Map(); // key → { key, name, tracks:[], albums:Map }
    for (const t of lib) {
      const g = groupKey(t);
      if (!artists.has(g.key)) artists.set(g.key, { key: g.key, name: g.name, tracks: [], albums: new Map() });
      const A = artists.get(g.key);
      A.tracks.push(t);
      const albName = (t.album || '').trim();
      const albKey = albName.toLowerCase();
      if (!A.albums.has(albKey)) A.albums.set(albKey, { album: albName, tracks: [] });
      A.albums.get(albKey).tracks.push(t);
    }

    const out = [];
    for (const A of artists.values()) {
      const albums = [];
      for (const al of A.albums.values()) {
        const isComp = al.tracks.some(_isCompTrack) || _isCompTrack({ artist: A.name, album: al.album });
        const tooSmall = al.tracks.length > 0 && al.tracks.length < config.MIN_ALBUM_TRACKS_FOR_ALBUM_YEAR;
        const albReliable = _albTagReliable(al.album);
        albums.push({
          album: al.album,
          tracks: al.tracks,
          isComp, tooSmall, albReliable,
          yearScope: (isComp || tooSmall || !albReliable) ? 'perTrack' : 'album',
          yearReplyReason: isComp ? 'comp/live' : (tooSmall ? 'album trop petit' : (!albReliable ? 'album junk' : null)),
        });
      }
      out.push({ key: A.key, name: A.name, tracks: A.tracks, albums, _completeness: _completeness(A.tracks) });
    }
    // ORDRE : volume DESC puis complétude DESC.
    out.sort((a, b) => (b.tracks.length - a.tracks.length) || (b._completeness - a._completeness));
    return out;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // buildAutoResolvePlan(library) — PLAN « du global vers le précis » (PUR).
  //   - 1 job GENRE / artiste, 1 job ANNÉE / album (sauf comp/petit → perTrack).
  // N'exécute RIEN — version sérialisable (chemins) à inspecter en console.
  // ──────────────────────────────────────────────────────────────────────────
  function buildAutoResolvePlan(library) {
    const grouped = _groupLibrary(library);
    const lib = (library || []).filter(t => t && (t.artist || t.album || t.title));
    const plan = grouped.map(A => ({
      artistKey: A.key,
      artistName: A.name,
      trackCount: A.tracks.length,
      paths: A.tracks.map(t => t.path).filter(Boolean),
      genreScope: 'artist',
      albums: A.albums.map(al => ({
        album: al.album,
        trackCount: al.tracks.length,
        paths: al.tracks.map(t => t.path).filter(Boolean),
        yearScope: al.yearScope,
        yearReplyReason: al.yearReplyReason,
      })),
      _completeness: A._completeness,
    }));

    return {
      generatedAt: Date.now(),
      artistCount: plan.length,
      albumCount: plan.reduce((n, p) => n + p.albums.length, 0),
      trackCount: lib.length,
      // Coût attendu : ~1 lookup genre/artiste + ~1 lookup année/album (hors repli).
      estGenreLookups: plan.length,
      estAlbumYearLookups: plan.reduce((n, p) => n + p.albums.filter(a => a.yearScope === 'album').length, 0),
      artists: plan,
      config: Object.assign({}, config),
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // _applyFixToTrack(t, fix) — APPLIQUE genre/année à UN morceau via le sidecar.
  // Réplique FIDÈLEMENT la section apply de enrichQueue._processItem :
  //   - genre : seulement si vide/junk (jamais d'écrasement d'une valeur valide),
  //   - année : comble un trou OU corrige une réédition (trusted + plus ancienne
  //             + !_userModified),
  //   - persistance applyTrackMetaToMain + _autoFix + recordAutoFix + scheduleMetaSave,
  //   - recalcul _incomplete + _autoOutcome + badge.
  // RESPECTE _userModified/_ignored (le morceau est ignoré en amont). Pas d'album
  // ni d'artiste ici (hors périmètre du lot auto — gérés par la recherche forcée).
  // fix = { genreVal, genreRaw, genreSource, yearVal, yearTrusted, yearSource, source }
  // → true si quelque chose a été appliqué.
  // ──────────────────────────────────────────────────────────────────────────
  function _applyFixToTrack(t, fix) {
    if (!t || t._userModified || t._ignored) return false;
    const _isJunkG = (g) => (typeof isJunkGenre === 'function') ? isJunkGenre(g) : !g;
    const _isJunkY = (y) => (typeof isJunkYear === 'function') ? isJunkYear(y) : !y;
    const _isJunkArtist = (s) => { const v = String(s || '').trim(); return !v || /^\[?\s*(unknown|inconnu|various|va|artiste inconnu|untitled)\s*\]?$/i.test(v); };
    const _fix = { genre: null, year: null, album: null, artist: null };
    let applied = false;

    // ARTISTE — remplit seulement si vide/junk (jamais d'écrasement d'un artiste valide).
    const av = fix && fix.artistVal;
    if (av && _isJunkArtist(t.artist)) {
      _fix.artist = { from: t.artist || '', to: av };
      t.artist = av;
      applied = true;
    }

    // GENRE — remplit vide/junk uniquement.
    const gv = fix && fix.genreVal;
    const genreEmpty = (!t.genre || _isJunkG(t.genre));
    if (gv && genreEmpty) {
      _fix.genre = { from: t.genre || '', to: gv };
      t.genre = gv;
      if (!t.genreChild && typeof clientMapChild === 'function') {
        const _c = clientMapChild(fix.genreRaw || gv);
        if (_c) t.genreChild = _c;
      }
      applied = true;
    }

    // ANNÉE — comble un trou, OU corrige une réédition (trusted + plus ancienne).
    const yv = (fix && fix.yearVal) ? parseInt(fix.yearVal) : null;
    const yearEmpty = (!t.year || _isJunkY(t.year));
    const _curY = t.year ? parseInt(t.year) : null;
    const _fixReissue = yv && !yearEmpty && !t._userModified && fix.yearTrusted && _curY && yv < _curY;
    if (yv && (yearEmpty || _fixReissue)) {
      _fix.year = { from: t.year || '', to: yv };
      t.year = yv;
      applied = true;
    }

    if (applied) {
      try {
        if (window.wt && window.wt.applyTrackMetaToMain) {
          window.wt.applyTrackMetaToMain({ path: t.path, artist: t.artist, genre: t.genre, year: t.year, album: t.album, source: (fix.source || 'bulk-auto') });
        }
      } catch (e) { /* silencieux */ }
      t._autoFixed = true;
      t._autoFix = { artist: _fix.artist, genre: _fix.genre, year: _fix.year, album: _fix.album, source: (fix.genreSource || fix.yearSource || fix.source || 'bulk-auto'), ts: Date.now() };
      if (typeof recordAutoFix === 'function') recordAutoFix(t, t._autoFix);
      if (typeof scheduleMetaSave === 'function') scheduleMetaSave();
    }

    // Recalcul _incomplete (mêmes critères que _processItem).
    const noG = !t.genre || _isJunkG(t.genre);
    const noY = !t.year || _isJunkY(t.year);
    if (noG || noY) t._incomplete = true; else delete t._incomplete;

    t._autoProcessed = true;
    t._autoOutcome = applied ? 'corrected' : (t._autoOutcome || 'empty');
    return applied;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // MOTEUR DE LOT « du global vers le précis » — headless, pausable/reprenable.
  // Pour chaque artiste (ordre fort-volume→niche) :
  //   1. GENRE résolu UNE fois (sauf pseudo-artiste VA/compil → sauté),
  //   2. par ALBUM : année résolue UNE fois (album-level) puis ÉTALÉE sur ses
  //      morceaux ; repli AU MORCEAU pour comp/petit album/junk.
  // N'utilise PAS enrichQueue/_processItem : pas de re-fetch par morceau, pas de
  // garde « match suspect ». Réutilise throttle/cache/circuit-breaker du main
  // (tout fetch passe par window.wt.fetchOnlineMeta → auto-paced).
  // ──────────────────────────────────────────────────────────────────────────
  const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Rafraîchit la modale de revue SI elle est ouverte (Corrigé/En attente/Aucune
  // info), throttlé, sans casser une ligne en cours d'édition.
  let _lastReviewRefresh = 0;
  function _refreshOpenReview(force) {
    if (typeof document === 'undefined') return;
    const ov = document.getElementById('metaReviewOv');
    if (!ov) return;
    const now = Date.now();
    if (!force && (now - _lastReviewRefresh) < 1200) return;
    // Ne pas redessiner pendant que l'utilisateur tape dans un champ de la modale.
    const ae = document.activeElement;
    if (ae && ov.contains(ae) && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return;
    _lastReviewRefresh = now;
    try { if (typeof _mrRenderAll === 'function') _mrRenderAll(); } catch (e) { /* */ }
  }

  const bulk = {
    _running: false, _paused: false, _stop: false,
    _onProgress: null,
    _progress: null,

    async _waitIfPaused() {
      while (this._paused && !this._stop) { await _sleep(300); }
    },
    _emit() {
      if (typeof this._onProgress === 'function') {
        try { this._onProgress(Object.assign({}, this._progress)); } catch (e) { /* */ }
      }
    },

    // start({ library, onProgress }) — lance le lot. library défaut = allTracks.
    async start(opts) {
      if (this._running) { console.warn('[autoResolve.bulk] déjà en cours'); return this._progress; }
      opts = opts || {};
      const library = opts.library
        || ((typeof allTracks !== 'undefined') ? allTracks : (window.allTracks || []));
      this._onProgress = opts.onProgress || null;
      this._running = true; this._paused = false; this._stop = false;

      const grouped = _groupLibrary(library);
      this._progress = {
        artistsTotal: grouped.length, artistsDone: 0,
        tracksApplied: 0, tracksSeen: 0,
        genreLookups: 0, yearLookups: 0,
        currentArtist: null, startedAt: Date.now(), done: false,
      };
      console.log('[autoResolve.bulk] démarrage —', grouped.length, 'artistes');
      this._emit();

      try {
        for (const A of grouped) {
          if (this._stop) break;
          await this._waitIfPaused();
          this._progress.currentArtist = A.name;

          // Garde « ne travailler que sur l'INCOMPLET » : on saute tout ce qui est
          // déjà valide (genre + année), comme le moteur lazy ne touche que les
          // _incomplete. Évite des milliers de lookups inutiles sur le déjà-fait.
          const _isJunkG = (g) => (typeof isJunkGenre === 'function') ? isJunkGenre(g) : !g;
          const _isJunkY = (y) => (typeof isJunkYear === 'function') ? isJunkYear(y) : !y;
          const _needsGenre = (t) => !t.genre || _isJunkG(t.genre);
          const _needsYear  = (t) => !t.year  || _isJunkY(t.year);
          const _needsWork  = (t) => _needsGenre(t) || _needsYear(t);

          const eligible = A.tracks.filter(t => t && !t._userModified && !t._ignored);
          const work = eligible.filter(_needsWork);
          if (!work.length) { this._progress.artistsDone++; this._emit(); continue; }

          // Pseudo-artiste VA / dominé par les compils → pas de genre plaqué.
          // Artiste VIDE/inconnu → grab-bag hétérogène : on traite TOUT au morceau
          // (genre + artiste par morceau), jamais un genre d'« artiste » global faux.
          const compShare = A.tracks.filter(_isCompTrack).length / Math.max(1, A.tracks.length);
          const isUnknownArtist = !String(A.name || '').trim()
            || /^(artiste inconnu|unknown|inconnu|various artists?|various|va|untitled)$/i.test((A.name || '').trim());
          const isVA = isUnknownArtist || compShare > 0.6
            || /^(compilation|soundtrack|bande originale|ost)$/i.test((A.name || '').trim());

          // 1) GENRE résolu UNE fois pour l'artiste — seulement si un morceau en manque.
          let artistGenre = null;
          if (!isVA && work.some(_needsGenre)) {
            try { artistGenre = await resolveArtistGenre(A.name, eligible); }
            catch (e) { artistGenre = null; }
            this._progress.genreLookups++;
          }

          // 2) ANNÉE par ALBUM (étalée), repli au morceau si besoin.
          for (const al of A.albums) {
            if (this._stop) break;
            await this._waitIfPaused();
            const albEligible = al.tracks.filter(t => t && !t._userModified && !t._ignored);
            const albWork = albEligible.filter(_needsWork);
            if (!albWork.length) continue;            // album déjà complet → skip

            const yearNeeded = albWork.some(_needsYear);
            let albumYear = null;     // { value, trusted, source }
            // Artiste inconnu → toujours au morceau (chaque morceau a son propre
            // artiste/genre/année à retrouver).
            let perTrack = (al.yearScope === 'perTrack') || isUnknownArtist;

            // Lookup année album SEULEMENT si au moins un morceau manque l'année.
            if (!perTrack && yearNeeded) {
              try {
                const r = await resolveAlbumYear(A.name, al.album, al.tracks);
                this._progress.yearLookups++;
                if (r && r.perTrack) perTrack = true;
                else if (r && r.year) {
                  albumYear = { value: r.year, source: r.yearSource || 'auto (album)',
                                trusted: /MusicBrainz|Wikipedia/i.test(r.yearSource || '') };
                }
              } catch (e) { /* repli au morceau */ perTrack = perTrack || false; }
            }

            if (!perTrack) {
              // Année album déjà fetchée → on l'étale sur TOUS les morceaux éligibles
              // (pas seulement ceux qui manquent l'année) : ça corrige les rééditions
              // (réédition>originale) SANS lookup supplémentaire. _applyFixToTrack
              // no-op sur ce qui est déjà juste.
              for (const t of albEligible) {
                const did = _applyFixToTrack(t, {
                  genreVal: artistGenre ? artistGenre.genre : null,
                  genreRaw: artistGenre ? artistGenre.raw : null,
                  genreSource: artistGenre ? artistGenre.source : null,
                  yearVal: albumYear ? albumYear.value : null,
                  yearTrusted: albumYear ? albumYear.trusted : false,
                  yearSource: albumYear ? albumYear.source : null,
                  source: 'bulk-auto (album)',
                });
                this._progress.tracksSeen++;
                if (did) this._progress.tracksApplied++;
                _refreshOpenReview();
              }
            } else {
              // Repli AU MORCEAU : résout le morceau si année OU artiste manquant,
              // ou si genre manquant sans genre-artiste sous la main.
              const _isJunkArtist = (s) => { const v = String(s || '').trim(); return !v || /^\[?\s*(unknown|inconnu|various|va|artiste inconnu|untitled)\s*\]?$/i.test(v); };
              for (const t of albWork) {
                if (this._stop) break;
                await this._waitIfPaused();
                const needY = _needsYear(t), needG = _needsGenre(t), needA = _isJunkArtist(t.artist);
                let res = null;
                if (needY || needA || (needG && !artistGenre)) {
                  try { res = await resolveTrack(t); } catch (e) { res = null; }
                  this._progress.yearLookups++;
                }
                let gVal = artistGenre ? artistGenre.genre : null;
                let gRaw = artistGenre ? artistGenre.raw : null, gSrc = artistGenre ? artistGenre.source : null;
                if (!gVal && res && res.genre) {
                  gRaw = res.genreRaw || res.genre;
                  gVal = (typeof clientMapGenre === 'function') ? (clientMapGenre(res.genre) || res.genre) : res.genre;
                  gSrc = 'auto (morceau)';
                }
                const did = _applyFixToTrack(t, {
                  artistVal: res ? res.artist : null,
                  genreVal: gVal, genreRaw: gRaw, genreSource: gSrc,
                  yearVal: res ? res.year : null,
                  yearTrusted: res ? /MusicBrainz|Wikipedia/i.test(res.yearSource || '') : false,
                  yearSource: res ? res.yearSource : null,
                  source: 'bulk-auto (morceau)',
                });
                this._progress.tracksSeen++;
                if (did) this._progress.tracksApplied++;
                // Rafraîchit la revue en direct au fil des morceaux (throttlé) : un
                // gros album/artiste se remplit visiblement sans attendre la fin.
                _refreshOpenReview();
              }
            }
            // Rafraîchit la revue + le badge À CHAQUE ALBUM (throttlé) : sinon un
            // premier artiste énorme ne montre rien pendant longtemps.
            if (typeof refreshReviewBadge === 'function') refreshReviewBadge();
            _refreshOpenReview();
            this._emit();
          }

          this._progress.artistsDone++;
          if (typeof refreshReviewBadge === 'function') refreshReviewBadge();
          if (typeof _scheduleEnrichUiRefresh === 'function') _scheduleEnrichUiRefresh();
          _refreshOpenReview();
          this._emit();
        }
      } catch (e) {
        console.warn('[autoResolve.bulk] erreur:', e && e.message);
      }

      this._progress.done = true;
      this._progress.currentArtist = null;
      this._running = false;
      if (typeof refreshReviewBadge === 'function') refreshReviewBadge();
      if (typeof _scheduleEnrichUiRefresh === 'function') _scheduleEnrichUiRefresh();
      _refreshOpenReview(true);
      console.log('[autoResolve.bulk] terminé —', this._progress.tracksApplied, 'morceaux corrigés /',
        this._progress.tracksSeen, 'vus (', this._progress.genreLookups, 'lookups genre,',
        this._progress.yearLookups, 'lookups année)');
      this._emit();
      return this._progress;
    },

    pause()  { this._paused = true;  console.log('[autoResolve.bulk] pause'); },
    resume() { this._paused = false; console.log('[autoResolve.bulk] reprise'); },
    stop()   { this._stop = true; this._paused = false; console.log('[autoResolve.bulk] arrêt demandé'); },
    status() { return this._progress ? Object.assign({ running: this._running, paused: this._paused }, this._progress) : { running: false }; },
  };

  // bulkResolveByPlan(opts) — alias d'appel direct du moteur de lot.
  function bulkResolveByPlan(opts) { return bulk.start(opts); }

  // ──────────────────────────────────────────────────────────────────────────
  // UI : bouton « Auto par lot » + badge de progression, injectés dans le
  // split-button #wtMetaSplit (à côté de « Infos à vérifier »). Aucun edit de
  // app.html. Clic = démarre ; pendant le run = pause/reprise ; ⏹ = stop.
  // ──────────────────────────────────────────────────────────────────────────
  let _uiPoll = null;
  function _ensureBulkAffordanceCss() {
    if (document.getElementById('wt-bulk-affordance-style')) return;
    const css = `
#wtBulkBtn { transition: background .15s; }
#wtBulkBtn:hover { background: rgba(255,255,255,0.08); }
#wtBulkBtn svg { transform-origin: center; transition: opacity .2s; animation: wtBoltIdle 2.5s ease-in-out infinite; }
#wtBulkBtn:hover svg { opacity: 1 !important; animation: none; }
#wtBulkBtn.is-bulk-running svg { animation: wtBoltBeat .9s ease-in-out infinite; }
@keyframes wtBoltIdle { 0%,100% { opacity:.6 } 50% { opacity:1 } }
@keyframes wtBoltBeat { 0%,100% { opacity:.55; transform:scale(1) } 50% { opacity:1; transform:scale(1.12) } }
`;
    const st = document.createElement('style');
    st.id = 'wt-bulk-affordance-style';
    st.textContent = css;
    document.head.appendChild(st);
  }
  // ── D — Explicatif au premier lancement ──────────────────────────────────
  // Un lambda ne sait pas ce que fait le cluster. On montre UNE fois un petit
  // encart sous « Auto / À vérifier » pour expliquer le pipeline. Persisté en
  // localStorage (réaffiché si jamais non vu). Purement additif, dismissable.
  function _ensureAutoExplainerCss() {
    if (document.getElementById('wt-auto-explainer-style')) return;
    const css = `
.wt-auto-explainer{position:fixed;z-index:9999;width:300px;max-width:calc(100vw - 16px);background:var(--pop,#26261F);color:var(--t1,#EDEAE0);border:.5px solid rgba(255,255,255,.14);border-radius:12px;padding:14px 16px;box-shadow:0 12px 40px rgba(0,0,0,.45);font-size:13px;line-height:1.5;animation:waeIn .18s ease;}
.wt-auto-explainer .wae-title{font-weight:600;margin-bottom:6px;}
.wt-auto-explainer .wae-body{color:var(--t2,#B8B5AC);}
.wt-auto-explainer .wae-body b{color:var(--t1,#EDEAE0);font-weight:600;}
.wt-auto-explainer .wae-ok{margin-top:12px;width:100%;padding:7px;border:none;border-radius:8px;background:#C85A45;color:#fff;font-size:12px;font-weight:600;cursor:pointer;}
.wt-auto-explainer .wae-ok:hover{filter:brightness(1.08);}
@keyframes waeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
`;
    const st = document.createElement('style'); st.id = 'wt-auto-explainer-style'; st.textContent = css; document.head.appendChild(st);
  }
  function _maybeShowAutoExplainer(tries) {
    tries = tries || 0;
    if (typeof document === 'undefined') return;
    try { if (localStorage.getItem('wt_auto_explainer_seen_v2')) return; } catch (_) { return; }
    if (document.getElementById('wtAutoExplainer')) return;
    const split = document.getElementById('wtMetaSplit');
    if (!split) { if (tries < 20) setTimeout(function(){ _maybeShowAutoExplainer(tries + 1); }, 500); return; }
    _ensureAutoExplainerCss();
    const pop = document.createElement('div');
    pop.id = 'wtAutoExplainer'; pop.className = 'wt-auto-explainer';
    pop.innerHTML = '<div class="wae-title">Correction automatique</div>'
      + '<div class="wae-body"><b>Corriger tout · auto</b> passe la bibliothèque entière en arrière-plan : il complète genre et année quand les sources concordent (pausable, ■ pour arrêter, annulable depuis « Corrigé »). Ce qui reste douteux atterrit dans <b>À vérifier</b> pour ta relecture. Tes modifications manuelles ne sont jamais touchées.</div>'
      + '<button class="wae-ok" id="wtAutoExplainerOk">Compris</button>';
    document.body.appendChild(pop);
    const r = split.getBoundingClientRect();
    pop.style.top = (r.bottom + 8) + 'px';
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 316)) + 'px';
    const close = function(){ try { localStorage.setItem('wt_auto_explainer_seen_v2', '1'); } catch (_) {} pop.remove(); };
    pop.querySelector('#wtAutoExplainerOk').addEventListener('click', close);
  }
  try { setTimeout(function(){ _maybeShowAutoExplainer(0); }, 1500); } catch (_) {}
  function _bulkLabel() {
    const s = bulk.status();
    if (!s.running) return 'Corriger tout · auto';
    if (bulk._stop) return 'Arrêt…';
    const n = (s.tracksApplied || 0) + ' corrigés';
    return s.paused ? ('Correction en pause · ' + n) : ('Correction auto · ' + n);
  }
  function _bulkTitle() {
    const s = bulk.status();
    if (!s.running) return "Corrige genre + année de toute la bibliothèque en arrière-plan (du global vers le précis, ne touche que l'incomplet). Pausable. Annulable depuis « Corrigé ».";
    return (s.artistsDone || 0) + '/' + (s.artistsTotal || 0) + ' artistes traités'
      + (s.currentArtist ? ' · en cours : ' + s.currentArtist : '')
      + ' · ' + (s.tracksApplied || 0) + ' morceaux corrigés'
      + (s.paused ? ' · clic pour reprendre' : ' · clic pour mettre en pause');
  }
  function _updateBulkUI() {
    _ensureBulkAffordanceCss();
    const lab = document.getElementById('wtBulkLabel');
    const btn = document.getElementById('wtBulkBtn');
    const stop = document.getElementById('wtBulkStop');
    if (lab) lab.textContent = _bulkLabel();
    if (btn) btn.title = _bulkTitle();
    const st = bulk.status();
    const running = st.running;
    if (stop) stop.style.display = running ? 'inline-flex' : 'none';
    // Éclair : pulse discret au repos (action dispo), battement pendant le run
    // actif, pulse de nouveau en pause (clique pour reprendre).
    if (btn) btn.classList.toggle('is-bulk-running', running && !st.paused);
  }
  function _onBulkClick() {
    const s = bulk.status();
    if (!s.running) { bulk.start({ onProgress: _updateBulkUI }); }
    else if (s.paused) { bulk.resume(); }
    else { bulk.pause(); }
    _updateBulkUI();
  }
  function _mountBulkUI() {
    if (typeof document === 'undefined') return false;
    const split = document.getElementById('wtMetaSplit');
    if (!split) return false;
    if (document.getElementById('wtBulkBtn')) return true;

    const btn = document.createElement('button');
    btn.id = 'wtBulkBtn';
    btn.className = 'tb-chip';
    btn.title = "Corrige genre + année de toute la bibliothèque en arrière-plan (du global vers le précis, ne touche que l'incomplet). Pausable. Annulable depuis « Corrigé ».";
    btn.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:9px;letter-spacing:.05em;padding:4px 10px;border:none;border-radius:0;background:transparent;cursor:pointer;color:inherit;';
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px"><path d="M13 2 L3 14 h7 l-1 8 L19 10 h-7 z"/></svg><span id="wtBulkLabel">Auto par lot</span>';
    btn.addEventListener('click', _onBulkClick);

    const stop = document.createElement('button');
    stop.id = 'wtBulkStop';
    stop.className = 'tb-chip';
    stop.title = "Arrêter le traitement par lot";
    stop.style.cssText = 'display:none;align-items:center;padding:4px 8px;border:none;border-radius:0;background:transparent;cursor:pointer;color:inherit;';
    stop.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" style="width:11px;height:11px"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';
    stop.addEventListener('click', () => { bulk.stop(); _updateBulkUI(); });

    // UX — Auto à gauche (le moteur), « À vérifier » à droite (ta boîte de
    // réception). Gauche→droite = le pipeline : l'auto corrige le sûr, le douteux
    // retombe en revue. Un seul séparateur, posé devant la revue.
    const review = document.getElementById('btnMetaReview');
    if (review) {
      review.style.borderLeft = '1px solid rgba(255,255,255,0.12)';
      split.insertBefore(btn, review);  // [Auto] devant la revue
      btn.after(stop);                  // [Auto][Stop] devant la revue
    } else {
      split.appendChild(btn);
      split.appendChild(stop);
    }
    _updateBulkUI();
    // Badge tenu à jour même si le lot est lancé depuis la console (coût négligeable).
    if (!_uiPoll) _uiPoll = setInterval(_updateBulkUI, 1000);
    return true;
  }
  // Monte l'UI dès que le header est prêt (quelques tentatives, le header peut
  // se rendre après le boot).
  (function _scheduleMount() {
    if (typeof document === 'undefined') return;
    let tries = 0;
    const tryMount = () => {
      if (_mountBulkUI() || ++tries > 20) return;
      setTimeout(tryMount, 500);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => setTimeout(tryMount, 300));
    } else {
      setTimeout(tryMount, 300);
    }
  })();

  // Expose le cœur + le moteur de lot.
  window.autoResolve = {
    config,
    // résolveurs purs
    resolveTrack,
    resolveArtistGenre,
    resolveAlbumYear,
    buildAutoResolvePlan,
    // moteur de lot (applique)
    bulk,
    bulkResolveByPlan,
    // UI
    _mountBulkUI,
    // utilitaires / debug
    _groupLibrary,
    _applyFixToTrack,
    _refreshOpenReview,
    _isCompTrack,
    _albTagReliable,
  };
})();
