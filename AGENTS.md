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

- Keep source transforms pure (`static/edit/blocks.js`: lines in, lines out) and check their
  cases in node before the e2e, by evaluating the file and calling the global it defines. A
  wrong transform is cheaper to find there than through a browser.
- A `received()` wait on text the source already had before the edit passes at once. To wait for
  a removal (a marker toggled off), wait until the old text is gone instead.

- markdown-it puts the blank line after a list in the range of its last item. Every list
  operation (add, split, delete, fill an empty item) must be tested on the last item of a list
  followed by more text, or it eats that blank line and the text after joins the list.
- When a fix only moves a failure to the next step of the same test, stop fixing step by step:
  find what the steps share (here, that blank line) and check every remaining step against it
  before the next run.

- Before the formal runs, walk the whole new flow once in a throwaway script on `lib.mjs` that
  prints the file and `document.activeElement` after every step. All the broken steps show up
  in one pass instead of one per run.
- Changing what a key does breaks the older tests that used it as a shortcut: Enter used to save
  a block, now it splits it. Tests save a block by leaving it (`leave()`), as a click elsewhere
  does, and only press a key to test that key.

- Type what reacts to typing one key at a time (`Input.insertText` per character): a Markdown
  shortcut fires on the space, so pasting "- " in one go would not prove a typist triggers it.

- Controls inside an editable block (a task's checkbox) cannot be clicked unless they are
  `contenteditable="false"`; click them for real (`clickOn()`) in read mode and in edit mode.

### Debugging a flaky or failing step

Reproduce it alone in a throwaway script built on `tests/e2e/lib.mjs`, and log `focusin`,
`focusout` (with `relatedTarget`) and re-renders of `.markdown-body` (a `MutationObserver`) with
timestamps from inside the page. Every timing bug so far showed up as an unexpected render
between two focus events.

The walkthrough script can be the bug. Before changing the editor for a step that fails there,
check the script selected what it meant to: a loose list (items separated by blank lines) wraps
each item's text in a `<p>`, so a search among the item's direct children finds nothing and the
typing lands at the start.

### Visual QA

Tests prove the file is right, not that the page looks right. Before committing UI, take
screenshots with the same helpers (`startNvim`, `startBrowser`, `browser.screenshot`) on a
realistic document, set the viewport with `Emulation.setDeviceMetricsOverride`, and look at
them: read mode, a block being edited, the page after saving, and any fallback state. Check
overlays (toolbars, inputs) at the viewport edges too: one overflowed and scrolled the page
sideways, which no test saw. Compare
read mode and edit mode numerically too (`getBoundingClientRect().height` of the same block):
Chrome forces `white-space: pre-wrap` on plaintext-only hosts, which no stylesheet overrides,
and a nested list grew from 48px to 120px only in edit mode. A control placed under a block (the
table's "+ Row") needs room of its own: check it does not cover the next block. Look at the block under the mouse as well: CDP leaves the pointer on the
last click, so its `:hover` style shows in the screenshot and can hide a selected state.
