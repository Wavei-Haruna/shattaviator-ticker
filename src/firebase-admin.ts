import { initializeApp, cert, getApps } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

// Set these three as Railway env vars for this service — same values
// you're already using in the Vercel Firebase Admin SDK setup.
// FIREBASE_PRIVATE_KEY will have literal "\n" sequences if pasted from a
// .env file; the .replace() below turns them back into real newlines.
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  })
}

export const adminDb = getFirestore()
