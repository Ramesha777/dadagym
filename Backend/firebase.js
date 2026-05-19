/**
 * Shared web client config (mirrored in frontend/js/gym-app.js and frontend/js/dashboard.js).
 * Deploy security rules from repo root: firebase deploy --only firestore:rules,storage
 * Enable Auth (Email/Password), Firestore, and Storage in the Firebase console.
 */
export const firebaseConfig = {
  apiKey: "AIzaSyBe5Vjg1MV8WYFyRZB21KZxxXj2LseScu8",
  authDomain: "gymdada-9b977.firebaseapp.com",
  databaseURL: "https://gymdada-9b977-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "gymdada-9b977",
  storageBucket: "gymdada-9b977.firebasestorage.app",
  messagingSenderId: "399189575955",
  appId: "1:399189575955:web:348d8a86e284e28b5032e6"
};
