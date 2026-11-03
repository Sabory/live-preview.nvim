// Editing the Markdown preview in place. The page never turns HTML back into
// Markdown: each edit becomes a patch of the source lines a block came from,
// checked by rendering it again, and Neovim writes it (source.replace).
(() => {
	const PENCIL =
		'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/></svg>';
	const EDITABLE = "p, h1, h2, h3, h4, h5, h6, li, th, td";
	const FROZEN = "pre, .katex, .mermaid";

	let editing = null; // { host, anchor, path, before }

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

	function rendersAs(lines, anchor, path, text) {
		const page = document.createElement("div");
		page.innerHTML = livepreview_toHtml(lines.join("\n"));
		const [start, end] = lineRange(anchor);
		let node = page.querySelector(
			`${anchor.tagName.toLowerCase()}[data-source-line="${start}"][data-source-end="${end}"]`,
		);
		for (const index of path) node = node && node.children[index];
		return !!node && normalize(node.textContent) === normalize(text);
	}

	function replace(startLine, endLine, expected, lines) {
		return livepreview_request("source.replace", {
			path: currentPath(),
			start_line: startLine,
			end_line: endLine,
			expected,
			lines,
		}).catch((error) => {
			toast(error.message);
			livepreview_render(livepreview_source);
		});
	}

	// --- Committing a block -----------------------------------------------------

	function commit({ host, anchor, path, before }) {
		const after = host.textContent;
		if (after === before) return;
		const [startLine, endLine] = lineRange(anchor);
		const lines = livepreview_source.split("\n");
		const expected = lines.slice(startLine - 1, endLine);
		const block = expected.join("\n");
		const [from, to] = scopeOf(host, block);
		const scoped = patch(block.slice(from, to), before, changedSpan(before, after));
		const withPage = (candidate) => [...lines.slice(0, startLine - 1), ...candidate.split("\n"), ...lines.slice(endLine)];
		for (const candidate of [scoped, withoutEmptyMarkup(scoped)]) {
			const patched = block.slice(0, from) + candidate + block.slice(to);
			if (rendersAs(withPage(patched), anchor, path, after)) {
				return replace(startLine, endLine, expected, patched.split("\n"));
			}
		}
		openRaw(host, startLine, endLine, expected, block.slice(0, from) + scoped + block.slice(to));
	}

	// The patch would not render as typed: show the block's Markdown instead,
	// the way Obsidian does, and write whatever is left there.
	function openRaw(host, startLine, endLine, expected, text) {
		const raw = document.createElement("textarea");
		raw.className = "lp-raw";
		raw.value = text;
		raw.rows = text.split("\n").length;
		host.removeAttribute("contenteditable");
		host.replaceChildren(raw);
		editing = { raw };
		const done = () => {
			editing = null;
			replace(startLine, endLine, expected, raw.value.split("\n")).then(flushHeldRender);
		};
		raw.addEventListener("blur", done, { once: true });
		raw.addEventListener("keydown", (event) => {
			if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) raw.blur();
		});
		raw.focus();
	}

	function flushHeldRender() {
		if (!editing && livepreview_heldText !== null) livepreview_render(livepreview_heldText);
	}

	// --- Wiring -------------------------------------------------------------

	document.addEventListener("focusin", (event) => {
		const host = event.target.closest && event.target.closest("[contenteditable]");
		if (!host || !markdownBody().contains(host)) return;
		const anchor = host.closest("[data-source-line]");
		editing = { host, anchor, path: pathFrom(anchor, host), before: host.textContent };
	});

	document.addEventListener("focusout", (event) => {
		if (!editing || event.target !== editing.host) return;
		const current = editing;
		editing = null;
		commit(current);
		flushHeldRender();
	});

	document.addEventListener("keydown", (event) => {
		if (editing && event.target === editing.host) {
			if (event.key === "Enter" || event.key === "Escape") {
				event.preventDefault();
				editing.host.blur();
			}
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

	livepreview_holdRender = () => editing !== null;
	const topbar =
		document.querySelector(".lp-topbar") || document.body.appendChild(Object.assign(document.createElement("div"), { className: "lp-topbar" }));
	topbar.prepend(toggle);
	new MutationObserver(markHosts).observe(markdownBody(), { childList: true });
	setEditMode(false);
})();
