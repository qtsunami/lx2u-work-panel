# Work panel

A personal workbench panel for DeepSeek Harness (DSH): a three-column layout with a left view navigator, a task list, and a right task-detail editor.

## Features

- **Three-column workbench**: views · task list · task detail.
- **Smart views**: all tasks, due today, overdue, completed.
- **Quick add**: type a title, pick a date/time (half-hour steps), press Enter.
- **Priorities**: high (red), medium (yellow), low (blue), none — reflected on the checkbox frame and the detail flag.
- **Deadline display**: today / tomorrow / day-after / weekday / next-week / last-week / month-day, with optional time.
- **Detail panel**: inline title/description editing (auto-save), completion checkbox, clickable date chip with calendar, priority flag menu.
- **Expected result / next step / blocker**: three optional fields that turn a task into an executable item.
- **Work records** (`记录进展`): append-only timeline of progress, problems, decisions and AI collaboration. Each record carries its own timestamp; records are never edited, only appended.
- **Artifacts** (`关联成果`): attach a result summary plus links to docs/files. Saving an artifact never marks the task complete — completion stays an explicit user action.
- **Recent progress in the list**: each row shows the newest work record (deterministic — no model call at render time).
- **Search and sort**: by deadline, priority, or creation time.
- **AI assistant** (optional): a top-bar button opens a chat drawer. Requires an LLM provider configured in your profile; without one it falls back to local rule-based parsing.
- **Light/dark theme**.
- Data is stored in the browser's `localStorage` — per browser, not synced across devices.

## Requirements

- DeepSeek Harness (DSH) with a Web profile.
- Optional: an LLM provider/model for the AI assistant.

## Install

### From GitHub

```bash
dsh plugin --profile web add github:<your-account>/<repo>
```

Then restart the app so the Host half (`index.js`) is loaded.

### From a local directory (development)

```bash
dsh plugin --profile web add /absolute/path/to/work-panel
```

You can also install it through the Plugin Manager (`install_bundle` with the package directory).

## Configuration

The bundle's `cordis.patch.yml` sets the assistant model:

```yaml
config:
  provider: deepseek-account
  model: deepseek-flash
```

Change these to a provider/model that exists in your profile. Without a working model the assistant degrades to local parsing; the rest of the panel is unaffected.

## Development

| File | Purpose |
| --- | --- |
| `index.js` | Host half: registers `POST /api/work-panel/chat` on the `connection` fetch channel. |
| `client.js` | Client half: registers the sidebar entry and the main panel. |
| `cordis.patch.yml` | Bundle patch that inserts the plugin row. |
| `locale/*.json` | Display metadata (title/description). |
| `icon.svg` | Panel icon. |
| `test-*.cjs` / `test-host.mjs` | Unit and render-smoke tests (not part of the published files). |

Run the checks:

```bash
node --check index.js && node --check client.js
node test-parse.cjs
node test-host.mjs
node test-render.cjs
node test-detail-render.cjs
```

## Data model (v5)

All state lives in `localStorage`, keyed by the plugin scope:

| Key | Content |
| --- | --- |
| `@local/work-panel:tasks:v1` | Tasks. New fields are filled in on read, so upgrading from an older version needs no migration step: `expected`, `nextStep`, `blockedReason`, `completedAt`, `deletedAt` (reserved for the recycle bin), `project` (reserved for project views). |
| `@local/work-panel:logs:v1` | Work records — append-only, keyed by `taskId`. |
| `@local/work-panel:artifacts:v1` | Artifact references — `{taskId, summary, links, at, claimedIn}`. `claimedIn` is reserved so a monthly report cannot claim the same result twice. |
| `@local/work-panel:chat:v1` | AI assistant conversation. |
| `@local/work-panel:theme` | Light/dark preference. |

Task status stays binary (todo / done). A "blocked" situation is recorded as `blockedReason` on the task instead of a third status, so the state machine stays simple.

## Roadmap

- **v5.0 (this release)** — data foundation: expected result, next step, blocker, `completedAt`, append-only work records, artifacts, recent-progress row, snapshot helper for report refs.
- **v5.1** — in-task AI collaboration: structured actions with preview → confirm → undo; organize progress, turn a pasted result into a work record; AI suggestions are always visually separated from confirmed facts.
- **v5.2** — weekly report: generated from work records and artifacts, with a reference sidebar; every fact is backed by a reference stored as a snapshot taken at generation time, so later task edits never rewrite an old report.
- **v5.3** — monthly report, project views, recycle-bin UI, paragraph-level polishing.
- Decided against: kanban board and a three-state status model.

## License

MIT
