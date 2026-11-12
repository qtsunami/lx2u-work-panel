# Work panel

A personal workbench panel for DeepSeek Harness (DSH): a three-column layout with a left view navigator, a task list, and a right task-detail editor.

## Product direction

A personal AI outcomes workbench: fast capture → execution → reliable receipts → review → reusable evidence and reports.
The next milestones are tracked in [ROADMAP.md](./ROADMAP.md): 1.3.x stabilization, 1.4.0 AI capture/context/delegation and Host-readable local data, 1.5.0 problem radar and opt-in automatic reports, 1.6.0 acceptance/search/reuse. Personal use only; no team collaboration scope.

## Personal AI capture and Host data (v1.4.0)

- **Usable quick entry**: Enter or the visible `添加任务` button creates a task directly (Alt+Enter remains compatible). `AI 记录` optionally interprets progress/outcomes with a confirmation preview; the model is not required to create or complete a task. Chinese IME composition does not submit. AI capture uses only explicitly chosen deadline suggestions; overlong AI input is kept.
- **Current context**: the assistant knows the selected task/project/report. The selected task is included even beyond the first 50 tasks; a report does not inherit a hidden previous task. The disclosure explains the bounded data sent to the configured model. Accepted AI-organized records retain original user text alongside the summary.
- **Local canonical data**: the Host KV unit `work_panel_workspace` stores the full personal workspace. Browser localStorage is a cache and durable outbox, not the only copy. Initialization first backs up the old browser data; the Host also stores the initial migration snapshot in the same durable write. Data remains local, without an account or cloud sync.
- **Cleared-cache guard**: if the browser cache suddenly reads empty while the last synced baseline had records, auto-commit stops with a conflict instead of replacing canonical data with emptiness; the user must export and explicitly choose reload. Intentional deletions that leave some records still commit.
- **Revision safety**: each workspace has a stable `storeId` and monotonically increasing revision. Full-snapshot commits require both plus a persisted request id. An immutable in-flight request is replayed after refresh; newer edits queue behind it. A conflict never silently overwrites another revision. There is one Host writer per KV unit, not a distributed multi-process lock.
- **Typing never re-renders the panel**: the title/description field owns its own echo while typing, so a keystroke no longer touches workspace state; the stylesheet is mounted once instead of rebuilt per render; and both the debounce and the commit phase of a sync are quiet, so neither reaches React. No per-write indicator element exists. Sync failures still surface.
- **Sync is not UI state**: a routine background sync never reaches React state at all — it is surfaced by toggling one fixed-position dot through the DOM, so typing cannot cause a re-render loop. Only phases the user must know about (offline/conflict/local/error, and messages that changed) update the panel, deduplicated by phase+message+canEdit+revision.
- **No jumping while typing**: task title/description edits update the field immediately but persist once typing pauses (500 ms). Routine edit-triggered syncs are marked quiet and shown only as a small fixed dot, so the header never reflows or flashes a banner per keystroke. A pending edit is flushed when the selection changes or the page unloads, so a fast switch cannot drop characters. Offline, conflict, local-only and error states remain visible banners.
- **Visible states**: syncing, offline, conflict and failure stay visible. A previously bound cache remains editable on retryable Host read failure. If the first Host read fails, a valid browser workspace is backed up and marked **仅本页保存** before enabling local task edits; no Host sync is claimed or attempted. The marker survives refresh and prevents automatic Host hydration over those edits. Export an independent backup before any recovery. The explicitly confirmed `备份后加载主存` replaces local data after saving a local snapshot, without merging; it cannot repair a broken Host storage backend. If local cache validation or durable marker storage fails, editing remains blocked instead of risking loss. Focus refresh of an unchanged canonical revision does not reset undo or editor sessions.
- **Rollback**: `管理 → 数据 → 恢复迁移前副本` asks first, backs up the current workspace, and restores the saved pre-migration contents as a new revision. It is undoable; it never rewinds the canonical revision counter. Same-browser backups still do not replace an external exported file.
- **Bounded agent context**: the read-only `work_panel_context` tool and `POST /api/work-panel/context` share list/read/prepare behavior. List is paged (default 20, max 50); read includes recent records/artifacts; prepare returns an instruction, not an execution.
- **Explicit handoff**: task detail → `交给 AI` first flushes pending edits, then prepares a task-id-bearing instruction with goals, evidence and acceptance criteria. `打开执行草稿` uses the existing DSH UI to open an unsent draft and append rather than replace an existing draft. The user still sends it. If unavailable, copy the instruction instead.
- **Provenance**: tool receipts receive the actual calling session id. Adopted records/artifacts retain it and offer `来源会话`. Local files are inert text references (`files`), with copy-path and source-session navigation; no arbitrary `file:` link, automatic read or execution. Arbitrary historical chat selection/import is not implemented in this version.
- **Association**: only an explicit live task id or one unambiguous exact normalized title is linked automatically. Fuzzy/duplicate titles require user selection.
- **Durable adoption**: a receipt is removed from the Host inbox only after canonical records and handled ids have been saved. If the workspace commit conflicts or is offline, the original inbox receipt remains recoverable even if the browser cache is lost.

Workspace HTTP contract: `GET /api/work-panel/workspace`; `POST` accepts `{action: "initialize" | "commit", baseRevision, requestId, storeId, workspace}`. The Host returns applied `revision` separately from `currentRevision`; do not jump to an unrelated current revision when retrying. Idempotency receipts retain the latest 100 workspace requests; the inbox retains its own separate bounds.

The synchronization class has canonical, independently tested source and is embedded into the single shipped client script. After changing that source, build it before testing:

```bash
node build-client.mjs  # workspace-sync.js → generated region in client.js
npm test              # checks build parity before running all suites
```

The source and test tooling are repository development files, not additional runtime dependencies.

Host restart and real DSH navigation/visual acceptance are still required before treating this build as live-verified. The VM service adapters verify the contract and interaction logic, not a real window launch.

- **Task row right-click menu**: opens at the pointer and extends to its right, flipping left only when it would clip. Priority is a row of four colored flags (高 red / 中 amber / 低 blue / 无 grey) with the current level highlighted. `移动到 ›` opens a side panel to the right of the menu (it does not push the menu open downward), anchored to that row and flipped left only if the viewport would clip; the panel scrolls its own list and shrinks to fit the window. Contents: `未分组` first, then the current project pinned next and marked with a check, then the rest; with more than six projects a search box filters by name. Also offers toggle done, open detail and move to the recycle bin; closes on outside click, Escape, resize or selection change.
- **Project binding moved out of the detail panel**: the task detail no longer carries a project selector; assignment happens from the row's right-click menu so the detail stays focused on the task itself.

## Proactive and automatic (v1.5.0)

- **Repeated reminders**: several signals about one task appear as one grouped row with the leading signal, the others listed beneath, and batch `全部 3 天后` / `全部忽略`. Each signal remains individually snoozable/dismissable.
- **Issue radar (`需要注意`)**: local rules surface overdue tasks, deadlines within 3 days, tasks blocked for 7+ days, tasks without a recent record for 14+ days, pending receipts, and completed tasks without any artifact reference. Each item states the fact and its evidence; **"暂无近期记录" never implies the person did not work**. Snooze (3/7 days) and dismiss are per issue, persist in the workspace, and can be restored. The model is never called to decide an issue; `AI 解释` is an explicit request, is labelled advice rather than a verdict, and cannot change any data.
- **Automatic report drafts**: **off by default**. When enabled, a weekly or monthly draft is generated only while the panel is open — there is no Host schedule and no promise of delivery while the app is closed; a missed period is caught up once. The same period is generated at most once (`generatedKeys` + `lastPeriodKey` both guard it, and a failure allows retrying). A draft you edited by hand is never replaced; machine drafts are marked `auto`. Failures back off 1/5/15/60 minutes and then stop for manual retry.
- **Automation controls**: `数据 → 自动生成工作报告` shows the switch, report kind, weekday/day-of-month, time, time zone, **model**, evidence scope, pause/resume, manual run, and the last result. The model choice affects automatic report generation only (chat and capture keep the default) and falls back to the default for an unknown or malformed value. Unrecognized time zones are reported instead of guessed — the rule module refuses them rather than scheduling at a wrong local time.
- **Manual run**: the explicit button always targets the period you are viewing and is not gated by the timetable; it still refuses an unusable time zone and an empty period, and explains why.

The rules live in two independently tested, browser-safe modules embedded into the single shipped client: `radar.js` (62 cases) and `auto-report.js` (65 cases), plus 11 UI interaction cases. Period semantics match the existing weekly/monthly report definition (Monday-start week, calendar month, `start_end` keys).

## Stabilization (v1.3.2)

- Report identity includes kind, period **and project**. Unrelated batch inserts never reset the editor. Unsaved edits are buffered per identity and included in exports. New edits, workspace restores and stale AI responses cannot silently overwrite one another.
- Saving a report again preserves its original reference snapshots, including sources that were permanently deleted.
- Storage failures stay visible; in-memory changes can be exported or retried. Invalid local JSON is protected from automatic overwrite; an intentional valid restore first retains its raw bytes.
- Imports validate all records, reject incomplete replace operations and oversized results instead of truncating, and accept complete empty envelopes so the first import can be undone.
- Import, restore, clear, project moves, AI confirmations and inbox adoption use a local rollback journal for multi-store writes. Interrupted operations recover before mounting; a rollback failure blocks further writes. This is not a multi-window transaction protocol: an observed external storage change suspends stale writes until reload.
- A safety snapshot must succeed before import/clear/restore proceeds. Old undo cards, previews and in-flight AI work are invalidated after replacing a workspace.
- Offline task parsing also requires confirmation before creating tasks.
- The inbox now uses durable Host storage; see below. At 1.3.2 tasks remained browser-owned; the 1.4.0 section above supersedes that storage arrangement.

Validation includes stateful VM interactions and injected storage failures, not only tree-render smoke tests. Real desktop restart/visual acceptance has not yet been performed for this build.

## AI collaboration (v1.1)

The model never mutates task data directly. It returns a typed action list, the panel shows exactly what
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

## Backup and restore (v1.3.1)

`管理 → 数据` is the safety net for a local-first tool:

- **Export** writes one JSON file (`work-panel-backup-YYYY-MM-DD.json`) containing tasks, work records, artifacts, projects, reports and the inbox ack list, with a schema number and the producing version.
- **Import** accepts that file in two modes: `合并` unions by id and keeps the newer record on conflict (nothing is deleted), `覆盖` replaces the workspace. Both run the project migration afterwards, so backups taken before project entities still import cleanly. A pre-import snapshot must be written successfully first; otherwise the operation stops.
- **Restore** offers `撤销上次导入/清空` and one rolling **daily snapshot** checked when the panel mounts. A same-storage snapshot protects some mistakes, not clearing app data; keep an exported file outside the app for independent recovery.
- **Clear** removes local data only after an inline confirmation, and keeps the same one-step undo.
- The sidebar footer shows the running version, and a unit test keeps it in sync with `package.json`, so you can always tell whether a restart actually loaded the new build.

The Host queue and the assistant are unaffected: this is purely the browser's own data.

## Execution report-back (v1.3)

An executing agent — this session, a subagent, or a local script — can report "what I just did"
back to the panel without touching task data.

| Channel | How |
| --- | --- |
| Model tool | `work_panel_report` with `{ taskId?, taskTitle?, text, kind?, artifacts?, requestId? }` (registered when the profile has a tool registry) |
| HTTP | `POST /api/work-panel/report-back` with the same body, on the same authenticated `/api` channel as the assistant |

The Host queues what it receives (`GET /api/work-panel/inbox`); the panel polls it, lists the items under
`管理 → 执行回传`, and only writes them into a task when the user clicks `采纳为记录`:

- a report becomes an append-only **work record** marked `回传` in the timeline, plus the attached **artifacts**
- items are matched to a task by explicit `taskId` or one unambiguous exact normalized `taskTitle`; fuzzy or duplicate titles require selection; an unmatched item shows a task picker and cannot be adopted until one is chosen
- **nothing is auto-completed**: adoption adds records only, exactly like the manual `记录进展` action
- `忽略` acknowledges an item without adding records. Record/artifact adoption and the local handled-id list commit together; failed Host acknowledgements are retried during polling.
- the Host queue uses the DSH KV backend (`inboxBackend: json` in the shipped patch) and the `work_panel_inbox` unit. Storage success precedes an `ok: true` receipt. Missing/ambiguous storage or a full queue (200 pending items) returns an explicit failure; it never evicts older pending work.
- `requestId` is optional. Reuse it when retrying the same payload: pending requests and the latest 1000 acknowledged keys are deduplicated; a different payload with the same retained key is rejected. Without a key, retries may enqueue twice. This is bounded idempotency, not permanent exactly-once delivery.
- write failures may be uncertain (published before I/O failed); retry with the same key. The queue reopens its storage handle after such errors rather than trusting stale memory.
- one plugin instance owns the inbox unit. There is no multi-process writer/merge protocol; do not mount competing instances against the same unit.

## Weekly and monthly report (v1.2.1)

Left nav `周报` opens a report page: period selector on the left, editor in the middle, evidence sidebar on the right.

- **Evidence** = tasks completed inside the week plus unfinished tasks that gained a work record or an artifact inside it. Each item can be unchecked; **unchecking only affects the next generation** and never rewrites a body you already edited.
- **Generate** → a five-section draft (`本期主要成果` / `重点工作进展` / `问题、风险与阻塞` / `AI 辅助分析与建议` / `下期计划`), saved as a draft automatically.
- **Traceability**: every factual sentence carries an inline marker (`[[task:t-…]]`, `[[log:l-…]]`, `[[artifact:a-…]]`). In the preview they render as clickable badges that jump to the source task; a marker whose source disappeared shows `?` instead of vanishing.
- **Host validation**: markers whose ids are not in the evidence bundle are stripped before the body reaches the browser, and the count is reported back.
- **Monthly report**: switch `周报 / 月报` in the toolbar. A month uses the natural calendar month and summarises the weeklies that fall inside it; the prompt asks the model to consolidate highlights and to write any repeated achievement only once, instead of concatenating the weekly bodies.
- **Project-aware reports**: when a report is scoped to a project, its prompt carries the project name and description and is told to ignore unrelated projects.
- **Paragraph polishing**: in preview mode click a paragraph → `润色`; the rewritten paragraph is shown as an unapplied suggestion alongside its evidence badges, and `替换这一段` applies it. The Host rejects any result that drops, edits or invents an evidence marker, and the client refuses to replace a paragraph whose text changed while the suggestion was open.
- **Edit / Preview** toggle, `保存草稿`, `复制`, `导出 MD` (markers become numbered footnotes plus a source list). Copy/export are local; AI generation sends selected context/evidence to the configured model provider.
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
- **Project health**: a project view shows what matters at a glance — todo, done with completion rate, overdue, this week's records and artifacts, plus the last activity time.
- **Per-project reports**: from the report page, `按项目生成` writes one draft for every project that has evidence in the period (sequential, one model call each); the current editor is left untouched and generating is blocked while the current draft has unsaved edits.
- **Projects**: a project is a real record (`id`, name, description, active/archived), not a text label on a task — tasks reference it by id, so renaming a project updates every task at once and never splits it in two. Pick one in the task detail, create it inline (`+ 新建项目…` or the sidebar `+`), or leave the task ungrouped. The sidebar lists every project including empty and archived ones with live task counts; project settings rename, describe, archive and delete (deleting keeps the tasks, they just become ungrouped; renaming onto an existing name merges the two). Reports can be scoped to one project id, which scopes their evidence and export filename, and old reports keep the project name they were generated with.
- **Data safety**: export/import the whole workspace as one JSON file (`合并` or `覆盖`), a daily snapshot, one-step undo after import or clear, storage usage, and the running version shown in the sidebar.
- **Execution report-back**: an executing agent reports progress through the `work_panel_report` tool (or `POST /api/work-panel/report-back`); the panel queues it under `管理 → 执行回传` and only writes it into the task when you adopt it.
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
  inboxBackend: json
```

Change these to a provider/model that exists in your profile. Without a working model the assistant degrades to local parsing; the rest of the panel is unaffected.

## Development

| File | Purpose |
| --- | --- |
| `index.js` | Host half: authenticated assistant/report/inbox routes and report-back tool, model prompts and response validation. |
| `inbox-store.js` | Durable, serialized inbox over the Host KV storage contract with bounded idempotency. |
| `workspace-store.js` | Canonical personal workspace, migration snapshot, identity/revision CAS and bounded agent context. |
| `client.js` | Client half: registers the sidebar entry and the main panel. |
| `cordis.patch.yml` | Bundle patch that inserts the plugin row. |
| `locale/*.json` | Display metadata (title/description). |
| `icon.svg` | Panel icon. |
| `test-*.cjs` / `test-host.mjs` | Unit and render-smoke tests (not part of the published files). |

Run all 15 suites with `npm test` (build parity plus all suites); `node test-all.mjs` runs the suites directly. Individual checks:

```bash
node --check index.js && node --check client.js
node test-parse.cjs        # parsing, data model, action protocol
node test-host.mjs         # routing, sanitization, durable tool/route parity
node test-inbox-store.mjs  # restart, idempotency, I/O failure and capacity
node test-stability.cjs    # real state/effect interactions and browser-storage faults
node test-workspace-store.mjs # canonical migration, revisions, identities and I/O faults
node test-workspace-sync.mjs  # deterministic client transport/outbox failure matrix
node test-product-140.cjs     # AI capture/context/handoff/provenance and durable adoption
node test-render.cjs       # empty panel smoke
node test-detail-render.cjs
node test-actions-render.cjs
node test-report-render.cjs
node test-trash-render.cjs
node test-project-render.cjs
node test-inbox-render.cjs
node test-data-render.cjs
```

## Data model (v1.x)

From 1.4.0, personal canonical data and the pending execution inbox are separate Host KV units (`work_panel_workspace` and `work_panel_inbox`). Browser localStorage contains the following caches, outbox and recovery slots:

| Key | Content |
| --- | --- |
| `@local/work-panel:tasks:v1` | Tasks. New fields are filled in on read, so upgrading from an older version needs no migration step: `expected`, `nextStep`, `blockedReason`, `completedAt`, `deletedAt` (soft delete / recycle bin), `projectId` (project entity reference). |
| `@local/work-panel:logs:v1` | Work records — append-only, keyed by `taskId`. |
| `@local/work-panel:artifacts:v1` | Artifact references — `{taskId, summary, links, at, claimedIn}`. `claimedIn` is reserved and unused; report period/evidence selection, not this field, limits repeated inclusion. |
| `@local/work-panel:projects:v1` | Project records — `{id, name, description, color, status: 'active'|'archived', archivedAt}`. Tasks reference them via `projectId`. |
| `@local/work-panel:reports:v1` | Report drafts — `{id, kind: 'week'|'month', period, projectId, projectName, body, refs[{type,id,taskId,snapshot,entry,artifact}], excluded, derivedFromReportIds, status}`. One draft per kind + period + project. |
| `@local/work-panel:migration:projects:v1` | One-time marker for the project migration; `@local/work-panel:migration-backup:projects:v1` keeps the pre-migration tasks/projects/reports for recovery. |
| `@local/work-panel:inbox-ack:v1` | Ids of execution reports the user already adopted or ignored (capped at 300). |
| `@local/work-panel:backup:daily:v1` | One rolling daily snapshot (`{day, at, backup}`) for recovery. |
| `@local/work-panel:backup:pre-import:v1` | The workspace right before the last import or clear, so it can be undone once. |
| `@local/work-panel:chat:v1` | AI assistant conversation. |
| `@local/work-panel:theme` | Light/dark preference. |
| `@local/work-panel:report-edits:v1` | Unsaved report buffers keyed by kind/period/project; included in workspace exports. |
| `@local/work-panel:transaction:v1` | Temporary local rollback journal; recovered before workspace reads on mount. |
| `@local/work-panel:local-only:v1` | First-handshake failure marker: browser cache is editable but not synchronized; blocks automatic Host hydration on restart. |
| `@local/work-panel:host-meta:v1` | Canonical store identity/revision, dirty flag and non-cryptographic baseline digest. |
| `@local/work-panel:host-pending:v1` | Immutable request-id-bearing canonical outbox transaction, replayed on reconnect. |
| `@local/work-panel:workspace-extras:v1` | Legal JSON workspace extensions preserved through hydration, edits and export. |
| `@local/work-panel:backup:before-host:v1` | Browser workspace retained before first Host migration/hydration. |
| `@local/work-panel:backup:raw-before-restore:v1` | Exact raw workspace values retained before intentionally replacing malformed local data. |

Task status stays binary (todo / done). A "blocked" situation is recorded as `blockedReason` on the task instead of a third status, so the state machine stays simple.

## Roadmap

- **1.0.0** (released) — the original three-column workbench (tasks, smart views, priorities, deadlines, assistant).
- **1.1.0** — data foundation (expected result, next step, blocker, `completedAt`, append-only work records, artifacts, recent-progress row, snapshot helper) plus confirm-before-write AI collaboration (preview → confirm → undo, duplicate guard, task-scoped advice, record tidying, attribution).
- **1.2.0** — weekly report: period-scoped evidence, five-section draft, inline evidence markers with jump-back, snapshot-backed refs, copy and Markdown export.
- **1.2.1** — monthly report: `周报 / 月报` switch, natural-month period, weeklies inside the month are consolidated (not concatenated), repeated achievements written once.
- **1.2.2 (unreleased)** — delete entry and recycle bin (soft delete, restore, purge with confirmation, refs fall back to snapshots) plus paragraph-level polishing of report drafts.
- **1.2.3** — project views: project field on tasks, sidebar project grouping, project-scoped lists and reports.
- **1.2.4** — project entities: projects become real records with ids, so renaming cascades, empty projects exist, and tasks are matched by id; includes a one-time migration from the old free-text field with a backup, plus create / rename / merge / archive / delete.
- **1.4.5 (local, uninstalled)** — Data view documents all six sync states with what each means and what to do, highlights the current one, and names the canonical file. Quick entry keeps Enter = direct task creation (confirmed by the user).
- **1.4.4 (local, uninstalled)** — After a local-only start, a later page mount re-checks the Host and automatically adopts the page into an **empty** Host (backup first), so recovery needs no extra click; an occupied Host still blocks and asks for an explicit decision.
- **1.4.3 (local, uninstalled)** — Add user-triggered `把本页数据同步到主存`: after a first-handshake failure left the page in local-only mode, this adopts the page's data into an **empty** Host (fresh backup first) and clears the marker; it refuses when the Host already holds another store, and a failed marker clear is reported instead of claiming sync. Verified by sync cases and 16 suites.
- **1.4.2 (local, uninstalled)** — Fix the Host canonical storage unit identifier. The Host KV backend accepts only `^[a-z][a-z0-9_]*$` unit names, so the hyphenated `work-panel-workspace`/`work-panel-inbox` units were rejected with `malformed-medium` on every open: nothing was ever persisted, and the panel blocked editing. Units are now `work_panel_workspace`/`work_panel_inbox`; tests mirror the Host name rule. No stored workspace data existed to migrate. Applying it requires a Host/app restart, which also reloads the client.
- **1.4.1 (local, uninstalled)** — Restore direct task entry and completion on retryable Host storage-read failure through a clearly marked, durable local-only fallback; preserve a backup and prevent automatic overwrites on reconnect. The underlying Host storage failure still needs separate diagnosis and repair.
- **1.4.0 (unreleased)** — Host-readable personal canonical data with migration/rollback, CAS identities and outbox recovery; AI-first capture and current context; source-preserving records; read-only context discovery; explicit unsent DSH handoff; durable adoption before receipt acknowledgement.
- **1.3.2 (unreleased)** — strict safe imports/empty-workspace undo, visible write failures and rollback recovery, scoped durable editor buffers and stale-response guards, durable Host inbox with request-id retry, and stateful fault tests.
- **1.3.1 (unreleased)** — data safety: JSON export/import with merge and replace modes, daily snapshot, one-step undo, storage usage, visible version, plus `useMemo` around the report evidence/batch/health scans that used to rerun on every keystroke.
- **1.3.0** — execution report-back: `work_panel_report` tool and a report-back route, a Host inbox (made durable in 1.3.2), a panel inbox with adopt/ignore, execution records marked in the timeline, and task matching by id or title.
- **1.2.5** — AI project awareness (`projectId` in the action protocol, project list in the prompt, unknown ids rejected), project context in project-scoped reports, a grouped left sidebar, a project health card, per-project batch report generation, and date-only deadlines now count as overdue from the next day (the overdue view, counts and sorting previously ignored them).
- Decided against: kanban board and a three-state status model.

## License

MIT
