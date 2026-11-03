// The format toolbar: bold, italic, strikethrough, code and links over a
// selection, and turning one or several blocks into another kind of block.
(() => {
	const E = livepreview_edit;
	const { scopeOf, align } = livepreview_patch;
	const MARKS = { bold: "**", italic: "*", strike: "~~", code: "`" };

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
	async function format(kind, url, selection = E.editing && selectionIn(E.editing.host)) {
		const state = E.editing;
		if (!state || !selection) return;
		const text = state.host.textContent;
		await E.lastWrite;
		const { target, block, attempt, conflict } = E.typedSource(state, text);
		if (conflict) return E.refuse();
		if (block === undefined) return E.openRaw(target, attempt);
		const [from, to] = scopeOf(state.host, block);
		const scoped = block.slice(from, to);
		const at = align(text, scoped);
		const formatted = block.slice(0, from) + wrap(scoped, at[selection.start], at[selection.end - 1] + 1, kind, url) + block.slice(to);
		if (!E.rendersAs(target, formatted, text)) return E.openRaw(target, formatted);
		E.editing = null;
		hideToolbar();
		state.host.blur();
		if (!(await E.write(target, formatted))) return;
		const host = E.findHost(E.markdownBody(), target.where);
		if (!host) return;
		host.focus();
		E.selectText(host, selection);
	}

	// --- Turning blocks into other blocks -------------------------------------

	const unmark = (host) => host.classList.remove("lp-block-selected");

	function selectBlocks(hosts) {
		E.selectedBlocks.forEach(unmark);
		E.selectedBlocks = hosts;
		getSelection().removeAllRanges();
		hosts.forEach((host) => host.classList.add("lp-block-selected"));
		const range = document.createRange();
		range.selectNodeContents(hosts[0]);
		toolbar.classList.add("lp-format--blocks");
		showToolbarOver(range);
	}

	function clearBlocks() {
		E.selectedBlocks.forEach(unmark);
		E.selectedBlocks = [];
		toolbar.classList.remove("lp-format--blocks");
		E.flushHeldRender();
	}

	function hostsBetween(a, b) {
		const hosts = [...E.markdownBody().querySelectorAll(E.HOST)];
		const [from, to] = [hosts.indexOf(a), hosts.indexOf(b)].sort((x, y) => x - y);
		return hosts.slice(from, to + 1);
	}

	async function turnInto(kind) {
		const hosts = E.selectedBlocks.length ? E.selectedBlocks : E.editing ? [E.editing.host] : [];
		if (!hosts.length) return;
		const ranges = hosts.map((host) => E.lineRange(host.closest("[data-source-line]")));
		const startLine = Math.min(...ranges.map(([start]) => start));
		const endLine = Math.max(...ranges.map(([, end]) => end));
		const state = E.editing;
		E.editing = null;
		clearBlocks();
		hideToolbar();
		if (state) {
			state.host.blur();
			await E.commit(state);
		}
		await E.lastWrite;
		const lines = livepreview_source.split("\n");
		const expected = lines.slice(startLine - 1, endLine);
		if (!livepreview_blocks.turnable(expected)) {
			E.toast("Tables and code blocks can't be turned into other blocks");
			return E.flushHeldRender();
		}
		const result = livepreview_blocks.padded(livepreview_blocks.turnInto(kind, expected), lines[startLine - 2], lines[endLine]);
		await E.write({ where: { startLine, endLine }, expected }, result.join("\n"));
	}

	// --- The toolbar ------------------------------------------------------------

	const button = (data, label, title, onclick) => {
		const node = document.createElement("button");
		Object.assign(node.dataset, data);
		node.innerHTML = label;
		node.title = title;
		node.addEventListener("mousedown", (event) => event.preventDefault()); // keep the selection
		node.addEventListener("click", onclick);
		return node;
	};
	const formatButton = (kind, label, title) =>
		button({ format: kind }, label, title, () => (kind === "link" ? openLinkInput() : format(kind)));
	const blockButton = (kind, label, title) => button({ block: kind }, label, title, () => turnInto(kind));

	const linkInput = Object.assign(document.createElement("input"), { placeholder: "Paste a link…", hidden: true });
	const toolbar = document.createElement("div");
	toolbar.className = "lp-format";
	toolbar.hidden = true;
	toolbar.append(
		formatButton("bold", "<b>B</b>", "Bold (⌘B)"),
		formatButton("italic", "<i>I</i>", "Italic (⌘I)"),
		formatButton("strike", "<s>S</s>", "Strikethrough (⌘⇧S)"),
		formatButton("code", "<code>&lt;/&gt;</code>", "Code (⌘E)"),
		formatButton("link", "Link", "Link (⌘K)"),
		Object.assign(document.createElement("span"), { className: "lp-format-separator" }),
		blockButton("h1", "H1", "Heading 1"),
		blockButton("h2", "H2", "Heading 2"),
		blockButton("h3", "H3", "Heading 3"),
		blockButton("bullet", "•", "Bulleted list"),
		blockButton("numbered", "1.", "Numbered list"),
		blockButton("todo", "☐", "Checklist"),
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
		if (!linkInput.hidden || E.selectedBlocks.length) return;
		const selection = E.editing && E.editing.host && selectionIn(E.editing.host);
		if (!selection) return hideToolbar();
		showToolbarOver(getSelection().getRangeAt(0));
	}

	// The link input takes the focus, so the selection it applies to is kept.
	let linkSelection = null;
	function openLinkInput() {
		linkSelection = E.editing && selectionIn(E.editing.host);
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
			if (E.editing) {
				E.editing.host.focus();
				E.selectText(E.editing.host, linkSelection);
			}
		}
	});
	linkInput.addEventListener("blur", () => {
		hideToolbar();
		if (E.editing && document.activeElement !== E.editing.host) {
			const state = E.editing;
			E.editing = null;
			E.commit(state);
			E.flushHeldRender();
		}
	});

	document.addEventListener("selectionchange", () => requestAnimationFrame(placeToolbar));

	// Shift+click extends the block selection from the block being edited or selected.
	document.addEventListener(
		"mousedown",
		(event) => {
			if (!E.isEditMode() || toolbar.contains(event.target)) return;
			const host = event.target.closest && event.target.closest(E.HOST);
			const from = E.editing ? E.editing.host : E.selectedBlocks[0];
			if (event.shiftKey && host && from && E.markdownBody().contains(host) && host !== from) {
				event.preventDefault();
				selectBlocks(hostsBetween(from, host));
				if (E.editing) E.editing.host.blur();
			} else if (E.selectedBlocks.length) {
				clearBlocks();
				hideToolbar();
			}
		},
		true,
	);

	document.body.append(toolbar);
	Object.assign(E, { toolbar, format, openLinkInput, selectBlocks, clearBlocks, hideToolbar });
})();
