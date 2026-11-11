# Work panel

A personal workbench panel for DeepSeek Harness (DSH): a three-column layout with a left view navigator, a task list, and a right task-detail editor.

## AI collaboration (v5.1)

The model never writes data. It returns a typed action list, the panel shows exactly what
would change, and only a confirmation applies it — with an undo snapshot.

| Step | What happens |
| --- | --- |
| Ask | `明天10点前完成季度报告，紧急` / `把报告改到周五` / `把逾期那几条顺延到下周` |
| Preview | A card lists every action with before → after (e.g. `截止时间：11月10日 → 11月12日`) |
| Confirm | Nothing is written until `确认执行`; `取消` leaves data untouched |
| Undo | `撤销` restores the stores from before the batch |

Safety rules:

- **Action whitelist**: `create`, `update` (whitelisted fields only), `complete`, `reopen`, `log`, `artifact`. Unknown operations, unknown `taskId`s and unsafe links are dropped by the Host before they ever reach the browser.
- **Duplicate guard**: a create whose title duplicates an existing task (same wording, contained wording, or heavy character overlap) is skipped and flagged in the preview; `仍然创建` overrides it. The offline fallback goes through the same guard, fixing the old "AI creates the same task twice" bug.
- **Advice is not fact**: in-task `AI 建议` returns a summary, a suggested next step, a suspected blocker and risks — all marked `未确认`. Only `采纳` writes them into the task.
- **Tidying is a proposal**: `AI 整理` rewrites a pasted result into a work record, but the text is placed in the composer; you still press `保存`.
- **Attribution**: records created by the AI are stored with `source: 'ai'` and marked `AI` in the timeline.
- **Undo scope**: any manual edit clears the undo snapshot, so an undo can never overwrite manual work.

`AI 建议` and `AI 整理` require a model; without one the panel says so and leaves data unchanged.

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
- **AI assistant** (optional): a top-bar button opens a chat drawer that creates, updates, completes and records tasks after confirmation. Requires an LLM provider configured in your profile; without one, chat still parses a simple create locally (with the duplicate guard).
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
| `index.js` | Host half: registers `POST /api/work-panel/chat` on the `connection` fetch channel. Builds the prompts and validates every model action before returning it. |
| `client.js` | Client half: registers the sidebar entry and the main panel. |
| `cordis.patch.yml` | Bundle patch that inserts the plugin row. |
| `locale/*.json` | Display metadata (title/description). |
| `icon.svg` | Panel icon. |
| `test-*.cjs` / `test-host.mjs` | Unit and render-smoke tests (not part of the published files). |

Run the checks:

```bash
node --check index.js && node --check client.js
node test-parse.cjs        # parsing, data model, action protocol
node test-host.mjs         # prompt routing, action sanitization
node test-render.cjs       # empty panel smoke
node test-detail-render.cjs
node test-actions-render.cjs
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

- **v5.0** — data foundation: expected result, next step, blocker, `completedAt`, append-only work records, artifacts, recent-progress row, snapshot helper for report refs.
- **v5.1 (this release)** — in-task AI collaboration: structured actions with preview → confirm → undo, duplicate guard, task-scoped advice, record tidying, AI attribution.
- **v5.2** — weekly report: generated from work records and artifacts, with a reference sidebar; every fact is backed by a reference stored as a snapshot taken at generation time, so later task edits never rewrite an old report.
- **v5.3** — monthly report, project views, recycle-bin UI, paragraph-level polishing.
- Decided against: kanban board and a three-state status model.

## License

MIT
