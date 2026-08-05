// src/cover-cache-renderer.js
// Wave Tune Desktop — Intégration côté renderer du cache disque persistant.
//
// Ce script se branche AU DESSUS du throttle d'images (qui doit être chargé avant).
// Pour chaque assignation d'img.src vers une URL throttled (mzstatic, dzcdn, etc.),
// on :
//   1. Calcule une clé canonique pour la pochette (basée sur l'URL elle-même)
//   2. Si la clé est dans le cache disque → on remplace par file:// (instantané)
//   3. Sinon → on laisse passer la requête normalement, ET on demande au main
//      process de la télécharger en parallèle pour la prochaine fois.

(function() {
  if (!window.wt) {
    console.warn('[cover-cache-renderer] window.wt not available — cannot init');
    return;
  }

  // Méthodes IPC qu'on rajoute (sera connecté au preload, voir patch)
  // Pour l'instant on les appelle via wt directement.
  const ipc = {
    getIndex: () => window.wt.coverCacheGetIndex?.(),
    store: (key, url) => window.wt.coverCacheStore?.(key, url),
    clear: () => window.wt.coverCacheClear?.(),
    stats: () => window.wt.coverCacheStats?.(),
  };

  if (!ipc.getIndex || !ipc.store) {
    console.warn('[cover-cache-renderer] IPC methods not in preload — cache disabled');
    return;
  }

  // ── État ─────────────────────────────────────────────────────────────
  let memIndex = {};         // clé canonique → URL file:// (ou URL HTTP en attendant le DL)
  let initialized = false;
  const pendingStores = new Set();  // clés en cours de download pour éviter les doublons

  // Génère une clé canonique pour cacher une URL.
  // Idée : on utilise l'URL "normalisée" comme clé. Ça permet à des URLs identiques
  // de hit le cache même si elles arrivent depuis différents endroits.
  function urlToKey(url) {
    if (!url) return null;
    // Pour mzstatic, normalise la résolution (toutes les tailles → même clé)
    let canonical = url;
    canonical = canonical.replace(/\/\d+x\d+bb\./, '/600x600bb.');
    return canonical;
  }

  // ── Init : charge l'index disque au démarrage ────────────────────────
  async function init() {
    try {
      memIndex = await ipc.getIndex() || {};
      initialized = true;
      console.log('[cover-cache-renderer] loaded', Object.keys(memIndex).length, 'entries from disk');
    } catch (e) {
      console.warn('[cover-cache-renderer] init failed:', e);
      initialized = true;   // on continue sans cache disque
    }
  }
  init();

  // ── Patch HTMLImageElement.src ───────────────────────────────────────
  const originalSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  if (!originalSrcDescriptor || !originalSrcDescriptor.set) {
    console.warn('[cover-cache-renderer] cannot patch img.src');
    return;
  }

  // On vérifie que le throttle a déjà patché — son setter sera notre nouveau "originalSrc"
  // (il fera le throttling après nous, si l'URL n'est pas dans le cache disque)
  const previousSetter = originalSrcDescriptor.set;

  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    get() { return originalSrcDescriptor.get.call(this); },
    set(value) {
      if (!value || typeof value !== 'string' || !initialized) {
        return previousSetter.call(this, value);
      }

      // On ne s'occupe que des URLs CDN distantes (pas des file://, data:, blob:)
      const isRemote = value.startsWith('http://') || value.startsWith('https://');
      if (!isRemote) return previousSetter.call(this, value);

      const key = urlToKey(value);
      const cached = memIndex[key];

      if (cached) {
        // Cache hit → utilise le file:// directement, instantané, zéro réseau
        return previousSetter.call(this, cached);
      }

      // Cache miss → on laisse l'URL distante passer (throttle + Chrome cache HTTP)
      previousSetter.call(this, value);

      // ET on demande au main process de stocker pour la prochaine fois
      // Évite les doublons si la même URL est demandée plusieurs fois rapidement
      if (!pendingStores.has(key)) {
        pendingStores.add(key);
        ipc.store(key, value).then(localUrl => {
          pendingStores.delete(key);
          if (localUrl) {
            memIndex[key] = localUrl;
          }
        }).catch(err => {
          pendingStores.delete(key);
          console.warn('[cover-cache-renderer] store failed:', err);
        });
      }
    },
    configurable: true,
  });

  // ── Stats helper accessible depuis la console ───────────────────────
  window.__coverCache = {
    get entries() { return Object.keys(memIndex).length; },
    get pending() { return pendingStores.size; },
    stats: () => ipc.stats(),
    clear: async () => {
      const r = await ipc.clear();
      memIndex = {};
      return r;
    },
    reload: async () => {
      memIndex = await ipc.getIndex() || {};
      return Object.keys(memIndex).length;
    },
  };

  console.log('[cover-cache-renderer] active');
})();
