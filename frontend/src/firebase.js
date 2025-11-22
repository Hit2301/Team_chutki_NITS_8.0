// src/firebase.js
import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

// 🔹 Your Firebase Config (from Firebase console)
const firebaseConfig = {
  apiKey: "AIzaSyBpbyd3xtMQ6x2Jv78Tn_DwAHYvlcI37dI",
  authDomain: "hit-crop.firebaseapp.com",
  projectId: "hit-crop",
  storageBucket: "hit-crop.firebasestorage.app",
  messagingSenderId: "248979507713",
  appId: "1:248979507713:web:0c340605cd2fffc3d24e00"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Services
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const db = getFirestore(app);      // ✅ Add Firestore
export const storage = getStorage(app);
