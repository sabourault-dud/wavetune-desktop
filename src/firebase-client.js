// src/firebase-client.js
// Wave Tune Desktop — Firebase initialization (renderer side)
//
// Charge le SDK web Firebase, initialise auth + firestore.
// Restaure la session depuis le disque local (electron-store style, mais
// on garde simple ici avec localStorage que Firebase web SDK utilise déjà
// en interne via IndexedDB).

(function() {
  // Note : on charge les SDK depuis le CDN gstatic — pas besoin de bundler.
  // Versions épinglées pour stabilité. Update ici quand on veut bumper.
  const SDK_VERSION = '12.11.0';

  const firebaseConfig = {
    apiKey: "AIzaSyDkKetyxBPv0E5g8Oe9NAh-aHuNajJ_keY",
    authDomain: "charis-46833.firebaseapp.com",
    projectId: "charis-46833",
    storageBucket: "charis-46833.firebasestorage.app",
    messagingSenderId: "900257838534",
    appId: "1:900257838534:web:6463f504807c9e99efeec7",
    databaseURL: "https://charis-46833-default-rtdb.europe-west1.firebasedatabase.app"
  };

  // Charge le SDK Firebase de façon dynamique (ESM imports)
  // On expose tout sur window.WT pour que les autres scripts du renderer accèdent
  // à auth/db sans avoir à re-importer.
  async function loadFirebase() {
    const [
      { initializeApp },
      { getAuth, signInWithCustomToken, onAuthStateChanged, signOut },
      { getFirestore, doc, getDoc, getDocs, setDoc, deleteDoc, collection, query, orderBy, onSnapshot, Timestamp },
    ] = await Promise.all([
      import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-app.js`),
      import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-auth.js`),
      import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-firestore.js`),
    ]);

    const app = initializeApp(firebaseConfig);
    const auth = getAuth(app);
    const db = getFirestore(app);

    // Expose tout sur window.WT pour les autres modules renderer
    window.WT = window.WT || {};
    window.WT.firebase = {
      app, auth, db,
      signInWithCustomToken,
      onAuthStateChanged,
      signOut,
      doc, getDoc, getDocs, setDoc, deleteDoc,
      collection, query, orderBy, onSnapshot,
      Timestamp,
    };

    // Surveille l'état d'auth, met à jour l'UI globale
    onAuthStateChanged(auth, async (user) => {
      window.WT.user = user || null;
      document.dispatchEvent(new CustomEvent('wt:auth-changed', {
        detail: { user: user ? { uid: user.uid, email: user.email } : null }
      }));
      console.log('[firebase-client] auth state:', user ? `signed in as ${user.uid}` : 'signed out');

      // ── Enregistre la présence du desktop pour que le mobile sache ────
      if (user) {
        try {
          const { doc, setDoc, Timestamp } = window.WT.firebase;
          await setDoc(
            doc(db, 'users', user.uid, 'devices', 'desktop'),
            {
              type: 'desktop',
              platform: navigator.platform || 'Mac',
              lastSeen: Timestamp.now(),
            },
            { merge: true }
          );
          console.log('[firebase-client] desktop device registered');
        } catch (e) {
          console.warn('[firebase-client] device register failed:', e);
        }
      }
    });

    document.dispatchEvent(new CustomEvent('wt:firebase-ready'));
    console.log('[firebase-client] initialized');
  }

  loadFirebase().catch(err => {
    console.error('[firebase-client] init failed:', err);
  });
})();
