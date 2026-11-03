// Editing the Markdown preview in place. The page never turns HTML back into
// Markdown: each edit becomes a patch of the source lines a block came from,
// checked by rendering it again, and Neovim writes it (source.replace).
(() => {
	const PENCIL =
		'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/></svg>';
	const EDITABLE = "p, h1, h2, h3, h4, h5, h6, li, th, td";
	const FROZEN = "pre, .katex, .mermaid";
	const MARKS = { bold: "**", italic: "*", strike: "~~", code: "`" };
	const SHORTCUTS = { b: "bold", i: "italic", e: "code", k: "link", S: "strike" };

	let editing = null; // { host, anchor, path, before }
	let selectedBlocks = []; // hosts picked with Esc and Shift+click
	// Neovim broadcasts the new source before it replies, so an edit patched
	// after the previous write settles is patched against what is on disk.
	let lastWrite = Promise.resolve();

	const markdownBody = () => document.querySelector(".markdown-body");
	const currentPath = () => decodeURIComponent(window.location.pathname);
	const isEditMode = () => document.body.classList.contains("lp-edit-mode");
	const normalize = (text) => text.replace(/\s+/g, " ").trim();

	function toast(message) {
		const node = document.createElement("div");
		node.className = "lp-toast lp-toast--error";
		node.textContent = message;
		document.body.append(node);
		setTimeout(() => node.remove(), 3000);
	}

	// --- Edit mode ----------------------------------------------------------

	// Only the outermost editable element of a block becomes an editing host,
	// so a list item edits its nested text together.
	function markHosts() {
		for (const node of markdownBody().querySelectorAll(EDITABLE)) {
			const host = isEditMode() && !node.closest(FROZEN) && !node.parentElement.closest(EDITABLE);
			if (host) node.setAttribute("contenteditable", "plaintext-only");
			else node.removeAttribute("contenteditable");
		}
	}

	const toggle = document.createElement("button");
	toggle.className = "lp-icon-button lp-edit-toggle";
	toggle.title = "Edit (e)";
	toggle.innerHTML = PENCIL;
	toggle.addEventListener("click", () => setEditMode(!isEditMode()));

	function setEditMode(on) {
		if (!on && editing) editing.host.blur();
		document.body.classList.toggle("lp-edit-mode", on);
		toggle.setAttribute("aria-pressed", String(on));
		markHosts();
	}

	// --- Mapping an edit back to the source ----------------------------------

	const lineRange = (anchor) => [parseInt(anchor.dataset.sourceLine), parseInt(anchor.dataset.sourceEnd)];

	function pathFrom(anchor, node) {
		const path = [];
		for (; node !== anchor; node = node.parentElement) path.unshift([...node.parentElement.children].indexOf(node));
		return path;
	}

	function findHost(root, { tag, startLine, endLine, path }) {
		let node = root.querySelector(`${tag}[data-source-line="${startLine}"][data-source-end="${endLine}"]`);
		for (const index of path) node = node && node.children[index];
		return node;
	}

	// The part of the block's source a host's text comes from: a table cell is
	// one segment of its row, so a word repeated in another cell is not matched.
	function scopeOf(host, source) {
		if (host.tagName !== "TD" && host.tagName !== "TH") return [0, source.length];
		const pipes = [...source.matchAll(/(?<!\\)\|/g)].map((m) => m.index);
		const leading = source.trimStart().startsWith("|") ? 1 : 0;
		const bounds = [-1, ...pipes, source.length].slice(leading);
		const index = host.cellIndex;
		return [bounds[index] + 1, bounds[index + 1] ?? source.length];
	}

	function changedSpan(before, after) {
		let start = 0;
		while (start < before.length && before[start] === after[start]) start++;
		let end = 0;
		while (
			end < before.length - start &&
			end < after.length - start &&
			before[before.length - 1 - end] === after[after.length - 1 - end]
		)
			end++;
		return { from: start, to: before.length - end, text: after.slice(start, after.length - end) };
	}

	// Source offset of each rendered character, matched in order: whatever is
	// skipped between two matches is markup.
	function align(rendered, source) {
		const offsets = [];
		let j = 0;
		for (let i = 0; i < rendered.length; i++) {
			const char = rendered[i];
			const whitespace = /\s/.test(char);
			while (j < source.length && !(source[j] === char || (whitespace && /\s/.test(source[j])))) j++;
			offsets.push(j++);
		}
		return offsets;
	}

	function patch(source, before, span) {
		const at = align(before, source);
		const start = span.from < span.to || span.from === 0 ? (at[span.from] ?? source.length) : at[span.from - 1] + 1;
		const end = span.from < span.to ? at[span.to - 1] + 1 : start;
		return source.slice(0, start) + span.text + source.slice(end);
	}

	// Deleting all the text of a bold or code span leaves its markers behind.
	const withoutEmptyMarkup = (text) => text.replace(/(\*\*|__|~~|\*|_|`)\1/g, "");

	// Where a block's edit goes: its lines, and the whole page with them replaced.
	function targetOf({ host, anchor, path }) {
		const [startLine, endLine] = lineRange(anchor);
		const lines = livepreview_source.split("\n");
		const expected = lines.slice(startLine - 1, endLine);
		return {
			host,
			where: { tag: anchor.tagName.toLowerCase(), startLine, endLine, path },
			expected,
			page: (block) => [...lines.slice(0, startLine - 1), ...block.split("\n"), ...lines.slice(endLine)],
		};
	}

	function rendersAs(target, block, text) {
		const page = document.createElement("div");
		page.innerHTML = livepreview_toHtml(target.page(block).join("\n"));
		const node = findHost(page, target.where);
		return !!node && normalize(node.textContent) === normalize(text);
	}

	// The block's source with what was typed in it, { attempt } when no patch
	// renders as typed, or { conflict } when the block changed under the edit.
	function typedSource(state, after) {
		const target = targetOf(state);
		const block = target.expected.join("\n");
		if (!rendersAs(target, block, state.before)) return { target, conflict: true };
		if (after === state.before) return { target, block };
		const [from, to] = scopeOf(state.host, block);
		const scoped = patch(block.slice(from, to), state.before, changedSpan(state.before, after));
		for (const candidate of [scoped, withoutEmptyMarkup(scoped)]) {
			const patched = block.slice(0, from) + candidate + block.slice(to);
			if (rendersAs(target, patched, after)) return { target, block: patched };
		}
		return { target, attempt: block.slice(0, from) + scoped + block.slice(to) };
	}

	function write(target, block) {
		const { startLine, endLine } = target.where;
		const request = () => livepreview_request("source.replace", {
			path: currentPath(),
			start_line: startLine,
			end_line: endLine,
			expected: target.expected,
			lines: block.split("\n"),
		}).then(
			() => true,
			(error) => {
				toast(error.message);
				livepreview_render(livepreview_source);
				return false;
			},
		);
		lastWrite = lastWrite.then(request);
		return lastWrite;
	}

	// --- Committing a block -----------------------------------------------------

	async function commit(state) {
		const after = state.host.textContent;
		if (after === state.before) return;
		await lastWrite;
		const { target, block, attempt, conflict } = typedSource(state, after);
		if (conflict) refuse();
		else if (block !== undefined) await write(target, block);
		else openRaw(target, attempt);
	}

	function refuse() {
		toast("This block changed in Neovim; your edit was not saved");
		livepreview_render(livepreview_source);
	}

	// The patch would not render as typed: show the block's Markdown instead,
	// the way Obsidian does, and write whatever is left there.
	function openRaw(target, text) {
		const raw = document.createElement("textarea");
		raw.className = "lp-raw";
		raw.value = text;
		raw.rows = text.split("\n").length;
		target.host.removeAttribute("contenteditable");
		target.host.replaceChildren(raw);
		editing = { raw };
		const done = () => {
			editing = null;
			write(target, raw.value).then(flushHeldRender);
		};
		raw.addEventListener("blur", done, { once: true });
		raw.addEventListener("keydown", (event) => {
			if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) raw.blur();
		});
		raw.focus();
	}

	function flushHeldRender() {
		if (!livepreview_holdRender() && livepreview_heldText !== null) livepreview_render(livepreview_heldText);
	}

	// --- Formatting a selection --------------------------------------------------

	function selectionIn(host) {
		const selection = getSelection();
		if (!selection.rangeCount || selection.isCollapsed) return null;
		const range = selection.getRangeAt(0);
		if (!host.contains(range.startContainer) || !host.contains(range.endContainer)) return null;
		const offset = (container, at) => {
			const before = document.createRange();
			before.setStart(host, 0);
			before.setEnd(container, at);
			return before.toString().length;
		};
		const text = host.textContent;
		let start = offset(range.startContainer, range.startOffset);
		let end = offset(range.endContainer, range.endOffset);
		// Markdown does not format a span that starts or ends with a space.
		while (start < end && /\s/.test(text[start])) start++;
		while (end > start && /\s/.test(text[end - 1])) end--;
		return start < end ? { start, end } : null;
	}

	function pointAt(host, offset) {
		const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
		let last = null;
		for (let node = walker.nextNode(), seen = 0; node; seen += node.length, node = walker.nextNode()) {
			if (offset <= seen + node.length) return [node, offset - seen];
			last = node;
		}
		return last && [last, last.length];
	}

	function selectText(host, { start, end }) {
		const [from, to] = [pointAt(host, start), pointAt(host, end)];
		if (!from || !to) return;
		const range = document.createRange();
		range.setStart(...from);
		range.setEnd(...to);
		getSelection().removeAllRanges();
		getSelection().addRange(range);
	}

	const wrappedBy = (text, start, end, mark) =>
		text.slice(start - mark.length, start) === mark &&
		text.slice(end, end + mark.length) === mark &&
		(mark !== "*" || (text[start - 2] !== "*" && text[end + 1] !== "*"));

	function wrap(scoped, start, end, kind, url) {
		const inner = scoped.slice(start, end);
		if (kind === "link") return scoped.slice(0, start) + `[${inner}](${url})` + scoped.slice(end);
		const mark = MARKS[kind];
		if (wrappedBy(scoped, start, end, mark)) {
			return scoped.slice(0, start - mark.length) + inner + scoped.slice(end + mark.length);
		}
		return scoped.slice(0, start) + mark + inner + mark + scoped.slice(end);
	}

	// Writes the format and puts the caret back on the same words once the page
	// has re-rendered, so formatting does not end the edit.
	async function format(kind, url, selection = editing && selectionIn(editing.host)) {
		const state = editing;
		if (!state || !selection) return;
		const text = state.host.textContent;
		await lastWrite;
		const { target, block, attempt, conflict } = typedSource(state, text);
		if (conflict) return refuse();
		if (block === undefined) return openRaw(target, attempt);
		const [from, to] = scopeOf(state.host, block);
		const scoped = block.slice(from, to);
		const at = align(text, scoped);
		const formatted = block.slice(0, from) + wrap(scoped, at[selection.start], at[selection.end - 1] + 1, kind, url) + block.slice(to);
		if (!rendersAs(target, formatted, text)) return openRaw(target, formatted);
		editing = null;
		hideToolbar();
		state.host.blur();
		if (!(await write(target, formatted))) return;
		const host = findHost(markdownBody(), target.where);
		if (!host) return;
		host.focus();
		selectText(host, selection);
	}

	// --- Turning blocks into other blocks -------------------------------------

	const allHosts = () => [...markdownBody().querySelectorAll("[contenteditable]")];

	const unmark = (host) => host.classList.remove("lp-block-selected");

	function selectBlocks(hosts) {
		selectedBlocks.forEach(unmark);
		selectedBlocks = hosts;
		getSelection().removeAllRanges();
		hosts.forEach((host) => host.classList.add("lp-block-selected"));
		const range = document.createRange();
		range.selectNodeContents(hosts[0]);
		toolbar.classList.add("lp-format--blocks");
		showToolbarOver(range);
	}

	function clearBlocks() {
		selectedBlocks.forEach(unmark);
		selectedBlocks = [];
		toolbar.classList.remove("lp-format--blocks");
		flushHeldRender();
	}

	function hostsBetween(a, b) {
		const hosts = allHosts();
		const [from, to] = [hosts.indexOf(a), hosts.indexOf(b)].sort((x, y) => x - y);
		return hosts.slice(from, to + 1);
	}

	async function turnInto(kind) {
		const hosts = selectedBlocks.length ? selectedBlocks : editing ? [editing.host] : [];
		if (!hosts.length) return;
		const ranges = hosts.map((host) => lineRange(host.closest("[data-source-line]")));
		const startLine = Math.min(...ranges.map(([start]) => start));
		const endLine = Math.max(...ranges.map(([, end]) => end));
		const state = editing;
		editing = null;
		clearBlocks();
		hideToolbar();
		if (state) {
			state.host.blur();
			await commit(state);
		}
		await lastWrite;
		const lines = livepreview_source.split("\n");
		const expected = lines.slice(startLine - 1, endLine);
		if (!livepreview_blocks.turnable(expected)) {
			toast("Tables and code blocks can't be turned into other blocks");
			return flushHeldRender();
		}
		const result = livepreview_blocks.padded(livepreview_blocks.turnInto(kind, expected), lines[startLine - 2], lines[endLine]);
		await write({ where: { startLine, endLine }, expected }, result.join("\n"));
	}

	const blockButton = (kind, label, title) => {
		const button = document.createElement("button");
		button.dataset.block = kind;
		button.textContent = label;
		button.title = title;
		button.addEventListener("mousedown", (event) => event.preventDefault()); // keep the selection
		button.addEventListener("click", () => turnInto(kind));
		return button;
	};

	const toolbarButton = (kind, label, title) => {
		const button = document.createElement("button");
		button.dataset.format = kind;
		button.innerHTML = label;
		button.title = title;
		button.addEventListener("mousedown", (event) => event.preventDefault()); // keep the selection
		button.addEventListener("click", () => (kind === "link" ? openLinkInput() : format(kind)));
		return button;
	};
	const linkInput = Object.assign(document.createElement("input"), { placeholder: "Paste a link…", hidden: true });
	const toolbar = document.createElement("div");
	toolbar.className = "lp-format";
	toolbar.hidden = true;
	toolbar.append(
		toolbarButton("bold", "<b>B</b>", "Bold (⌘B)"),
		toolbarButton("italic", "<i>I</i>", "Italic (⌘I)"),
		toolbarButton("strike", "<s>S</s>", "Strikethrough (⌘⇧S)"),
		toolbarButton("code", "<code>&lt;/&gt;</code>", "Code (⌘E)"),
		toolbarButton("link", "Link", "Link (⌘K)"),
		Object.assign(document.createElement("span"), { className: "lp-format-separator" }),
		blockButton("h1", "H1", "Heading 1"),
		blockButton("h2", "H2", "Heading 2"),
		blockButton("h3", "H3", "Heading 3"),
		blockButton("bullet", "•", "Bulleted list"),
		blockButton("numbered", "1.", "Numbered list"),
		blockButton("quote", "❝", "Quote"),
		blockButton("text", "¶", "Text"),
		linkInput,
	);

	function hideToolbar() {
		toolbar.hidden = true;
		linkInput.hidden = true;
		if (window.CSS && CSS.highlights) CSS.highlights.delete("lp-link-target");
	}

	function showToolbarOver(range) {
		const rect = range.getBoundingClientRect();
		toolbar.hidden = false;
		toolbar.style.top = `${rect.top + window.scrollY - toolbar.offsetHeight - 8}px`;
		const left = Math.min(rect.left, document.documentElement.clientWidth - toolbar.offsetWidth - 8);
		toolbar.style.left = `${Math.max(8, left) + window.scrollX}px`;
	}

	function placeToolbar() {
		if (!linkInput.hidden || selectedBlocks.length) return;
		const selection = editing && editing.host && selectionIn(editing.host);
		if (!selection) return hideToolbar();
		showToolbarOver(getSelection().getRangeAt(0));
	}

	// The link input takes the focus, so the selection it applies to is kept.
	let linkSelection = null;
	function openLinkInput() {
		linkSelection = editing && selectionIn(editing.host);
		if (!linkSelection) return;
		const range = getSelection().getRangeAt(0).cloneRange();
		// The input takes the focus and the selection with it; keep the words marked.
		if (window.CSS && CSS.highlights) CSS.highlights.set("lp-link-target", new Highlight(range));
		linkInput.hidden = false;
		showToolbarOver(range);
		linkInput.value = "";
		linkInput.focus();
	}

	linkInput.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && linkInput.value.trim()) {
			event.preventDefault();
			format("link", linkInput.value.trim(), linkSelection);
		} else if (event.key === "Escape") {
			hideToolbar();
			if (editing) {
				editing.host.focus();
				selectText(editing.host, linkSelection);
			}
		}
	});
	linkInput.addEventListener("blur", () => {
		hideToolbar();
		if (editing && document.activeElement !== editing.host) {
			const state = editing;
			editing = null;
			commit(state);
			flushHeldRender();
		}
	});

	// --- Wiring -------------------------------------------------------------

	document.addEventListener("focusin", (event) => {
		const host = event.target.closest && event.target.closest("[contenteditable]");
		if (!host || !markdownBody().contains(host) || (editing && editing.host === host)) return;
		const anchor = host.closest("[data-source-line]");
		editing = { host, anchor, path: pathFrom(anchor, host), before: host.textContent };
	});

	document.addEventListener("focusout", (event) => {
		if (!editing || event.target !== editing.host || toolbar.contains(event.relatedTarget)) return;
		const state = editing;
		editing = null;
		if (!selectedBlocks.length) hideToolbar();
		commit(state);
		// Re-rendering now would replace the block that is taking the focus.
		const next = event.relatedTarget;
		if (!(next && next.closest && next.closest("[contenteditable]") && markdownBody().contains(next))) flushHeldRender();
	});

	document.addEventListener("keydown", (event) => {
		if (editing && event.target === editing.host) {
			const kind = (event.metaKey || event.ctrlKey) && SHORTCUTS[event.shiftKey ? event.key.toUpperCase() : event.key];
			if (kind) {
				event.preventDefault();
				kind === "link" ? openLinkInput() : format(kind);
			} else if (event.key === "Enter") {
				event.preventDefault();
				editing.host.blur();
			} else if (event.key === "Escape") {
				// Like Notion: Esc leaves the text and selects its block.
				event.preventDefault();
				const host = editing.host;
				selectBlocks([host]);
				host.blur();
			}
			return;
		}
		if (selectedBlocks.length && event.key === "Escape") {
			event.preventDefault();
			clearBlocks();
			hideToolbar();
			return;
		}
		const typing = event.target.closest && event.target.closest("input, textarea, [contenteditable]");
		if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
		if (event.key === "e") {
			event.preventDefault();
			setEditMode(!isEditMode());
		}
	});

	document.addEventListener("selectionchange", () => requestAnimationFrame(placeToolbar));

	// Shift+click extends the block selection from the block being edited or selected.
	document.addEventListener(
		"mousedown",
		(event) => {
			if (!isEditMode() || toolbar.contains(event.target)) return;
			const host = event.target.closest && event.target.closest("[contenteditable]");
			const from = editing ? editing.host : selectedBlocks[0];
			if (event.shiftKey && host && from && markdownBody().contains(host) && host !== from) {
				event.preventDefault();
				selectBlocks(hostsBetween(from, host));
				if (editing) editing.host.blur();
			} else if (selectedBlocks.length) {
				clearBlocks();
				hideToolbar();
			}
		},
		true,
	);

	// A link inside an editable block places the caret instead of navigating.
	document.addEventListener(
		"click",
		(event) => {
			if (isEditMode() && event.target.closest && event.target.closest("[contenteditable] a")) event.preventDefault();
		},
		true,
	);

	livepreview_holdRender = () => editing !== null || selectedBlocks.length > 0;
	const topbar =
		document.querySelector(".lp-topbar") ||
		document.body.appendChild(Object.assign(document.createElement("div"), { className: "lp-topbar" }));
	topbar.prepend(toggle);
	document.body.append(toolbar);
	new MutationObserver(markHosts).observe(markdownBody(), { childList: true });
	setEditMode(false);
})();
