# Changelog

## Unreleased

- **Device screen-off timeout**: Settings → ESP32 companion display picks how long the idle clock stays lit (1/5/15/30 min or never). Pushed over the LAN relay and persisted on the device (NVS), so it survives reboots.
- **Backlog quick-capture**: the add input sits at the top of the Backlog tab, always open and focused on entry. New tasks land directly beneath it (equal priority/due now sorts newest-first via `added_at`) with a brief highlight.

## v8 — Fast switching & overrun visibility

- **Auto-pick project on connect**: the first project besides Inbox is chosen automatically after OAuth/token entry — no manual selection screen.
- **Project chips in the header**: one-tap switching between Todoist favorite projects (`is_favorite`); falls back to the 3 most-recently-used projects when no favorites are set.
- **Overrun clock**: past the planned end, the timer counts up (`+M:SS`) in orange on the clock, in the time-up dialog, and in the browser tab title. Overrun counts toward `actual_minutes`.
- **Walk-away auto-stop**: a time-up left unanswered for 5 minutes rings the alarm once more, then logs the session (as abandoned) and stops the timer.

## v7 — Public-ready

- **Section role mapping**: internal logic uses roles (`focus`/`buffer`/`backlog`/`done`) mapped to Todoist section IDs per user (`tb_roles`). No hardcoded section names.
- **Mapping screen** (onboarding + Settings): auto-detects by name (`focus`/`today`, `backlog`/`inbox`/`later`/`someday`, …), per-role dropdown of existing sections, "＋ Create section" per role, one-click "Auto-create missing", duplicate mapping rejected.
- **Stale mapping detection**: a section deleted/renamed in Todoist triggers a non-blocking "Re-map your sections" banner on next sync.
- **Buffer is optional**: toggle in Settings hides the Buffer lane and quick-add strip everywhere.
- **Onboarding** (4 screens, skippable): problem → theory lifecycle diagram → section mapping → interactive 5-minute demo timebox with celebration. Persisted via `tb_onboarded`; "View guide again" in Settings.
- **Teaching empty states** for Focus, Backlog, Buffer, and Review.
- **Settings page** (⚙ in top bar): role mapping, focus cap 1–5 (default 3), editable duration presets (default 15/25/50/90), buffer toggle, timer end behavior (Hard stop vs Gentle notification-only), morning ritual banner toggle, "How it works" link.
- **"?" reference panel**: dismissible side panel with the lifecycle diagram and the 3 rules.
- **Free-plan robustness**: duration-write API errors are detected once, shown as "Durations need Todoist Pro — timers still work locally", and duration sync is skipped from then on (`tb_no_duration`).
- **Long lists**: task lists render the first 50 with a "Show all" button instead of mounting everything.
- Error messages say what to do (e.g. "Couldn't reach Todoist — retrying in 30s").
