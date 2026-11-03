// Editing the Markdown preview in place. The page never turns HTML back into
// Markdown: each edit becomes a patch of the source lines a block came from,
// checked by rendering it again, and Neovim writes it (source.replace).
// toolbar.js and structure.js add to this core through `livepreview_edit`.
const livepreview_edit = (() => {
	const PENCIL =
		'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/></svg>';
	const EDITABLE = "p, h1, h2, h3, h4, h5, h6, li, th, td";
	const FROZEN = "pre, .katex, .mermaid";
	const HOST = '[contenteditable="plaintext-only"]';
	const NESTED_LIST = "li > ul, li > ol";
	const SHORTCUTS = { b: "bold", i: "italic", e: "code", k: "link", S: "strike" };
	const { scopeOf, changedSpan, patch, withoutEmptyMarkup, lastFilled } = livepreview_patch;

	const E = {
		editing: null, // { host, anchor, path, before }, or { host, pending } for a new block, or { raw }
		selectedBlocks: [], // hosts picked with Esc and Shift+click
		// Neovim broadcasts the new source before it replies, so an edit patched
		// after the previous write settles is patched against what is on disk.
		lastWrite: Promise.resolve(),
	};

	const markdownBody = () => document.querySelector(".markdown-body");
	const currentPath = () => decodeURIComponent(window.location.pathname);
	const isEditMode = () => document.body.classList.contains("lp-edit-mode");
	const normalize = (text) => text.replace(/\s+/g, " ").trim();
	const sourceLine = (line) => livepreview_source.split("\n")[line - 1];

	function toast(message) {
		const node = document.createElement("div");
		node.className = "lp-toast lp-toast--error";
		node.textContent = message;
		document.body.append(node);
		setTimeout(() => node.remove(), 3000);
	}

	// --- Edit mode ----------------------------------------------------------

	// The outermost editable element of a block becomes an editing host, and so
	// does every list item: its nested lists are made non-editable islands, so
	// the items in them are hosts of their own.
	function markHosts() {
		// A new block (.lp-new) manages its own attribute until the page re-renders.
		for (const node of markdownBody().querySelectorAll(EDITABLE)) {
			if (node.classList.contains("lp-new")) continue;
			const outermost = node.tagName === "LI" || !node.parentElement.closest(EDITABLE);
			if (isEditMode() && outermost && !node.closest(FROZEN)) node.setAttribute("contenteditable", "plaintext-only");
			else node.removeAttribute("contenteditable");
		}
		// A checkbox inside an editable item could not be clicked.
		for (const list of markdownBody().querySelectorAll(`${NESTED_LIST}, .task-list-item-checkbox`)) {
			if (isEditMode()) list.setAttribute("contenteditable", "false");
			else list.removeAttribute("contenteditable");
		}
		if (isEditMode()) markdownBody().querySelectorAll(HOST).forEach(collapseLineBreaks);
	}

	const isList = (node) => node && (node.nodeName === "UL" || node.nodeName === "OL");

	// WHY: Chrome forces `white-space: pre-wrap` on plaintext-only hosts, and no
	// stylesheet overrides it, so the line breaks of the HTML and of soft-wrapped
	// source lines would show as empty lines. Their text keeps the same words.
	function collapseLineBreaks(host) {
		const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
		const texts = [];
		for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node);
		for (const text of texts) {
			if (text.parentElement.closest(FROZEN) || !text.nodeValue.includes("\n")) continue;
			const besideList = isList(text.parentNode) || isList(text.previousSibling) || isList(text.nextSibling);
			if (besideList && !text.nodeValue.trim()) text.remove();
			else text.nodeValue = text.nodeValue.replace(/\n/g, " ");
		}
	}

	const toggle = document.createElement("button");
	toggle.className = "lp-icon-button lp-edit-toggle";
	toggle.title = "Edit (e)";
	toggle.innerHTML = PENCIL;
	toggle.addEventListener("click", () => setEditMode(!isEditMode()));

	function setEditMode(on) {
		if (!on && E.editing) E.editing.host.blur();
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
		if ((state.host.tagName === "TD" || state.host.tagName === "TH") && !state.before.trim()) {
			const [from, to] = scopeOf(state.host, block);
			const filled = `${block.slice(0, from)} ${after.trim()} ${block.slice(to)}`;
			if (rendersAs(target, filled, after)) return { target, block: filled };
		}
		// A formatter may strip the space after an empty item's marker.
		if (state.host.tagName === "LI" && !state.before.trim()) {
			const [marker, ...rest] = block.split("\n");
			const filled = [`${marker.trimEnd()} ${after.trim()}`, ...rest].join("\n");
			if (rendersAs(target, filled, after)) return { target, block: filled };
		}
		const [from, to] = scopeOf(state.host, block);
		const scoped = patch(block.slice(from, to), state.before, changedSpan(state.before, after));
		for (const candidate of [scoped, withoutEmptyMarkup(scoped)]) {
			const patched = block.slice(0, from) + candidate + block.slice(to);
			if (rendersAs(target, patched, after)) return { target, block: patched };
		}
		return { target, attempt: block.slice(0, from) + scoped + block.slice(to) };
	}

	// A page still waiting to re-render keeps the line numbers from before a
	// write that added or removed lines; move the blocks after it along.
	function shiftLines(startLine, endLine, delta) {
		if (!delta || livepreview_heldText === null) return;
		for (const block of markdownBody().querySelectorAll("[data-source-line]")) {
			const [start, end] = lineRange(block);
			if (start > endLine) block.dataset.sourceLine = start + delta;
			if (start > endLine || (start < startLine && end >= endLine)) block.dataset.sourceEnd = end + delta;
		}
	}

	function write(target, block) {
		const { startLine, endLine } = target.where;
		const lines = Array.isArray(block) ? block : block.split("\n");
		const request = () => livepreview_request("source.replace", {
			path: currentPath(),
			start_line: startLine,
			end_line: endLine,
			expected: target.expected,
			lines,
		}).then(
			() => {
				shiftLines(startLine, endLine, lines.length - target.expected.length);
				return true;
			},
			(error) => {
				toast(error.message);
				livepreview_render(livepreview_source);
				return false;
			},
		);
		E.lastWrite = E.lastWrite.then(request);
		return E.lastWrite;
	}

	// --- Committing a block -----------------------------------------------------

	async function commit(state) {
		if (state.pending) return E.commitNew(state);
		const after = state.host.textContent;
		if (after === state.before && !isEmptiedItem(state.host, after)) return;
		await E.lastWrite;
		const { target, block, attempt, conflict } = typedSource(state, after);
		if (conflict) refuse();
		else if (isEmptiedItem(state.host, after)) await write(target, target.expected.slice(lastFilled(target.expected) + 1));
		else if (block !== undefined) await write(target, block);
		else openRaw(target, attempt);
	}

	// Clearing an item's text deletes the item, as Notion does.
	const isEmptiedItem = (host, text) => host.tagName === "LI" && !text.trim() && !host.querySelector("ul, ol");

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
		E.editing = { raw };
		const done = () => {
			E.editing = null;
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

	// --- Caret ------------------------------------------------------------------

	function caretOffset(host) {
		const selection = getSelection();
		if (!selection.rangeCount) return 0;
		const range = document.createRange();
		range.setStart(host, 0);
		range.setEnd(selection.focusNode, selection.focusOffset);
		return range.toString().length;
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

	function focusBlock(tag, line, caret) {
		const block = markdownBody().querySelector(`${tag}[data-source-line="${line}"]`);
		if (!block) return;
		block.focus();
		selectText(block, { start: caret, end: caret });
	}

	// --- Undo -------------------------------------------------------------------

	// Cmd+Z undoes the last saved edit, through Neovim's own history; typing a
	// block has not saved yet is undone by the browser instead.
	const isUndo = (event) => (event.metaKey || event.ctrlKey) && (event.key.toLowerCase() === "z" || event.key === "y");

	async function undoSaved(redo) {
		const host = E.editing && E.editing.host;
		E.editing = null;
		if (host) host.blur();
		E.clearBlocks();
		E.hideToolbar();
		await E.lastWrite;
		livepreview_request(redo ? "source.redo" : "source.undo", { path: currentPath() }).catch((error) => toast(error.message));
	}

	// --- Wiring -------------------------------------------------------------

	document.addEventListener("focusin", (event) => {
		const host = event.target.closest && event.target.closest(HOST);
		if (!host || !markdownBody().contains(host) || (E.editing && E.editing.host === host)) return;
		const anchor = host.closest("[data-source-line]");
		if (!anchor) return;
		E.editing = { host, anchor, path: pathFrom(anchor, host), before: host.textContent };
		if (host.closest("table")) E.showRowButton(host.closest("table"));
	});

	document.addEventListener("focusout", (event) => {
		const state = E.editing;
		if (!state || event.target !== state.host || E.toolbar.contains(event.relatedTarget)) return;
		E.editing = null;
		E.rowButton.hidden = true;
		if (!E.selectedBlocks.length) E.hideToolbar();
		commit(state);
		// Re-rendering now would replace the block that is taking the focus.
		const next = event.relatedTarget;
		if (!(next && next.closest && next.closest(HOST) && markdownBody().contains(next))) flushHeldRender();
	});

	function onEnter(state) {
		const host = state.host;
		if (state.pending) E.onNewBlockEnter(state);
		else if (host.tagName === "LI") E.onItemEnter(host);
		else if (host.tagName === "TD" || host.tagName === "TH") E.addRowAfter(host.parentElement, host.cellIndex);
		else if (host.parentElement === markdownBody() && /^(P|H[1-6])$/.test(host.tagName)) E.onBlockEnter(host);
		else host.blur();
	}

	document.addEventListener("keydown", (event) => {
		const state = E.editing;
		const unsaved = state && state.host && state.host.textContent !== state.before;
		const inField = event.target.closest && event.target.closest("input, textarea");
		if (isEditMode() && isUndo(event) && !unsaved && !inField) {
			event.preventDefault();
			undoSaved(event.shiftKey || event.key === "y");
			return;
		}
		if (state && event.target === state.host) {
			const kind = (event.metaKey || event.ctrlKey) && SHORTCUTS[event.shiftKey ? event.key.toUpperCase() : event.key];
			if (kind) {
				event.preventDefault();
				kind === "link" ? E.openLinkInput() : E.format(kind);
			} else if (event.key === "Enter") {
				event.preventDefault();
				onEnter(state);
			} else if (event.key === "Tab" && state.host.tagName === "LI") {
				event.preventDefault();
				E.onItemTab(state.host, event.shiftKey);
			} else if (event.key === "Escape") {
				// Like Notion: Esc leaves the text and selects its block.
				event.preventDefault();
				E.selectBlocks([state.host]);
				state.host.blur();
			}
			return;
		}
		if (E.selectedBlocks.length && event.key === "Escape") {
			event.preventDefault();
			E.clearBlocks();
			E.hideToolbar();
			return;
		}
		const typing = event.target.closest && event.target.closest("input, textarea, [contenteditable]");
		if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
		if (event.key === "e") {
			event.preventDefault();
			setEditMode(!isEditMode());
		}
	});

	// A link inside an editable block places the caret instead of navigating.
	document.addEventListener(
		"click",
		(event) => {
			if (isEditMode() && event.target.closest && event.target.closest("[contenteditable] a")) event.preventDefault();
		},
		true,
	);

	livepreview_holdRender = () => E.editing !== null || E.selectedBlocks.length > 0;
	const topbar =
		document.querySelector(".lp-topbar") ||
		document.body.appendChild(Object.assign(document.createElement("div"), { className: "lp-topbar" }));
	topbar.prepend(toggle);
	new MutationObserver(markHosts).observe(markdownBody(), { childList: true });
	setEditMode(false);

	return Object.assign(E, {
		HOST,
		markdownBody,
		isEditMode,
		normalize,
		sourceLine,
		toast,
		lineRange,
		findHost,
		rendersAs,
		typedSource,
		write,
		commit,
		refuse,
		openRaw,
		flushHeldRender,
		caretOffset,
		selectText,
		focusBlock,
	});
})();
