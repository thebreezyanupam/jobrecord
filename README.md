# Job Tracker

A personal app I built to stay on top of my job search — track applications, statuses, notes, and response rates in one place.

Works as a guest (data stays in your browser) or with a free Firebase account to sync across devices.

## Getting started

```bash
npm install
cp .env.example .env   # fill in your Firebase config
npm start
```

Firebase setup:
- Enable **Email/Password** under Authentication
- Deploy `firestore.rules` to Firestore (keeps your data private to your account)
- Add your Firebase web app keys to `.env` (Firebase console → Project settings → Your apps)

## Scripts

```bash
npm start        # dev server
npm run build    # production build
npm run preview  # serve the build locally
```

## Deploying

Works on any static host (Vercel, Netlify, etc.). Set the build command to `npm run build` and output directory to `build`. Add your deployment URL to Firebase Authentication → Authorized domains.

For Vercel, add the same `.env` variables under Project → Settings → Environment Variables, then redeploy.
