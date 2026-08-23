# Timebox Focus

Countdown timeboxing on top of a section-driven Todoist project. Frontend-only SPA (React + TypeScript + Vite + Tailwind) — no backend, deploys as static files.

## Setup

```sh
npm install
npm run dev
```

## Connect Todoist

Two ways to connect — both end at a bearer token in your browser's `localStorage` (it never leaves your machine except to call `api.todoist.com`):

- **Connect with Todoist (OAuth, recommended)** — click the button on first launch and approve. Tokens auto-refresh hourly via PKCE; no secret is stored. Requires the app to be served over HTTPS (any static host works).
- **API token (power users / local dev)** — go to https://todoist.com/app/settings/integrations/developer, copy your **API token**, paste it, and pick the project you want to timebox. OAuth can't run on localhost (Todoist must fetch the client metadata doc over HTTPS), so use this for `npm run dev`.

**Before deploying:** edit `public/oauth-client-metadata.json` and replace `YOUR-DEPLOYED-DOMAIN` with your real domain — `client_id` must be the exact URL where that file is served (Todoist's zero-registration client-metadata flow).

## Project convention: sections are the workflow

The app maps Todoist sections (matched by name, case-insensitive) to a daily workflow:

| Section | Role |
|---|---|
| **Focus** | Today's top tasks (keep ≤ 3). Rendered as cards with a ▶ Start button. |
| **Buffer** | Adhoc capture. Quick-add strip on top; chips start a fast 15/25m timebox. |
| **Backlog** | Everything else. Its own tab for daily review (count in the tab); also behind a "Pull from Backlog" drawer in Focus. Click a task to move it into Focus. |
| **Done** | Finished today. Listed in the Review tab; **Archive All** closes them all (end-of-day ritual). |

Tasks in no section are treated as Backlog. Section IDs are cached in localStorage and re-resolved on every sync, so renames are picked up automatically. To switch project/token, click **Reset** in the header (clears localStorage).

## Use

- **Task rows**: every task is a compact single-line row (▶ Start always visible). Tap a row to expand it in place — edit title (Enter/blur saves), notes (auto-saves after 500ms and on collapse), duration chips, two-step delete with 3s **Undo** toast. Only one row expands at a time; tap outside or `Esc` collapses (auto-saving).
- **Fast add**: each section has a ghost "＋ Add…" row; input stays open after Enter for rapid entry. Supports mini syntax: `Fix VPN 15m #Focus p1` (duration, target section, priority — p1 = urgent). On mobile a sticky bottom bar (safe-area aware) quick-adds to Buffer. Desktop: `N` opens the Focus input, `B` the Buffer input.
- **Focus tab**: Buffer rows on top, then Focus rows (max 3, warning banner above that). If Focus is empty and Backlog isn't, a morning banner prompts you to plan your day. Backlog rows pull into Focus via the `→` button.
- **Timer**: fullscreen countdown with progress ring. `Space` (or tap anywhere) pause/resume, `Enter` complete, `Esc` exit. Time's up → alarm, notification, and a complete/extend/stop prompt.
- **Review tab**: today's stats (focused minutes, completions, planned-vs-actual %) and a table of Done tasks — planned (Todoist duration) vs actual (local session log) vs delta. **Archive All** closes every Done task and shows "Day complete ✓".

Tasks re-sync from Todoist every 30s. Mutations are optimistic with rollback; if you're offline they queue locally and flush on reconnect. Uses the Todoist API v1 (`/api/v1`).

## Build / deploy

```sh
npm run build   # outputs static files to dist/
```

Serve `dist/` from any static host (GitHub Pages, Netlify, Vercel, nginx, ...). No server-side anything required.
