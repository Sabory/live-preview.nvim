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
