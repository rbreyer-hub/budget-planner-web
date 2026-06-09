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
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT_ID.firebaseapp.com",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "YOUR_APP_ID"
};

firebase.initializeApp(firebaseConfig);
