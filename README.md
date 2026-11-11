# Work panel

A personal workbench panel for DeepSeek Harness (DSH): a three-column layout with a left view navigator, a task list, and a right task-detail editor.

## AI collaboration (v1.1)

The model never writes data. It returns a typed action list, the panel shows exactly what
would change, and only a confirmation applies it — with an undo snapshot.

| Step | What happens |
| --- | --- |
| Ask | `明天10点前完成季度报告，紧急` / `把报告改到周五` / `把逾期那几条顺延到下周` |
| Preview | A card lists every action with before → after (e.g. `截止时间：11月10日 → 11月12日`) |
| Confirm | Nothing is written until `确认执行`; `取消` leaves data untouched |
| Undo | `撤销` restores the stores from before the batch |

Safety rules:

- **Action whitelist**: `create`, `update` (whitelisted fields only, including `projectId`), `complete`, `reopen`, `log`, `artifact`. Unknown operations, unknown `taskId`s, unknown `projectId`s and unsafe links are dropped by the Host before they ever reach the browser; the assistant receives the project list so it can file tasks by name without inventing projects, and project moves are previewed as `项目：工作台 → 客户`.
- **Duplicate guard**: a create whose title duplicates an existing task (same wording, contained wording, or heavy character overlap) is skipped and flagged in the preview; `仍然创建` overrides it. The offline fallback goes through the same guard, fixing the old "AI creates the same task twice" bug.
- **Advice is not fact**: in-task `AI 建议` returns a summary, a suggested next step, a suspected blocker and risks — all marked `未确认`. Only `采纳` writes them into the task.
- **Tidying is a proposal**: `AI 整理` rewrites a pasted result into a work record, but the text is placed in the composer; you still press `保存`.
- **Attribution**: records created by the AI are stored with `source: 'ai'` and marked `AI` in the timeline.
- **Undo scope**: any manual edit clears the undo snapshot, so an undo can never overwrite manual work.

`AI 建议` and `AI 整理` require a model; without one the panel says so and leaves data unchanged.

## Weekly and monthly report (v1.2.1)

Left nav `周报` opens a report page: period selector on the left, editor in the middle, evidence sidebar on the right.

- **Evidence** = tasks completed inside the week plus unfinished tasks that gained a work record or an artifact inside it. Each item can be unchecked; **unchecking only affects the next generation** and never rewrites a body you already edited.
- **Generate** → a five-section draft (`本期主要成果` / `重点工作进展` / `问题、风险与阻塞` / `AI 辅助分析与建议` / `下期计划`), saved as a draft automatically.
- **Traceability**: every factual sentence carries an inline marker (`[[task:t-…]]`, `[[log:l-…]]`, `[[artifact:a-…]]`). In the preview they render as clickable badges that jump to the source task; a marker whose source disappeared shows `?` instead of vanishing.
- **Host validation**: markers whose ids are not in the evidence bundle are stripped before the body reaches the browser, and the count is reported back.
- **Monthly report**: switch `周报 / 月报` in the toolbar. A month uses the natural calendar month and summarises the weeklies that fall inside it; the prompt asks the model to consolidate highlights and to write any repeated achievement only once, instead of concatenating the weekly bodies.
- **Project-aware reports**: when a report is scoped to a project, its prompt carries the project name and description and is told to ignore unrelated projects.
- **Paragraph polishing**: in preview mode click a paragraph → `润色`; the rewritten paragraph is shown as an unapplied suggestion alongside its evidence badges, and `替换这一段` applies it. The Host rejects any result that drops, edits or invents an evidence marker, and the client refuses to replace a paragraph whose text changed while the suggestion was open.
- **Edit / Preview** toggle, `保存草稿`, `复制`, `导出 MD` (markers become numbered footnotes plus a source list). Nothing is sent anywhere.
- **Snapshot rule**: saving a draft stores both the reference id and a snapshot taken at that moment, so editing a task later never rewrites an existing report.

## Features

- **Three-column workbench**: views · task list · task detail. The left sidebar is grouped into 任务 / 项目 / 报告 / 管理 sections.
- **Smart views**: all tasks, due today, overdue, completed.
- **Quick add**: type a title, pick a date/time (half-hour steps), press Enter.
- **Priorities**: high (red), medium (yellow), low (blue), none — reflected on the checkbox frame and the detail flag.
- **Deadline display**: today / tomorrow / day-after / weekday / next-week / last-week / month-day, with optional time.
- **Detail panel**: inline title/description editing (auto-save), completion checkbox, clickable date chip with calendar, priority flag menu.
- **Expected result / next step / blocker**: three optional fields that turn a task into an executable item.
- **Work records** (`记录进展`): append-only timeline of progress, problems, decisions and AI collaboration. Each record carries its own timestamp; records are never edited, only appended.
- **Artifacts** (`关联成果`): attach a result summary plus links to docs/files. Saving an artifact never marks the task complete — completion stays an explicit user action.
- **Recent progress in the list**: each row shows the newest work record (deterministic — no model call at render time).
- **Projects**: a project is a real record (`id`, name, description, active/archived), not a text label on a task — tasks reference it by id, so renaming a project updates every task at once and never splits it in two. Pick one in the task detail, create it inline (`+ 新建项目…` or the sidebar `+`), or leave the task ungrouped. The sidebar lists every project including empty and archived ones with live task counts; project settings rename, describe, archive and delete (deleting keeps the tasks, they just become ungrouped; renaming onto an existing name merges the two). Reports can be scoped to one project id, which scopes their evidence and export filename, and old reports keep the project name they were generated with.
- **Recycle bin**: the trash icon in the task detail moves a task to `回收站` (soft delete). The trash view lists what was deleted, when, and offers `恢复` or `彻底删除`; purging asks for confirmation, removes the task with its own records and artifacts, and keeps report snapshots so old reports still resolve. A toast confirms each action and can be left to fade.
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
node test-report-render.cjs
node test-trash-render.cjs
node test-project-render.cjs
```

## Data model (v1.x)

All state lives in `localStorage`, keyed by the plugin scope:

| Key | Content |
| --- | --- |
| `@local/work-panel:tasks:v1` | Tasks. New fields are filled in on read, so upgrading from an older version needs no migration step: `expected`, `nextStep`, `blockedReason`, `completedAt`, `deletedAt` (soft delete / recycle bin), `project` (reserved for project views). |
| `@local/work-panel:logs:v1` | Work records — append-only, keyed by `taskId`. |
| `@local/work-panel:artifacts:v1` | Artifact references — `{taskId, summary, links, at, claimedIn}`. `claimedIn` is reserved so a monthly report cannot claim the same result twice. |
| `@local/work-panel:projects:v1` | Project records — `{id, name, description, color, status: 'active'|'archived', archivedAt}`. Tasks reference them via `projectId`. |
| `@local/work-panel:reports:v1` | Report drafts — `{id, kind: 'week'|'month', period, projectId, projectName, body, refs[{type,id,taskId,snapshot,entry,artifact}], excluded, derivedFromReportIds, status}`. One draft per kind + period + project. |
| `@local/work-panel:migration:projects:v1` | One-time marker for the project migration; `@local/work-panel:migration-backup:projects:v1` keeps the pre-migration tasks/projects/reports for recovery. |
| `@local/work-panel:chat:v1` | AI assistant conversation. |
| `@local/work-panel:theme` | Light/dark preference. |

Task status stays binary (todo / done). A "blocked" situation is recorded as `blockedReason` on the task instead of a third status, so the state machine stays simple.

## Roadmap

- **1.0.0** (released) — the original three-column workbench (tasks, smart views, priorities, deadlines, assistant).
- **1.1.0** — data foundation (expected result, next step, blocker, `completedAt`, append-only work records, artifacts, recent-progress row, snapshot helper) plus confirm-before-write AI collaboration (preview → confirm → undo, duplicate guard, task-scoped advice, record tidying, attribution).
- **1.2.0** — weekly report: period-scoped evidence, five-section draft, inline evidence markers with jump-back, snapshot-backed refs, copy and Markdown export.
- **1.2.1** — monthly report: `周报 / 月报` switch, natural-month period, weeklies inside the month are consolidated (not concatenated), repeated achievements written once.
- **1.2.2 (unreleased)** — delete entry and recycle bin (soft delete, restore, purge with confirmation, refs fall back to snapshots) plus paragraph-level polishing of report drafts.
- **1.2.3** — project views: project field on tasks, sidebar project grouping, project-scoped lists and reports.
- **1.2.4** — project entities: projects become real records with ids, so renaming cascades, empty projects exist, and tasks are matched by id; includes a one-time migration from the old free-text field with a backup, plus create / rename / merge / archive / delete.
- **1.2.5 (unreleased, in progress)** — AI project awareness (`projectId` in the action protocol, project list in the prompt, unknown ids rejected) and project context in project-scoped reports; the left sidebar is grouped into sections.
- Decided against: kanban board and a three-state status model.

## License

MIT
