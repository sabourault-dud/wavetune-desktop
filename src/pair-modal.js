// src/pair-modal.js
// Wave Tune Desktop — Modal d'appairage avec le téléphone
//
// Flow :
//   1. Bouton "Connexion téléphone" dans la titlebar (ajouté par patch app.html).
//   2. Clic → ouvre modal.
//   3. User saisit code 6 chiffres affiché sur son tél.
//   4. POST vers redeemPairingCode (no auth required, le code est la clé).
//   5. Reçoit customToken, signInWithCustomToken → desktop authentifié comme l'user du tél.
//   6. Modal affiche "✓ Connecté", se ferme automatiquement.
//
// Si déjà appairé : la modal montre l'email/uid de l'user, propose "Se déconnecter".

(function() {
  const REDEEM_PAIRING_URL = 'https://europe-west1-charis-46833.cloudfunctions.net/redeemPairingCode';

  // ── Insertion du DOM de la modal ─────────────────────────────────────
  function injectModal() {
    if (document.getElementById('pairOv')) return;     // déjà injecté
    const html = `
      <div class="ov" id="pairOv">
        <div class="modal" style="width:480px;max-height:520px">
          <div class="mh">
            <div>
              <div class="mt">Connexion téléphone</div>
              <div class="ms" id="pairStatus">–</div>
            </div>
            <button class="mx" onclick="WT.pair.close()">✕</button>
          </div>
          <div class="ml" id="pairBody" style="padding:24px"></div>
        </div>
      </div>
    `;
    const div = document.createElement('div');
    div.innerHTML = html;
    document.body.appendChild(div.firstElementChild);

    // Click en dehors → ferme
    document.getElementById('pairOv').addEventListener('click', e => {
      if (e.target.id === 'pairOv') close();
    });
  }

  // ── États ────────────────────────────────────────────────────────────
  let state = { kind: 'idle' };   // idle | input | loading | success | error
  let codeInput = '';

  // ── Rendu ────────────────────────────────────────────────────────────
  function render() {
    const body = document.getElementById('pairBody');
    const status = document.getElementById('pairStatus');
    const user = window.WT?.user;

    // Si déjà connecté : afficher état "déjà appairé"
    if (user && state.kind === 'idle') {
      status.textContent = 'Connecté';
      body.innerHTML = `
        <div style="text-align:center;padding:8px 0 12px">
          <div style="font-size:42px;color:#3DB37F;margin-bottom:14px">✓</div>
          <div style="font-family:var(--font-title);font-size:13px;color:var(--t1);margin-bottom:8px">
            Téléphone connecté
          </div>
          <div style="font-family:var(--font-body);font-size:11px;color:var(--t2);margin-bottom:18px;line-height:1.5">
            ${user.email ? user.email : 'Compte ' + user.uid.slice(0,8)}
          </div>
          <button class="mbtn" onclick="WT.pair.signOut()" style="font-size:10px;color:var(--t3)">
            Se déconnecter
          </button>
        </div>
      `;
      return;
    }

    if (state.kind === 'idle' || state.kind === 'input') {
      status.textContent = 'Saisis le code de ton téléphone';
      body.innerHTML = `
        <div style="text-align:center">
          <div style="font-family:var(--font-body);font-size:11px;color:var(--t2);margin-bottom:16px;line-height:1.5">
            Sur ton téléphone : <strong style="color:var(--t1)">Bibliothèque → Connecter mon ordinateur → J'ai déjà l'application</strong>.
            Wave Tune affichera un code à 6 chiffres.
          </div>
          <input
            id="pairCodeInput"
            type="text"
            inputmode="numeric"
            pattern="[0-9]*"
            maxlength="6"
            placeholder="000000"
            autocomplete="off"
            spellcheck="false"
            style="
              width:240px;
              font-family:var(--font-title);
              font-size:26px;
              letter-spacing:10px;
              text-align:center;
              padding:14px 8px 14px 22px;
              background:var(--bg2);
              border:.5px solid var(--bg3);
              border-radius:8px;
              color:var(--t1);
              margin-bottom:6px;
              outline:none;
            "
            value="${codeInput}"
          />
          <div id="pairError" style="font-family:var(--font-body);font-size:10px;color:#E15B4F;min-height:14px;margin-top:4px"></div>
          <button
            id="pairSubmit"
            class="mbtn ok"
            onclick="WT.pair.submit()"
            style="margin-top:14px;font-size:11px;padding:10px 22px"
            ${codeInput.length === 6 ? '' : 'disabled'}
          >
            Connecter →
          </button>
        </div>
      `;

      // Wire input
      const input = document.getElementById('pairCodeInput');
      input.focus();
      input.addEventListener('input', e => {
        const v = e.target.value.replace(/\D/g, '').slice(0, 6);
        e.target.value = v;
        codeInput = v;
        document.getElementById('pairSubmit').disabled = v.length !== 6;
        document.getElementById('pairError').textContent = '';
      });
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && codeInput.length === 6) {
          submit();
        }
      });
    }

    if (state.kind === 'loading') {
      status.textContent = 'Connexion en cours…';
      body.innerHTML = `
        <div style="text-align:center;padding:32px 0">
          <div style="font-family:var(--font-body);font-size:11px;color:var(--t2)">
            Vérification du code…
          </div>
        </div>
      `;
    }

    if (state.kind === 'success') {
      status.textContent = 'Connecté !';
      body.innerHTML = `
        <div style="text-align:center;padding:24px 0">
          <div style="font-size:48px;color:#3DB37F;margin-bottom:14px">✓</div>
          <div style="font-family:var(--font-title);font-size:14px;color:var(--t1);margin-bottom:8px">
            Téléphone connecté
          </div>
          <div style="font-family:var(--font-body);font-size:11px;color:var(--t2);line-height:1.5">
            Ton ordinateur est maintenant lié à ton compte Wave Tune.
          </div>
        </div>
      `;
    }

    if (state.kind === 'error') {
      status.textContent = 'Erreur';
      body.innerHTML = `
        <div style="text-align:center;padding:24px 0">
          <div style="font-family:var(--font-title);font-size:14px;color:var(--t1);margin-bottom:8px">
            Impossible de se connecter
          </div>
          <div style="font-family:var(--font-body);font-size:11px;color:var(--t2);line-height:1.5;margin-bottom:18px">
            ${state.message || 'Vérifie le code et réessaie.'}
          </div>
          <button
            class="mbtn ok"
            onclick="WT.pair.reset()"
            style="font-size:11px;padding:10px 22px"
          >
            Réessayer
          </button>
        </div>
      `;
    }
  }

  // ── Actions ──────────────────────────────────────────────────────────
  async function open() {
    injectModal();
    state = { kind: 'idle' };
    codeInput = '';
    render();
    document.getElementById('pairOv').classList.add('on');
  }

  function close() {
    const ov = document.getElementById('pairOv');
    if (ov) ov.classList.remove('on');
  }

  function reset() {
    state = { kind: 'idle' };
    codeInput = '';
    render();
  }

  async function submit() {
    if (codeInput.length !== 6) return;
    if (!window.WT?.firebase) {
      state = { kind: 'error', message: 'Firebase pas encore chargé. Réessaie dans quelques secondes.' };
      render();
      return;
    }

    state = { kind: 'loading' };
    render();

    try {
      const res = await fetch(REDEEM_PAIRING_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: { code: codeInput } }),
      });

      if (!res.ok) {
        const text = await res.text();
        let parsed;
        try { parsed = JSON.parse(text); } catch (_) {}
        const msg = parsed?.error?.message || text;
        let userMsg = 'Code invalide ou expiré.';
        if (msg && msg.includes('expired')) userMsg = 'Le code a expiré. Génère un nouveau code sur ton téléphone.';
        if (msg && msg.includes('exhausted')) userMsg = 'Trop de tentatives. Génère un nouveau code.';
        if (msg && msg.includes('not-found')) userMsg = 'Code inconnu ou déjà utilisé.';
        throw new Error(userMsg);
      }

      const json = await res.json();
      const { customToken, uid } = json.result;

      // Sign in
      const { auth, signInWithCustomToken } = window.WT.firebase;
      await signInWithCustomToken(auth, customToken);

      // Succès — affiche l'écran de validation puis ferme automatiquement
      state = { kind: 'success' };
      render();
      setTimeout(() => close(), 2400);
    } catch (e) {
      console.warn('[pair] redeem failed:', e);
      state = { kind: 'error', message: e.message || 'Erreur inconnue.' };
      render();
    }
  }

  async function doSignOut() {
    if (!window.WT?.firebase) return;
    const ok = confirm('Se déconnecter de ton compte Wave Tune ? Tu pourras te reconnecter avec un nouveau code.');
    if (!ok) return;
    await window.WT.firebase.signOut(window.WT.firebase.auth);
    state = { kind: 'idle' };
    codeInput = '';
    render();
  }

  // Re-render quand l'auth change (utile si l'user se signe sur un autre device,
  // ou si Firebase finit de restaurer la session après le boot)
  document.addEventListener('wt:auth-changed', () => {
    if (document.getElementById('pairOv')?.classList.contains('on')) {
      render();
    }
  });

  // ── API publique ─────────────────────────────────────────────────────
  window.WT = window.WT || {};
  window.WT.pair = {
    open, close, reset, submit,
    signOut: doSignOut,
  };
})();
