// src/saved-from-waves.js
// Wave Tune Desktop — "Reçu de tes ondes"
//
// Affiche la liste des morceaux que l'user a marqués sur son téléphone :
//   - saved_for_later (working set : "à écouter plus tard")
//   - commented      (engagement réel : a écouté + écrit un ressenti)
//   - reshared       (a partagé en pépite à quelqu'un)
//
// Lecture live de users/{uid}/history/ via Firestore listener.
// Inclut aussi :
//   - L'injection du bouton "Connexion téléphone" sous Sync Smartphone
//   - Le patch des fonctions showAll/showLib/showSyncView/showPlaylist
//     pour qu'elles cachent automatiquement wavesView.

(function() {
  let unsubHistory = null;
  let entries = [];
  let activeFilter = 'all';
  let previewAudio = null;
  let viewActive = false;

// ── Patches : toggle indépendant par panneau ─────────────────────────
  // Chaque panneau (Bibliothèque, Sync, Ondes) peut être ouvert ou fermé
  // indépendamment. Re-cliquer dessus le toggle. Au moins un panneau reste
  // toujours visible (sinon écran vide bizarre).

  function isLibVisible() {
    const v = document.getElementById('libView');
    return v && v.style.display !== 'none';
  }
  function isSyncVisible() {
    const v = document.getElementById('syncView');
    return v && v.classList.contains('on');
  }
  function isWavesVisible() {
    const v = document.getElementById('wavesView');
    return v && v.style.display !== 'none';
  }
  function visibleCount() {
    return (isLibVisible() ? 1 : 0) + (isSyncVisible() ? 1 : 0) + (isWavesVisible() ? 1 : 0);
  }

  function hideLib() {
    const v = document.getElementById('libView');
    if (v) v.style.display = 'none';
    document.getElementById('si-lib')?.classList.remove('on');
  }
  function hideSync() {
    const v = document.getElementById('syncView');
    if (v) v.classList.remove('on');
    document.getElementById('si-sync')?.classList.remove('on');
  }
  function hideWaves() {
    const v = document.getElementById('wavesView');
    if (v) v.style.display = 'none';
    document.getElementById('si-waves')?.classList.remove('on');
  }

  // ── Patches : toggle indépendant par panneau ─────────────────────────
  // Chaque panneau (Bibliothèque, Sync, Ondes) peut être ouvert ou fermé
  // indépendamment. Re-cliquer dessus le toggle. Au moins un panneau reste
  // toujours visible.

  function isLibVisible() {
    const v = document.getElementById('libView');
    return !!(v && v.style.display !== 'none');
  }
  function isSyncVisible() {
    const v = document.getElementById('syncView');
    return !!(v && v.classList.contains('on'));
  }
  function isWavesVisible() {
    const v = document.getElementById('wavesView');
    return !!(v && v.style.display !== 'none');
  }
  function visibleCount() {
    return (isLibVisible() ? 1 : 0) + (isSyncVisible() ? 1 : 0) + (isWavesVisible() ? 1 : 0);
  }

  function showLibOnly() {
    const v = document.getElementById('libView');
    if (v) v.style.display = 'flex';
    document.getElementById('si-lib')?.classList.add('on');
    const w = document.getElementById('welcome');
    if (w) w.style.display = 'none';
  }
  function hideLib() {
    const v = document.getElementById('libView');
    if (v) v.style.display = 'none';
    document.getElementById('si-lib')?.classList.remove('on');
  }
  function showSyncOnly() {
    const v = document.getElementById('syncView');
    if (v) v.classList.add('on');
    document.getElementById('si-sync')?.classList.add('on');
    const w = document.getElementById('welcome');
    if (w) w.style.display = 'none';
    if (typeof window.renderSyncQueue === 'function') window.renderSyncQueue();
  }
  function hideSync() {
    const v = document.getElementById('syncView');
    if (v) v.classList.remove('on');
    document.getElementById('si-sync')?.classList.remove('on');
  }
  function hideWaves() {
    const v = document.getElementById('wavesView');
    if (v) v.style.display = 'none';
    document.getElementById('si-waves')?.classList.remove('on');
  }

  function applyViewPatches() {
    if (window._wavesPatchesApplied) return;
    window._wavesPatchesApplied = true;

    // ── showAll : toggle library, garde les autres panneaux intacts ──
    // Patch N.3.5 : on appelle la vraie showAll() qui vit dans la closure
    // d'app.html et touche les VRAIES variables `let curPl` et `let filtered`
    // (sinon en passant par window.filtered / window.curPl, on crée des
    // propriétés window qui ne sont PAS les variables du module).
    const origShowAll = window.showAll;
    if (typeof origShowAll === 'function') {
      window.showAll = function() {
        // Si library est déjà visible et y'a au moins un autre panneau, on ferme
        if (isLibVisible() && visibleCount() > 1) {
          hideLib();
          return;
        }
        // Sinon : on délègue à la vraie showAll d'origine, qui s'occupe de
        // reset curPl, filtered, classes DOM et tri. On laisse juste showLibOnly()
        // gérer la visibilité des panneaux (syncView/wavesView) après.
        try {
          origShowAll();
        } catch (e) { console.warn('[waves-patch] origShowAll:', e); }
        showLibOnly();
      };
    }

    // ── showSyncView : toggle sync, garde les autres panneaux intacts ──
    const origShowSync = window.showSyncView;
    if (typeof origShowSync === 'function') {
      window.showSyncView = function() {
        if (isSyncVisible() && visibleCount() > 1) {
          hideSync();
          return;
        }
        showSyncOnly();
      };
    }

    // ── showLib : ne cache plus syncView (utilisé par showPlaylist) ──
    // On le redéfinit pour qu'il montre libView mais sans toucher à syncView/wavesView.
    window.showLib = function() {
      showLibOnly();
    };

    // showPlaylist reste tel quel — quand l'user clique une playlist, c'est
    // OK qu'il voie sa playlist dans libView, comportement naturel.
  }

  // ── DOM injection : vue principale ──────────────────────────────────

  function ensureViewExists() {
    if (document.getElementById('wavesView')) return;

    const view = document.createElement('div');
    view.id = 'wavesView';
    view.style.cssText = `
      flex:1;display:none;flex-direction:column;
      background:var(--bg0);overflow:hidden;
    `;
    view.innerHTML = `
      <div id="wavesHeader" style="
        padding:18px 22px 12px;border-bottom:.5px solid var(--ln);
        display:flex;align-items:center;justify-content:space-between;
      ">
        <div>
          <div style="font-family:var(--font-title);font-size:13px;font-weight:600;letter-spacing:.04em;color:var(--t1)">
            Reçu de tes ondes
          </div>
          <div id="wavesSubtitle" style="font-family:var(--font-body);font-size:11px;color:var(--t2);margin-top:3px">
            Les morceaux que tu as gardés depuis ton téléphone
          </div>
        </div>
        <div id="wavesAuthStatus" style="font-family:var(--font-body);font-size:10px;color:var(--t3)"></div>
      </div>
      <div id="wavesFilters" style="
        padding:8px 22px;border-bottom:.5px solid var(--ln);
        display:flex;gap:6px;align-items:center;
      ">
        <button class="wv-filter on" data-filter="all" onclick="WT.waves.setFilter('all')">Tous</button>
        <button class="wv-filter" data-filter="liked" onclick="WT.waves.setFilter('liked')">⭐ Aimés</button>
        <button class="wv-filter" data-filter="saved_for_later" onclick="WT.waves.setFilter('saved_for_later')">À écouter</button>
        <button class="wv-filter" data-filter="commented" onclick="WT.waves.setFilter('commented')">Commentés</button>
        <button class="wv-filter" data-filter="reshared" onclick="WT.waves.setFilter('reshared')">Partagés</button>
      </div>
      <div id="wavesList" style="flex:1;overflow-y:auto;padding:8px 14px"></div>
    `;

    const libView = document.getElementById('libView');
    if (libView && libView.parentNode) {
      libView.parentNode.insertBefore(view, libView.nextSibling);
    } else {
      document.body.appendChild(view);
    }

    const style = document.createElement('style');
    style.textContent = `
      .wv-filter {
        font-family: var(--font-body);
        font-size: 11px;
        padding: 5px 12px;
        background: transparent;
        border: .5px solid var(--bg3);
        border-radius: 999px;
        color: var(--t2);
        cursor: pointer;
        transition: all .15s;
      }
      .wv-filter:hover { color: var(--t1); }
      .wv-filter.on {
        background: var(--acc);
        border-color: var(--acc);
        color: #fff;
      }
      .wv-row {
        display: flex; align-items: center; gap: 12px;
        padding: 10px 8px; border-radius: 8px;
        transition: background .1s;
      }
      .wv-row:hover { background: var(--bg2); }
      .wv-art {
        width: 44px; height: 44px; border-radius: 4px;
        background: var(--bg3); flex-shrink: 0;
        background-size: cover; background-position: center;
        display: flex; align-items: center; justify-content: center;
        color: var(--t3); font-size: 16px;
      }
      .wv-info { flex: 1; min-width: 0; }
      .wv-title { font-family: var(--font-body); font-size: 13px; color: var(--t1); margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .wv-artist { font-family: var(--font-body); font-size: 11px; color: var(--t3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .wv-tags { display: flex; gap: 4px; margin-top: 4px; flex-wrap: wrap; }
      .wv-tag {
        font-family: var(--font-title); font-size: 8px; letter-spacing: .05em;
        padding: 2px 6px; border-radius: 3px; text-transform: uppercase;
      }
      .wv-tag.saved { background: rgba(160,160,160,.12); color: var(--t2); }
      .wv-tag.commented { background: rgba(200,90,69,.18); color: var(--acc); }
      .wv-tag.reshared { background: rgba(80,150,200,.15); color: #6FA8C8; }
      .wv-tag.local { background: rgba(80,180,120,.15); color: #6FB890; }
      .wv-tag.liked { background: rgba(230,180,60,.15); color: #E6B43C; }
      .wv-actions { display: flex; gap: 4px; opacity: 0; transition: opacity .1s; }
      .wv-row:hover .wv-actions { opacity: 1; }
      .wv-btn {
        background: transparent; border: .5px solid var(--bg3);
        border-radius: 4px; padding: 6px 10px;
        font-family: var(--font-body); font-size: 10px;
        color: var(--t2); cursor: pointer; transition: all .15s;
      }
      .wv-btn:hover { color: var(--t1); border-color: var(--t3); }
      .wv-btn.danger:hover { color: #E15B4F; border-color: #E15B4F; }
      .wv-empty {
        text-align: center; padding: 60px 20px; color: var(--t3);
        font-family: var(--font-body); font-size: 12px; line-height: 1.6;
      }
      .wv-ressenti {
        margin-top: 8px; padding: 8px 10px;
        background: rgba(200,90,69,.06); border-left: 2px solid var(--acc);
        border-radius: 0 4px 4px 0;
        font-family: var(--font-body); font-size: 11px; color: var(--t2);
        line-height: 1.5;
      }

      /* ── Bouton "Connexion téléphone" dans la sidebar ── */
      .sb-phone-row {
        margin: 4px 14px 8px;
        padding: 8px 10px;
        background: var(--bg2);
        border: .5px solid var(--bg3);
        border-radius: 6px;
        display: flex; align-items: center; gap: 8px;
        cursor: pointer;
        transition: all .15s;
      }
      .sb-phone-row:hover { border-color: var(--t3); }
      .sb-phone-dot {
        width: 7px; height: 7px; border-radius: 50%;
        background: #6E6E6E;
        flex-shrink: 0;
      }
      .sb-phone-dot.on { background: #3DB37F; box-shadow: 0 0 6px rgba(61,179,127,.5); }
      .sb-phone-label {
        font-family: var(--font-body); font-size: 11px;
        color: var(--t2); flex: 1;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .sb-phone-action {
        font-family: var(--font-body); font-size: 10px;
        color: var(--t3);
      }
      .sb-phone-row:hover .sb-phone-action { color: var(--acc); }
    `;
    document.head.appendChild(style);
  }

  // ── Sidebar : Reçu de tes ondes + bouton Téléphone ──────────────────

  function injectSidebarEntries() {
    const syncItem = document.getElementById('si-sync');
    if (!syncItem) return;

    // 1. "Reçu de tes ondes"
    if (!document.getElementById('si-waves')) {
      const item = document.createElement('div');
      item.className = 'sb-item';
      item.id = 'si-waves';
      item.onclick = () => show();
      item.innerHTML = `
        <span class="sb-item-ic">📡</span>
        Reçu de tes ondes
        <span id="si-waves-count" class="sb-item-ct" style="margin-left:auto;font-size:10px;color:var(--t3)"></span>
      `;
      syncItem.parentNode.insertBefore(item, syncItem.nextSibling);
    }

    // 2. Bouton téléphone — sous "Reçu de tes ondes"
    if (!document.getElementById('sbPhoneRow')) {
      const phoneRow = document.createElement('div');
      phoneRow.id = 'sbPhoneRow';
      phoneRow.className = 'sb-phone-row';
      phoneRow.onclick = () => window.WT?.pair?.open?.();
      phoneRow.innerHTML = `
        <div class="sb-phone-dot" id="sbPhoneDot"></div>
        <div class="sb-phone-label" id="sbPhoneLabel">Téléphone non connecté</div>
        <div class="sb-phone-action" id="sbPhoneAction">Connecter →</div>
      `;
      const wavesItem = document.getElementById('si-waves');
      if (wavesItem) wavesItem.parentNode.insertBefore(phoneRow, wavesItem.nextSibling);
    }

    updatePhoneBadge();
  }

  function updatePhoneBadge() {
    const dot = document.getElementById('sbPhoneDot');
    const label = document.getElementById('sbPhoneLabel');
    const action = document.getElementById('sbPhoneAction');
    if (!dot) return;

    const user = window.WT?.user;
    if (user) {
      dot.classList.add('on');
      label.textContent = user.email || `Connecté · ${user.uid.slice(0, 8)}`;
      action.textContent = 'Gérer →';
    } else {
      dot.classList.remove('on');
      label.textContent = 'Téléphone non connecté';
      action.textContent = 'Connecter →';
    }
  }

  // ── Suppression du bouton dans la titlebar (si présent) ─────────────

  function removeTitlebarPhoneButton() {
    // Cherche n'importe quel bouton qui appelle WT.pair.open() dans la titlebar
    // pour le retirer (puisqu'on l'a déplacé dans la sidebar)
    document.querySelectorAll('button').forEach(btn => {
      const onclick = btn.getAttribute('onclick') || '';
      if (onclick.includes('WT.pair.open') && !btn.closest('.sb-phone-row')) {
        // Laisser tel quel s'il est dans une autre vue, mais pas dans la titlebar
        const parent = btn.closest('[class*="titlebar"], [class*="tb-"]');
        if (parent || btn.style.position === 'fixed') {
          btn.style.display = 'none';
        }
      }
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  function fmtDate(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const now = new Date();
    const diffH = (now - d) / 3600_000;
    if (diffH < 24) return 'aujourd\'hui';
    if (diffH < 48) return 'hier';
    if (diffH < 24 * 7) return `il y a ${Math.floor(diffH / 24)} jours`;
    return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  }

  function findLocalMatch(title, artist) {
    if (!window.allTracks || !Array.isArray(window.allTracks)) return null;
    const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    const tNorm = norm(title), aNorm = norm(artist);
    return window.allTracks.find(t => norm(t.title) === tNorm && norm(t.artist) === aNorm) || null;
  }

  // ── Firestore listener ──────────────────────────────────────────────

  function startListener() {
    if (!window.WT?.firebase || !window.WT.user) return;
    const { db, collection, query, orderBy, onSnapshot } = window.WT.firebase;
    const uid = window.WT.user.uid;

    if (unsubHistory) unsubHistory();

    const q = query(
      collection(db, 'users', uid, 'history'),
      orderBy('lastInteractionAt', 'desc')
    );
    unsubHistory = onSnapshot(q, snap => {
      entries = snap.docs.map(d => {
        const data = d.data();
        const tsToMs = v => v?.toMillis?.() || (typeof v === 'number' ? v : Date.now());
        return {
          id: d.id,
          title: data.title || '',
          artist: data.artist || '',
          albumArtUrl: data.albumArtUrl || '',
          firstSavedAt: tsToMs(data.firstSavedAt),
          lastInteractionAt: tsToMs(data.lastInteractionAt),
          reasons: data.reasons || [],
          emitterPseudos: data.emitterPseudos || [],
          reshareCount: data.reshareCount || 0,
          ressenti: data.ressenti ? {
            ...data.ressenti,
            sentAt: tsToMs(data.ressenti.sentAt),
          } : null,
        };
      });
      render();
    }, err => {
      console.warn('[waves] firestore listen error:', err);
    });
  }

  function stopListener() {
    if (unsubHistory) { unsubHistory(); unsubHistory = null; }
    entries = [];
  }

  // ── Render ──────────────────────────────────────────────────────────

  function render() {
    updatePhoneBadge();

    const list = document.getElementById('wavesList');
    const sub = document.getElementById('wavesSubtitle');
    const auth = document.getElementById('wavesAuthStatus');
    const count = document.getElementById('si-waves-count');
    if (!list) return;

    const user = window.WT?.user;
    if (!user) {
      list.innerHTML = `
        <div class="wv-empty">
          Connecte ton téléphone pour voir tes ondes ici.<br>
          <span style="color:var(--acc)">Bouton "Connecter" sous "Reçu de tes ondes" à gauche.</span>
        </div>
      `;
      if (auth) auth.textContent = 'Non connecté';
      if (count) count.textContent = '';
      return;
    }

    if (auth) auth.textContent = user.email || `Compte ${user.uid.slice(0, 8)}`;

    let filtered = entries;
    if (activeFilter !== 'all') {
      filtered = entries.filter(e => e.reasons.includes(activeFilter));
    }
    if (count) count.textContent = entries.length > 0 ? `${entries.length}` : '';

    if (filtered.length === 0) {
      list.innerHTML = `
        <div class="wv-empty">
          ${entries.length === 0
            ? 'Aucun morceau gardé pour l\'instant.<br>Ouvre Wave Tune sur ton téléphone, écoute une onde près de toi, et garde ce qui te plaît.'
            : 'Rien dans cette catégorie.'}
        </div>
      `;
      if (sub) sub.textContent = entries.length === 0 ? 'Les morceaux que tu as gardés depuis ton téléphone' : `0 dans cette catégorie · ${entries.length} au total`;
      return;
    }

    if (sub) sub.textContent = `${filtered.length} morceau${filtered.length > 1 ? 'x' : ''}${activeFilter === 'all' ? '' : ` · ${entries.length} au total`}`;

    list.innerHTML = filtered.map(e => renderRow(e)).join('');
  }

  function renderRow(e) {
    const localMatch = findLocalMatch(e.title, e.artist);
    const tags = [];
    if (e.reasons.includes('liked')) tags.push('<span class="wv-tag liked">⭐ Aimé</span>');
    if (e.reasons.includes('saved_for_later')) tags.push('<span class="wv-tag saved">À écouter</span>');
    if (e.reasons.includes('commented')) tags.push('<span class="wv-tag commented">Commenté</span>');
    if (e.reasons.includes('reshared')) tags.push(`<span class="wv-tag reshared">Partagé${e.reshareCount > 1 ? ` ${e.reshareCount}×` : ''}</span>`);
    if (localMatch) tags.push('<span class="wv-tag local">Dans la biblio</span>');

    const fromLine = e.emitterPseudos.length > 0
      ? `de ${e.emitterPseudos.slice(0, 2).join(', ')}${e.emitterPseudos.length > 2 ? ` +${e.emitterPseudos.length - 2}` : ''} · `
      : '';

    const ressentiHtml = e.ressenti?.message
      ? `<div class="wv-ressenti">"${escapeHtml(e.ressenti.message)}"</div>`
      : '';

    const artHtml = e.albumArtUrl
      ? `<div class="wv-art" style="background-image:url('${escapeAttr(e.albumArtUrl)}')"></div>`
      : `<div class="wv-art">♪</div>`;

    return `
      <div class="wv-row" data-id="${e.id}">
        ${artHtml}
        <div class="wv-info">
          <div class="wv-title">${escapeHtml(e.title)}</div>
          <div class="wv-artist">${escapeHtml(e.artist)}${e.artist ? ' · ' : ''}<span style="color:var(--t3)">${fromLine}${fmtDate(e.lastInteractionAt)}</span></div>
          <div class="wv-tags">${tags.join('')}</div>
          ${ressentiHtml}
        </div>
        <div class="wv-actions">
          <button class="wv-btn" onclick="WT.waves.preview('${escapeAttr(e.id)}')" title="Écouter un extrait">▶ Preview</button>
          <button class="wv-btn" onclick="WT.waves.openYouTube('${escapeAttr(e.id)}')" title="Ouvrir sur YouTube">YouTube</button>
          ${localMatch ? `<button class="wv-btn" onclick="WT.waves.playLocal('${escapeAttr(e.id)}')" title="Lire depuis ta biblio">Lire</button>` : ''}
          <button class="wv-btn danger" onclick="WT.waves.discard('${escapeAttr(e.id)}')" title="Retirer de la liste">✕</button>
        </div>
      </div>
    `;
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function escapeAttr(s) {
    return String(s || '').replace(/'/g, '\\\'').replace(/"/g, '&quot;');
  }

  // ── Actions ─────────────────────────────────────────────────────────

  async function preview(id) {
    const e = entries.find(x => x.id === id);
    if (!e) return;
    try {
      const q = encodeURIComponent(`${e.title} ${e.artist}`);
      const res = await fetch(`https://itunes.apple.com/search?term=${q}&entity=song&limit=1`);
      const data = await res.json();
      const previewUrl = data?.results?.[0]?.previewUrl;
      if (!previewUrl) {
        toast('Aucun extrait disponible');
        return;
      }
      if (previewAudio) { previewAudio.pause(); previewAudio = null; }
      previewAudio = new Audio(previewUrl);
      previewAudio.volume = 0.85;
      previewAudio.play().catch(err => console.warn('[waves] preview play error:', err));
      toast(`▶ Aperçu : ${e.title}`);
    } catch (err) {
      console.warn('[waves] preview fetch error:', err);
      toast('Erreur de récupération');
    }
  }

  function openYouTube(id) {
    const e = entries.find(x => x.id === id);
    if (!e) return;
    const q = encodeURIComponent(`${e.artist} ${e.title}`);
    const url = `https://www.youtube.com/results?search_query=${q}`;
    if (window.wt?.openExternal) window.wt.openExternal(url);
    else window.open(url, '_blank');
  }

  function playLocal(id) {
    const e = entries.find(x => x.id === id);
    if (!e) return;
    const match = findLocalMatch(e.title, e.artist);
    if (!match) { toast('Pas dans ta bibliothèque'); return; }
    if (typeof window.playTrack === 'function') {
      window.playTrack(match);
    } else if (typeof window.queue !== 'undefined' && typeof window.playByPath === 'function') {
      window.playByPath(match.path);
    } else {
      toast('Lecture indisponible');
    }
  }

  async function discard(id) {
    const e = entries.find(x => x.id === id);
    if (!e) return;
    const ok = confirm(
      e.reasons.includes('commented') || e.reasons.includes('reshared')
        ? `Tu as commenté ou partagé "${e.title}". Vraiment supprimer ?`
        : `Retirer "${e.title}" de tes ondes ?`
    );
    if (!ok) return;

    const { db, deleteDoc, doc } = window.WT.firebase;
    try {
      await deleteDoc(doc(db, 'users', window.WT.user.uid, 'history', e.id));
      toast('✓ Retiré');
    } catch (err) {
      console.warn('[waves] discard error:', err);
      toast('Erreur de suppression');
    }
  }

  function setFilter(f) {
    activeFilter = f;
    document.querySelectorAll('.wv-filter').forEach(el => {
      el.classList.toggle('on', el.dataset.filter === f);
    });
    render();
  }

  // ── Show / hide ─────────────────────────────────────────────────────

  function show() {
    ensureViewExists();
    applyViewPatches();

    // Toggle : si déjà visible et qu'il y a un autre panneau, on ferme
    if (isWavesVisible() && visibleCount() > 1) {
      hideWaves();
      return;
    }

    // Sinon on l'affiche (sans toucher aux autres panneaux)
    const welcome = document.getElementById('welcome');
    if (welcome) welcome.style.display = 'none';

    const wavesView = document.getElementById('wavesView');
    if (wavesView) wavesView.style.display = 'flex';
    document.getElementById('si-waves')?.classList.add('on');
    viewActive = true;

    if (!unsubHistory && window.WT?.user) startListener();
    render();
  }

  function hide() {
    const v = document.getElementById('wavesView');
    if (v) v.style.display = 'none';
    document.getElementById('si-waves')?.classList.remove('on');
    viewActive = false;
  }

  function toast(msg) {
    if (typeof window.toast === 'function') window.toast(msg);
    else console.log('[waves toast]', msg);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  function bootstrap() {
    ensureViewExists();
    injectSidebarEntries();
    applyViewPatches();
    removeTitlebarPhoneButton();
    if (window.WT?.user) startListener();
  }

  document.addEventListener('wt:firebase-ready', bootstrap);

  document.addEventListener('wt:auth-changed', () => {
    updatePhoneBadge();
    if (window.WT?.user) {
      startListener();
    } else {
      stopListener();
      render();
    }
  });

  // Fallback : si Firebase est déjà prêt au moment où le script charge
  if (window.WT?.firebase) {
    bootstrap();
  } else {
    // Try after DOM ready, in case the events fired before we registered
    if (document.readyState !== 'loading') {
      setTimeout(() => { if (window.WT?.firebase) bootstrap(); }, 100);
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => { if (window.WT?.firebase) bootstrap(); }, 100);
      });
    }
  }

  // ── API publique ────────────────────────────────────────────────────
  window.WT = window.WT || {};
  window.WT.waves = {
    show, hide, setFilter,
    preview, openYouTube, playLocal, discard,
  };
})();
