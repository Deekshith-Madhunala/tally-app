# Tally: habit tracker app with a MongoDB backend

One folder, three parts:

- `www/` the app (works on iPhone, Android and desktop, installs from the browser, works offline)
- `server.js` a small API that stores everything in **your MongoDB**: accounts, every person's habits, logs, notes, badges, and the friends groups
- `capacitor.config.json` optional wrapper for real Google Play and App Store apps

## How the database connection works (important)

Browsers and phone apps cannot talk to MongoDB directly, and your connection string contains your password, so it must never be inside the app. Instead:

```
phone / browser  -->  Tally server (server.js)  -->  your MongoDB
                      keeps MONGODB_URI secret
```

You put the connection string in the server's environment (`MONGODB_URI`). Please do not paste it into chats or commit it to GitHub.

What is stored: `users` (username and a bcrypt password hash), `userdata` (one document per user holding all their people and habits), `shared` (friends group summaries and cheers). Passwords are never stored in plain text. Group entries only ever contain names, streaks and percentages; the server strips everything else.

## 1. Get a free MongoDB (skip if you have one)

1. Create a free cluster at mongodb.com/atlas.
2. Database Access: add a user with a password.
3. Network Access: allow `0.0.0.0/0` (needed because hosts like Render use changing IPs).
4. Connect, Drivers: copy the connection string and replace `<password>`.

## 2. Run it on your computer first

```bash
cd tally-app
cp .env.example .env     # then edit .env: set MONGODB_URI and JWT_SECRET
npm install
npm start
```

Open http://localhost:3000, tap the sliders button (top right), and create an account.

## 3. Put it online (free options)

**Render** (simple):
1. Put this folder in a GitHub repository (`.env` is already ignored).
2. render.com: New, Web Service, pick the repo. Build command `npm install`, start command `npm start`.
3. Under Environment add `MONGODB_URI` and `JWT_SECRET`.
4. Open the URL Render gives you. Free instances sleep when idle, so the first load after a while takes about 30 seconds.

Railway, Fly.io or any VPS with Node 18+ work the same way: run `npm install && npm start` with the two environment variables set.

## 4. Install on phones

Open your server's HTTPS address on the phone:

- **iPhone / iPad (Safari):** Share, Add to Home Screen.
- **Android (Chrome):** tap Install on the banner, or menu, Install app.

Sign in once. Your habits sync across devices, and the Friends tab works. The app still works offline and syncs when it is back online. If two devices edit at the same time, the most recent save wins and the other device updates itself the next time it opens, so open the app on one device at a time when you can.

## 5. Real store apps (optional)

```bash
npm i @capacitor/core @capacitor/android @capacitor/ios
npm i -D @capacitor/cli
npx cap add android
npx cap add ios            # Mac only
npx cap sync
npx cap open android       # Android Studio
npx cap open ios           # Xcode
```

Before that, edit `www/config.js` to your full server address (for example `window.TALLY_API = "https://tally-you.onrender.com";`), set `CORS_ORIGIN=https://localhost,capacitor://localhost` on the server, and change `appId` in `capacitor.config.json`. Google Play costs $25 once, the Apple Developer Program $99 a year. This project has not been compiled into native builds yet.

## Notes

- Accounts use a username and password (8+ characters). There is no password reset, so keep a backup (Settings, Download backup) and remember your password.
- Settings also has Delete account, which removes your cloud data.
- Daily reminder notifications are not included. On the web they are unreliable; the Capacitor Local Notifications plugin can add them to the native apps.
- To ship an update, change files, then bump `CACHE` in `www/sw.js` (`tally-v1` to `tally-v2`).
