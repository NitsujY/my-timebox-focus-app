# Changelog

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
