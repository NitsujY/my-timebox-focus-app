# Timebox Focus

Countdown timeboxing on top of a section-driven Todoist project. Frontend-only SPA (React + TypeScript + Vite + Tailwind) — no backend, deploys as static files.

## Setup

```sh
npm install
npm run dev
```

## Get a Todoist API token

1. Go to https://todoist.com/app/settings/integrations/developer
2. Copy your **API token**.
3. On first launch, paste it into the app and pick the project you want to timebox.

The token is stored in your browser's `localStorage` only — it never leaves your machine except to call `api.todoist.com`.

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

- **Focus tab**: Buffer quick-add strip (Enter to capture), Buffer chips, then Focus cards. Set a card's duration with the 15/25/50/90 chips (written back to Todoist), then ▶ Start. More than 3 Focus tasks shows a warning banner. If Focus is empty and Backlog isn't, a morning banner prompts you to plan your day.
- **Timer**: fullscreen countdown with progress ring. `Space` pause/resume, `Enter` complete, `Esc` exit. Time's up → alarm, notification, and a complete/extend/stop prompt.
- **Review tab**: today's stats (focused minutes, completions, planned-vs-actual %) and a table of Done tasks — planned (Todoist duration) vs actual (local session log) vs delta. **Archive All** closes every Done task and shows "Day complete ✓".

Tasks re-sync from Todoist every 30s. Mutations are optimistic with rollback; if you're offline they queue locally and flush on reconnect. Uses the Todoist API v1 (`/api/v1`).

## Build / deploy

```sh
npm run build   # outputs static files to dist/
```

Serve `dist/` from any static host (GitHub Pages, Netlify, Vercel, nginx, ...). No server-side anything required.
