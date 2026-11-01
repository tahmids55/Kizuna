# Kizuna 絆

**The workspace chat for co-founders and small teams.**

*Kizuna* is Japanese for the bonds between people. It's a chat app where conversations turn into commitments. Use it instead of WhatsApp for running a company: when someone says "can you send the deck by Friday?", you turn that message into a task assigned to them, and it stays on their list until it's done.

Kizuna runs in the browser (web app) and as an Android app (APK). Both connect to the same server and update in real time. It deploys to **Render** from **GitHub**, with a **Neon** Postgres database.

| Desktop | Phone (dark mode) |
| --- | --- |
| ![Desktop](docs/desktop.png) | ![Mobile](docs/mobile.png) |

---

## What makes it different

**Chat**
- Direct messages and **groups of up to 10 people** (group admins add and remove members).
- Real-time delivery, typing indicators, online presence and last seen, and **read receipts** ("Seen by …").
- Replies with quotes, **@mentions** with autocomplete, emoji reactions, edit (press ↑ to edit your last message), and delete.
- Photos and files (drag-and-drop, paste, or pick), up to 10 MB each, with an image lightbox.
- Pin important messages, save messages for later, and full-text search with **Ctrl K**.
- Unread counts, a "New messages" divider, mute, and pin chats to the top.
- A private **"My space"** for every user, for notes to self, personal to-dos, and personal goals.

**Productivity, built into the chat.** Every item appears as a *live card* in the conversation and in the side panel.

| | What it does |
| --- | --- |
| ✅ **Tasks** | Assign work to each other with a due date and priority. The assignee sees "Task for you from …", ticks it off right in the chat, and everyone sees "✅ completed". |
| 💡 **Ideas** | Capture ideas, vote on them, and move them through New → Exploring → Accepted / Parked. |
| 🎯 **Goals** | Measurable targets (e.g. *Reach $15k MRR*, *100 customers*) with progress updates, history, a progress bar, and a celebration when one is reached. |
| ⚖️ **Decisions** | A decision log with the reasoning behind each one. Teammates tap **"I agree"** to sign off, so nobody has to ask "what did we decide?" again. |
| 📊 **Polls** | Single or multiple choice, live results, and close-and-announce. |
| ☀️ **Check-ins** | Async stand-ups: done / next / blockers, plus your mood. |
| ⏰ **Reminders** | "Remind me about this message" in 20 min, 1 h, tomorrow, next Monday, or a custom time. |

You can turn **any message** into a task, idea, or decision (⋯ menu on desktop, long-press on a phone), or use **slash commands** in the composer: `/task`, `/idea`, `/goal`, `/decision`, `/poll`, `/checkin`, `/remind`.

**Your day at a glance**
- **Today**: your focus list (overdue, today, coming up), what you're waiting on from others, goal progress, fresh ideas, recent decisions, and reminders.
- **Tasks**: everything assigned to you, everything you assigned, or everything you can see.
- **Library**: every idea, goal, decision, and saved message across all your chats.

Plus: profile photo, role, and status ("🎯 Focusing", "✈️ Travelling"…), light and dark themes, browser and Android notifications, and a layout that works from a small phone up to a wide monitor.

---

## Quick start (local)

Requires **Node.js 20+**. You don't need a database server: without `DATABASE_URL`, Kizuna runs a built-in Postgres (PGlite) stored in `data/pglite`.

```bash
npm install
npm run seed      # optional: a demo founding team with real-looking conversations
npm run build
npm start         # → http://localhost:4000
```

To work against your Neon database locally, copy `.env.example` to `.env` and set `DATABASE_URL`.

The terminal also prints a **network** address (e.g. `http://192.168.0.10:4000`). Teammates on the same Wi-Fi can open that in their browser, and the Android app connects to it too.

**Demo login:** `demo@kizuna.app` / `demo1234`, or click *Try the demo team*. The teammates nadia@, arif@, sara@, and leo@kizuna.app use the same password, so you can open a second browser and chat with yourself in real time.

**Development** (hot reload): `npm run dev` → http://localhost:5174

---

## Android app (APK)

A ready-made APK is in **`release/`** (it isn't committed to git, so build it with `npm run android:apk`).

1. Start the server on your computer (`npm start`) and note the **network** address it prints.
2. Copy the APK to your phone and open it. You may need to allow "Install unknown apps" for your file manager. Or run `adb install -r release/Kizuna-1.1.0.apk`.
3. On the sign-in screen, check the **Server address** field. It's pre-filled with the address of the computer that built the APK. Then sign in or create an account.

The phone and the server must be able to reach each other: the same Wi-Fi, or a server on the internet (see *Deploying*).

### Building the APK yourself

Requires a JDK (17+) and the Android SDK (install Android Studio, or set `ANDROID_HOME`).

```bash
npm run android:apk                                   # default server = this computer's LAN address
KIZUNA_SERVER=https://chat.yourco.com npm run android:apk   # bake in your public server
npm run android:open                                  # open in Android Studio (run on a device, sign for release)
```

The APK is written to `release/`. It's a *debug-signed* build, which is fine for installing on your own team's phones. Publishing to the Play Store requires a release keystore (Android Studio → *Build → Generate Signed Bundle*).

---

## Deploy to the internet (GitHub → Render + Neon)

Everything runs as **one Render web service**: the API, the real-time socket, and the web app. Data lives in **Neon** Postgres, including uploaded files, because Render's free disk is wiped on every restart.

**1. Create the database (Neon)**
1. Sign up at [neon.com](https://neon.com) and create a project. Pick the **AWS Asia Pacific (Singapore)** region to sit next to Render's Singapore region.
2. Open **Connect** and copy the **pooled** connection string. It looks like
   `postgresql://user:pass@ep-xxxx-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require`.

Kizuna creates its tables on first start, so there's nothing to run by hand.

**2. Push the code to GitHub**
```bash
git remote add origin https://github.com/<you>/kizuna.git
git push -u origin main
```

**3. Deploy on Render**
1. In [render.com](https://render.com), choose **New → Blueprint**, connect GitHub, and pick the repo. Render reads `render.yaml`.
2. When asked, paste your Neon string into **`DATABASE_URL`**. Optionally set **`KIZUNA_INVITE_CODE`** so only your team can sign up.
3. Click **Apply**. The first build takes a few minutes. Your app is then live at `https://kizuna-xxxx.onrender.com`.

Every `git push` to `main` redeploys automatically.

**4. Optional: load the demo team into Neon.** Run this from your computer:
```bash
DATABASE_URL="postgresql://…" npm run seed
```
`npm run seed:reset` **drops all Kizuna tables** first. Never run it against a database with real data.

**5. Point the Android app at your server**
```bash
KIZUNA_SERVER=https://kizuna-xxxx.onrender.com npm run android:apk
```
Share `release/Kizuna-1.1.0.apk` with your team. Anyone with an older APK can also just type the new address on the sign-in screen.

### Free plan notes
- **Render free** spins down after 15 minutes without traffic, and the first visit afterwards takes about a minute to wake it. Reminders that came due while it slept are delivered on wake-up. For always-on chat, switch the service to **Starter** in Render (or set `plan: starter` in `render.yaml`).
- **Neon free** has 0.5 GB of storage and sleeps when idle. Kizuna avoids background polling (the health check doesn't query the database, and reminders run on timers), so Neon only wakes when someone actually uses the app.
- Uploaded files count toward Neon storage, which is why the default per-file limit is 10 MB (`KIZUNA_MAX_FILE_MB`).

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | *(none → local PGlite)* | Postgres connection string (Neon). **Required on Render** |
| `KIZUNA_INVITE_CODE` | *(none)* | Require this code to register |
| `KIZUNA_MAX_FILE_MB` | `10` | Per-file upload limit |
| `PORT` | `4000` | HTTP port (Render sets this automatically) |
| `KIZUNA_PGLITE` | `data/pglite` | Local database folder when no `DATABASE_URL` |

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | API and web app with live reload |
| `npm run build` | Type-check and build the web app into `dist/` |
| `npm start` | Serve the API, real-time socket, and web app on one port |
| `npm run seed` / `seed:reset` | Add demo data / **drop all Kizuna tables** and re-seed (uses `DATABASE_URL` if set) |
| `npm test` | API and real-time integration tests (in-memory Postgres; set `TEST_DATABASE_URL` to use a real server) |
| `npm run android:apk` | Build `release/Kizuna-<version>.apk` |
| `npm run android:sync` | Copy the latest web build into the Android project |

## How it's built

```
server/                 Node + Express 5 + Socket.IO + PostgreSQL
  db.js                 Postgres via node-postgres (Neon) or PGlite (local/tests), schema, transactions
  auth.js               scrypt passwords, bearer-token sessions (work for web and the app)
  realtime.js           Socket.IO rooms per user and per conversation, presence, typing
  chat.js               conversations, messages, unread and mention counts, broadcasting
  routes/
    conversations.js    DMs, groups (max 10), members and roles, read receipts
    messages.js         send/edit/delete, reactions, pins, saved, search, uploads, reminders, check-ins
    work.js             tasks, ideas, goals, decisions, polls, the Today and Library views
  env.js                .env loading + a guard that refuses to start on Render without DATABASE_URL
  test/                 node:test suite incl. live WebSocket assertions
src/                    React 19 + TypeScript + Vite + TanStack Query
  lib/store.ts          query cache that live socket events update in place
  lib/socket.ts         real-time wiring and notifications
  lib/platform.ts       Android back button, status bar, local notifications (Capacitor)
  components/           chat view, composer, message bubbles, live cards, workspace panel, forms
  pages/                Chats, Today, Tasks, Library, Profile, Sign in
android/                Capacitor 7 native project (icons, splash, manifest)
scripts/build-android.mjs   one-command APK build
render.yaml             Render Blueprint (GitHub auto-deploy)
```

**How the pieces fit**
- Every write goes through the REST API, which validates it, saves it, and then pushes the change over WebSockets to everyone in the conversation. Clients update their cache in place, so nothing needs to reload.
- Productivity items are real records (tasks, ideas, …) *and* a card message in the chat, so the conversation and the side panel always show the same data.
- Login uses bearer tokens rather than cookies, so the same server works for the browser and for the Android app (which runs from its own origin).
- Uploaded files are stored in Postgres and served at unguessable URLs, so images load in both the browser and the app without auth headers. HTML/SVG uploads are forced to download, never rendered.

## Known limitations

- **Push notifications when the Android app is fully closed** need Firebase Cloud Messaging (a Google project and `google-services.json`). Right now the app notifies while it's open or recently backgrounded, and missed messages show as unread when you return.
- There's one workspace per server: everyone who signs up can find each other. Use `KIZUNA_INVITE_CODE` to control who joins.
- It runs as a single server instance. Running several instances would need a Socket.IO Redis adapter, which is plenty far off for teams of this size.
- No voice/video calls or end-to-end encryption. Messages are stored on your own server.
