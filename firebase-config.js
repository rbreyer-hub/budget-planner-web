/*
  SETUP INSTRUCTIONS
  ─────────────────────────────────────────────────────────────────
  1. Go to https://console.firebase.google.com/ and create a project.

  2. Enable Google sign-in:
       Authentication → Sign-in method → Google → Enable
       Add your authorized domain (e.g. rbreyer-hub.github.io) under
       Authentication → Settings → Authorized domains.

  3. Create a Firestore database:
       Firestore Database → Create database → Start in production mode
       Choose a region (us-central1 is fine).

  4. Set Firestore security rules (Firestore → Rules tab):

       rules_version = '2';
       service cloud.firestore {
         match /databases/{database}/documents {
           match /users/{userId}/{document=**} {
             allow read, write: if request.auth != null
                                && request.auth.uid == userId;
           }
         }
       }

  5. Register a Web app:
       Project settings (gear icon) → Your apps → Add app → Web
       Copy the config values into the object below.

  6. Replace every "YOUR_..." placeholder below, then redeploy.
  ─────────────────────────────────────────────────────────────────
*/

const firebaseConfig = {
  apiKey:            "AIzaSyDwagvEPiQDLre2k6rku_pkwyKcBOxBnwE",
  authDomain:        "budget-planner-fb.firebaseapp.com",
  projectId:         "budget-planner-fb",
  storageBucket:     "budget-planner-fb.firebasestorage.app",
  messagingSenderId: "682449918354",
  appId:             "1:682449918354:web:c132bcec3976ce1988094b",
  measurementId:     "G-T72R093NMS"
};

firebase.initializeApp(firebaseConfig);
