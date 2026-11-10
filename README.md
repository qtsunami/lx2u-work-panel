# Work panel

A personal workbench panel for DeepSeek Harness (DSH): a three-column layout with a left view navigator, a task list, and a right task-detail editor.

## Features

- **Three-column workbench**: views · task list · task detail.
- **Smart views**: all tasks, due today, overdue, completed.
- **Quick add**: type a title, pick a date/time (half-hour steps), press Enter.
- **Priorities**: high (red), medium (yellow), low (blue), none — reflected on the checkbox frame and the detail flag.
- **Deadline display**: today / tomorrow / day-after / weekday / next-week / last-week / month-day, with optional time.
- **Detail panel**: inline title/description editing (auto-save), completion checkbox, clickable date chip with calendar, priority flag menu.
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

## License

MIT
