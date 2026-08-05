// src/cover-cache.js
// Wave Tune Desktop — Cache disque persistant des pochettes.
//
// À utiliser depuis main.js. Expose 4 IPC handlers :
//   - cover-cache:get-index → renvoie le mapping {key: filePath} complet
//   - cover-cache:store     → télécharge l'URL et sauve les bytes sur disque
//   - cover-cache:clear     → vide tout le cache
//   - cover-cache:stats     → taille totale et nombre d'entrées
//
// Stockage :
//   - index.json    → {key: relativeFilePath}
//   - files/<hash>  → bytes des pochettes

const { ipcMain, app } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const CACHE_DIR_NAME = 'cover-cache';
const INDEX_FILE = 'index.json';
const FILES_DIR = 'files';

let cacheDir = null;
let filesDir = null;
let indexPath = null;
let index = {};
let saveTimer = null;

function ensureDirs() {
  if (!cacheDir) {
    cacheDir = path.join(app.getPath('userData'), CACHE_DIR_NAME);
    filesDir = path.join(cacheDir, FILES_DIR);
    indexPath = path.join(cacheDir, INDEX_FILE);
  }
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });
}

function loadIndex() {
  ensureDirs();
  try {
    if (fs.existsSync(indexPath)) {
      const raw = fs.readFileSync(indexPath, 'utf8');
      index = JSON.parse(raw);

      // Sanity check : on retire les entrées dont le fichier a disparu
      const validKeys = Object.keys(index).filter(k => {
        const fp = path.join(cacheDir, index[k]);
        return fs.existsSync(fp);
      });
      const cleaned = {};
      for (const k of validKeys) cleaned[k] = index[k];
      if (validKeys.length !== Object.keys(index).length) {
        console.log('[cover-cache] cleaned', Object.keys(index).length - validKeys.length, 'orphan entries');
        index = cleaned;
        scheduleSave();
      }
    }
  } catch (e) {
    console.warn('[cover-cache] load failed, starting fresh:', e.message);
    index = {};
  }
  console.log('[cover-cache] loaded', Object.keys(index).length, 'cached entries');
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await fsp.writeFile(indexPath, JSON.stringify(index, null, 2), 'utf8');
    } catch (e) {
      console.warn('[cover-cache] save failed:', e.message);
    }
  }, 1000);
}

function hashKey(key) {
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
}

function downloadToFile(url, filePath) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: 20000 }, res => {
      // Suivre les redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.destroy();
        return downloadToFile(res.headers.location, filePath).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.destroy();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const fileStream = fs.createWriteStream(filePath);
      res.pipe(fileStream);
      fileStream.on('finish', () => fileStream.close(() => resolve()));
      fileStream.on('error', err => {
        fs.unlink(filePath, () => {});
        reject(err);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function getExtensionFromUrl(url) {
  try {
    const u = new URL(url);
    const ext = path.extname(u.pathname).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return ext;
  } catch (_) {}
  return '.jpg';
}

function setupCoverCache() {
  loadIndex();

  // GET INDEX — renvoie le mapping complet sous forme de URLs file://
  ipcMain.handle('cover-cache:get-index', async () => {
    ensureDirs();
    const result = {};
    for (const [key, relativePath] of Object.entries(index)) {
      const fullPath = path.join(cacheDir, relativePath);
      // Encode en URL file:// que le renderer peut directement utiliser comme img.src
      result[key] = `file://${fullPath}`;
    }
    return result;
  });

  // STORE — télécharge l'URL et la stocke sous la clé donnée
  ipcMain.handle('cover-cache:store', async (_evt, { key, url }) => {
    if (!key || !url) return null;
    ensureDirs();

    // Si déjà cachée, retourne directement
    if (index[key]) {
      const existingPath = path.join(cacheDir, index[key]);
      if (fs.existsSync(existingPath)) {
        return `file://${existingPath}`;
      }
    }

    const hash = hashKey(key);
    const ext = getExtensionFromUrl(url);
    const relativePath = path.join(FILES_DIR, hash + ext);
    const fullPath = path.join(cacheDir, relativePath);

    try {
      await downloadToFile(url, fullPath);
      index[key] = relativePath;
      scheduleSave();
      return `file://${fullPath}`;
    } catch (e) {
      console.warn('[cover-cache] download failed:', key, e.message);
      // Nettoie un fichier partiel si présent
      try { if (fs.existsSync(fullPath)) await fsp.unlink(fullPath); } catch (_) {}
      return null;
    }
  });

  // CLEAR — vide tout
  ipcMain.handle('cover-cache:clear', async () => {
    ensureDirs();
    try {
      // Supprime tous les fichiers du dossier files/
      const entries = await fsp.readdir(filesDir);
      await Promise.all(entries.map(e => fsp.unlink(path.join(filesDir, e)).catch(() => {})));
      index = {};
      await fsp.writeFile(indexPath, '{}', 'utf8');
      console.log('[cover-cache] cleared');
      return { ok: true, cleared: entries.length };
    } catch (e) {
      console.warn('[cover-cache] clear failed:', e.message);
      return { ok: false, error: e.message };
    }
  });

  // STATS — taille totale + nombre d'entrées
  ipcMain.handle('cover-cache:stats', async () => {
    ensureDirs();
    let totalBytes = 0;
    try {
      const entries = await fsp.readdir(filesDir);
      for (const e of entries) {
        try {
          const stat = await fsp.stat(path.join(filesDir, e));
          totalBytes += stat.size;
        } catch (_) {}
      }
    } catch (_) {}
    return {
      entries: Object.keys(index).length,
      bytes: totalBytes,
      mb: Math.round((totalBytes / 1024 / 1024) * 10) / 10,
      path: cacheDir,
    };
  });

  console.log('[cover-cache] IPC handlers registered');
}

module.exports = { setupCoverCache };
