# live-preview.nvim

Fork that adds comments, changed-line bars, a file tree and in-place editing to the Markdown
preview. Neovim owns the source and serves the page; the page talks back over the websocket
(`livepreview_request` in `static/ws-client.js`, handlers routed from `on_message` in
`lua/livepreview/init.lua`).

## QA

Every feature is checked end to end before it is called done.

- Run the suite with `node tests/e2e/run.mjs`, or one test with `node tests/e2e/run.mjs <name filter>`.
  It drives a headless Neovim (`tests/e2e/init.lua`) and a headless Chromium over CDP
  (`tests/e2e/lib.mjs`).
- Each Neovim serves its own temp copy of `tests/e2e/fixtures` (`nvim.root`). Edits from the preview
  write to disk; assert on the copy, never on the repo's fixtures, and check
  `git status tests/e2e/fixtures` stays clean after a run.
- For anything that edits the source, assert all three: the file on disk (`readFileSync` under
  `nvim.root`), the buffer state (`nvim.expr("&modified")`), and the `update` broadcast the page
  re-renders from (`socketClient().inbox`).
- Cover the refusal path too: a stale `expected` must return an error and write nothing.
- Edits must also work on a file that is not open in Neovim (a hidden buffer gets no TextChanged).
- Neovim writes a new file and renames it over the old one, so a read in between throws ENOENT.
  Poll disk through `readLines()` in `run.mjs`, which reads a missing file as empty.
- A test that needs its own document writes it under `nvim.root` instead of adding a fixture: the
  tree test counts the fixture files.
- Drive the page like a user, through CDP (`browser.cdp`): `Input.insertText` types at the caret,
  `Input.dispatchKeyEvent` presses keys, `clickOn()` clicks through the page's own handlers.
  Setting `textContent` or calling handlers directly skips what the feature depends on.
- End every test with `browser.errors` empty.
- A headless page has no system focus, so `focus()` fires no focus events unless the harness turns
  on `Emulation.setFocusEmulationEnabled` (it does, in `startBrowser`). Without it, focus-driven
  behavior passes or fails depending on whether an earlier CDP input happened to focus the page.
- Text the page shows right after typing is what was typed, not proof of a round trip. Wait on
  `livepreview_source` (`received()` in `run.mjs`) before the next step acts on the new source.
- The format toolbar moves on the next animation frame after a selection: wait
  (`nextFrames()`) before clicking it, or the click lands where the toolbar was.
- Edit the same block twice in a row without waiting, and move straight from one block to
  another: both hit a write or re-render still in flight, which is where the bugs were.
- Run a suite twice before calling it green: timing bugs (renders, writes) pass once by luck.

### Debugging a flaky or failing step

Reproduce it alone in a throwaway script built on `tests/e2e/lib.mjs`, and log `focusin`,
`focusout` (with `relatedTarget`) and re-renders of `.markdown-body` (a `MutationObserver`) with
timestamps from inside the page. Every timing bug so far showed up as an unexpected render
between two focus events.

### Visual QA

Tests prove the file is right, not that the page looks right. Before committing UI, take
screenshots with the same helpers (`startNvim`, `startBrowser`, `browser.screenshot`) on a
realistic document, set the viewport with `Emulation.setDeviceMetricsOverride`, and look at
them: read mode, a block being edited, the page after saving, and any fallback state. Check
overlays (toolbars, inputs) at the viewport edges too: one overflowed and scrolled the page
sideways, which no test saw.
