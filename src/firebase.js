import { initializeApp } from 'firebase/app';
import { getAuth as createAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

let app;
let auth;
let db;

const env = (key) => {
  const value = process.env[key];
  return typeof value === 'string' ? value.trim() : '';
};

export function getFirebaseConfig() {
  return {
    apiKey: env('REACT_APP_FIREBASE_API_KEY'),
    authDomain: env('REACT_APP_FIREBASE_AUTH_DOMAIN'),
    projectId: env('REACT_APP_FIREBASE_PROJECT_ID'),
    storageBucket: env('REACT_APP_FIREBASE_STORAGE_BUCKET'),
    messagingSenderId: env('REACT_APP_FIREBASE_MESSAGING_SENDER_ID'),
    appId: env('REACT_APP_FIREBASE_APP_ID'),
    measurementId: env('REACT_APP_FIREBASE_MEASUREMENT_ID'),
  };
}

export function isFirebaseConfigured() {
  const { apiKey, projectId, appId } = getFirebaseConfig();
  return Boolean(apiKey && projectId && appId);
}

export function initFirebase() {
  if (app) return { app, auth, db };

  if (!isFirebaseConfigured()) {
    throw new Error(
      'Firebase is not configured. Copy .env.example to .env, add your web app keys from the Firebase console, then restart the dev server (npm start).'
    );
  }

  app = initializeApp(getFirebaseConfig());
  auth = createAuth(app);
  db = getFirestore(app);
  return { app, auth, db };
}

export function getAuth() {
  return initFirebase().auth;
}

export function getDb() {
  return initFirebase().db;
}
