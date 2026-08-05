// src/image-throttle.js
// Wave Tune Desktop — Limiteur de chargement d'images pour les bibliothèques massives.
//
// Problème : avec une bibliothèque iTunes de 10k+ morceaux, l'app tente de
// charger toutes les pochettes en parallèle. Chrome a une limite de connexions
// simultanées par domaine et au-delà rejette tout avec ERR_INSUFFICIENT_RESOURCES,
// inondant la console et bloquant le thread principal.
//
// Solution : on intercepte les assignations d'`img.src` vers les CDN qui posent
// problème (mzstatic, dzcdn, coverartarchive) et on les met dans une queue avec
// au max N requêtes simultanées. Les autres URLs (data:, blob:, fichier local)
// passent normalement, sans queue.
//
// Effet : zéro requête perdue, console propre, drag-and-drop redevient fluide.

(function() {
  const MAX_CONCURRENT = 8;        // max 8 chargements simultanés
  const THROTTLED_HOSTS = [
    'mzstatic.com',
    'dzcdn.net',
    'coverartarchive.org',
    'theaudiodb.com',
  ];

  let active = 0;
  const queue = [];

  function shouldThrottle(url) {
    if (!url || typeof url !== 'string') return false;
    if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('file:')) return false;
    return THROTTLED_HOSTS.some(h => url.includes(h));
  }

  function pump() {
    while (active < MAX_CONCURRENT && queue.length > 0) {
      const job = queue.shift();
      active++;
      job();
    }
  }

  // Intercepte img.src = "..." pour les URL throttled
  const originalSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  if (!originalSrcDescriptor || !originalSrcDescriptor.set) {
    console.warn('[image-throttle] Cannot patch HTMLImageElement.src — feature unavailable');
    return;
  }

  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    get() { return originalSrcDescriptor.get.call(this); },
    set(value) {
      if (!shouldThrottle(value)) {
        // URL non concernée (data:, blob:, locale, etc.) → passage direct
        originalSrcDescriptor.set.call(this, value);
        return;
      }

      // URL throttled → on la met en queue
      const img = this;
      const job = () => {
        const onDone = () => {
          active--;
          img.removeEventListener('load', onDone);
          img.removeEventListener('error', onDone);
          // Yield to main thread before pumping next job — keeps UI responsive
          setTimeout(pump, 0);
        };
        img.addEventListener('load', onDone, { once: true });
        img.addEventListener('error', onDone, { once: true });
        originalSrcDescriptor.set.call(img, value);
      };

      queue.push(job);
      pump();
    },
    configurable: true,
  });

  // Stats utiles pour debug — accessible depuis la console
  window.__imageThrottle = {
    get active() { return active; },
    get queued() { return queue.length; },
    get max() { return MAX_CONCURRENT; },
  };

  console.log('[image-throttle] active — max', MAX_CONCURRENT, 'concurrent loads');
})();
