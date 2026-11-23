# Graph Report - my-timebox-focus-app  (2026-11-23)

## Corpus Check
- Corpus is ~41,506 words - fits in a single context window. You may not need a graph.

## Summary
- 346 nodes · 692 edges · 22 communities (11 shown, 11 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 5 edges (avg confidence: 0.91)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Timebox React App UI
- OpenCode Integration Client
- ESP32 Firmware Core
- Project Dependencies and Config
- App Root and Markdown Renderer
- GitHub Actions Deployment Workflow
- Firmware v2 Specifications
- Web Serial Device Bridge
- TypeScript Project Configuration
- Session Data Model
- Todoist Section Workflow Roles
- Firmware CMake Build System
- ESP32 Flashing Automation
- Unreleased Release Notes
- Version 7 Release Notes
- Version 8 Release Notes
- Apple Touch Icon
- App Icon 300x300
- App Icon Vector Asset
- PWA Icon 192x192
- PWA Icon 512x512

## God Nodes (most connected - your core abstractions)
1. `App()` - 50 edges
2. `resolveOpenCodeBase()` - 20 edges
3. `resolveServer()` - 17 edges
4. `flush()` - 14 edges
5. `buildServerHeaders()` - 14 edges
6. `RowEditor()` - 13 edges
7. `TaskRow()` - 12 edges
8. `text()` - 11 edges
9. `logLine()` - 11 edges
10. `compilerOptions` - 11 edges

## Surprising Connections (you probably didn't know these)
- `Triggered Countdown Display` --semantically_similar_to--> `Firmware v1 Direct Companion Design`  [INFERRED] [semantically similar]
  docs/firmware-v2.md → firmware/DESIGN.md
- `ESP32 USB Serial Companion Migration` --conceptually_related_to--> `USB Serial JSON Protocol`  [INFERRED]
  CHANGELOG.md → docs/firmware-v2.md
- `Shared Firmware Web Conventions` --references--> `Section Workflow Convention`  [EXTRACTED]
  firmware/DESIGN.md → README.md
- `FT6336 Capacitive Touch Controller` --conceptually_related_to--> `Two-Zone Touch Gesture Mapping`  [INFERRED]
  firmware/SPEC.md → docs/firmware-v2.md
- `Section Role Mapping Feature` --conceptually_related_to--> `Section Workflow Convention`  [INFERRED]
  CHANGELOG.md → README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Todoist Section Workflow Roles** — readme_focus_section, readme_buffer_section, readme_backlog_section, readme_done_section [EXTRACTED 1.00]
- **Firmware v2 USB Serial Transition** — changelog_usb_serial_companion, docs_firmware_v2_usb_serial_protocol, firmware_readme_firmware_v2_setup [INFERRED 0.95]
- **ESP32 Hardware Display & Touch Subsystem** — firmware_spec_st7796_display, firmware_spec_ft6336_touch, docs_firmware_v2_touch_gesture_mapping [INFERRED 0.85]

## Communities (22 total, 11 thin omitted)

### Community 0 - "Timebox React App UI"
Cohesion: 0.08
Nodes (61): AddExtra, AddRow(), Analysis(), api(), App(), arr(), BacklogList(), Celebration() (+53 more)

### Community 1 - "OpenCode Integration Client"
Cohesion: 0.07
Nodes (61): buildFallbackPatch(), buildServerHeaders(), createAndPromptOpenCodeSession(), DEFAULT_OC_CONFIG, DEFAULT_SERVERS, DEFAULT_WORKSPACE_DIR, dirToShortRepo(), discoverLocalBridge() (+53 more)

### Community 2 - "ESP32 Firmware Core"
Cohesion: 0.12
Nodes (31): applyConfigJson(), applyStateJson(), doComplete(), doExtend(), doLogStop(), drawDigits(), drawIdle(), drawMoonIcon() (+23 more)

### Community 3 - "Project Dependencies and Config"
Cohesion: 0.07
Nodes (29): dependencies, react-dom@^19.1.0, devDependencies, tailwindcss@^4.1.0, @tailwindcss/vite@^4.1.0, @types/react@^19.1.0, @types/react-dom@^19.1.0, typescript@^5.8.0 (+21 more)

### Community 4 - "App Root and Markdown Renderer"
Cohesion: 0.10
Nodes (29): react@^19.1.0, react, Root(), isTableSeparatorLine(), parseTableAlignments(), parseTableCells(), ProseBlock(), renderInline() (+21 more)

### Community 5 - "GitHub Actions Deployment Workflow"
Cohesion: 0.08
Nodes (25): concurrency, cancel-in-progress, group, environment, runs-on, steps, name, url (+17 more)

### Community 6 - "Firmware v2 Specifications"
Cohesion: 0.10
Nodes (20): Triggered Countdown Display, Firmware v2 Design Contract, App Device Serial Bridge, Session Comment Format, Two-Zone Touch Gesture Mapping, USB Serial JSON Protocol, Firmware v1 Direct Companion Design, Preview Project Picker (+12 more)

### Community 7 - "Web Serial Device Bridge"
Cohesion: 0.18
Nodes (19): alarm(), Timer(), deviceConfig(), DeviceEvent, deviceEvents(), deviceSerialSupported(), deviceSetEnabled(), deviceSetPaused() (+11 more)

### Community 8 - "TypeScript Project Configuration"
Cohesion: 0.15
Nodes (12): compilerOptions, isolatedModules, jsx, lib, module, moduleResolution, noEmit, skipLibCheck (+4 more)

### Community 9 - "Session Data Model"
Cohesion: 0.25
Nodes (8): Session, end, id, minPlanned, paused, remainS, taskId, title

### Community 10 - "Todoist Section Workflow Roles"
Cohesion: 0.29
Nodes (7): Section Role Mapping Feature, Shared Firmware Web Conventions, Backlog Section Role, Buffer Section Role, Done Section Role, Focus Section Role, Section Workflow Convention

## Knowledge Gaps
- **35 isolated node(s):** `id`, `taskId`, `title`, `end`, `minPlanned` (+30 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 140 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **11 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `react` connect `App Root and Markdown Renderer` to `Timebox React App UI`, `Project Dependencies and Config`?**
  _High betweenness centrality (0.115) - this node is a cross-community bridge._
- **What connects `id`, `taskId`, `title` to the rest of the system?**
  _35 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Timebox React App UI` be split into smaller, more focused modules?**
  _Cohesion score 0.07834101382488479 - nodes in this community are weakly interconnected._
- **Why does `App()` connect `Timebox React App UI` to `OpenCode Integration Client`, `App Root and Markdown Renderer`, `Web Serial Device Bridge`?**
  _High betweenness centrality (0.018) - this node is a cross-community bridge._
- **Should `OpenCode Integration Client` be split into smaller, more focused modules?**
  _Cohesion score 0.06927551560021153 - nodes in this community are weakly interconnected._
- **Why does `SimpleMarkdown()` connect `App Root and Markdown Renderer` to `Timebox React App UI`?**
  _High betweenness centrality (0.015) - this node is a cross-community bridge._
- **Should `ESP32 Firmware Core` be split into smaller, more focused modules?**
  _Cohesion score 0.12427409988385599 - nodes in this community are weakly interconnected._