// Changing a document's structure while typing, as Notion does: Enter adds
// list items, paragraphs and table rows or splits a block, Tab nests items,
// typing a marker turns a paragraph into that block, and checkboxes tick.
(() => {
	const E = livepreview_edit;
	const { ITEM, align, lastFilled, markerWidth, nextMarker } = livepreview_patch;

	// Rewrites the edited block's lines, with what was typed in it, then puts the
	// caret in the block starting at `focus.line` (a list item unless `focus.tag`
	// says otherwise). `change` returns null to leave the block as it was.
	async function rewriteBlock(change) {
		const state = E.editing;
		const text = state.host.textContent;
		const caret = E.caretOffset(state.host);
		E.editing = null;
		E.hideToolbar();
		state.host.blur();
		await E.lastWrite;
		const { target, block, attempt, conflict } = E.typedSource(state, text);
		if (conflict) return E.refuse();
		if (block === undefined) return E.openRaw(target, attempt);
		const result = change(block.split("\n"), target, text, caret) || {
			lines: block.split("\n"),
			focus: { line: target.where.startLine, caret },
		};
		if (!(await E.write(target, result.lines))) return;
		E.flushHeldRender();
		E.focusBlock(result.focus.tag || "li", result.focus.line, result.focus.caret);
	}

	// The two halves of a split must render as the text on each side of the
	// caret, or the cut fell inside markup.
	function splitsCleanly(markdown, tag, text, caret) {
		const page = document.createElement("div");
		page.innerHTML = livepreview_toHtml(markdown);
		const rendered = [...page.querySelectorAll(tag)].map((node) => E.normalize(node.textContent));
		return rendered.join("\n") === [text.slice(0, caret), text.slice(caret)].map(E.normalize).join("\n");
	}

	// --- Lists -----------------------------------------------------------------

	// An item's own text, without the nested lists after it.
	const ownText = (item) =>
		[...item.childNodes]
			.filter((node) => node.nodeName !== "UL" && node.nodeName !== "OL")
			.map((node) => node.textContent)
			.join("");

	function addItem(lines, target) {
		const at = lastFilled(lines) + 1;
		return {
			lines: [...lines.slice(0, at), nextMarker(lines[0]), ...lines.slice(at)],
			focus: { line: target.where.startLine + at, caret: 0 },
		};
	}

	// Splits a one-line item at the caret, unless the cut falls inside markup.
	function splitItem([line, ...rest], target, text, caret) {
		if (rest.some((other) => other.trim())) return null;
		const match = line.match(ITEM);
		const cut = caret ? align(text, line)[caret - 1] + 1 : match[0].length;
		const halves = [line.slice(0, cut).trimEnd(), nextMarker(line) + line.slice(cut).trimStart()];
		if (!splitsCleanly(halves.join("\n"), "li", text, caret)) return null;
		return { lines: [...halves, ...rest], focus: { line: target.where.startLine + 1, caret: 0 } };
	}

	function onItemEnter(item) {
		const own = ownText(item);
		const caret = E.caretOffset(item);
		if (!item.textContent.trim()) return item.blur(); // an empty item is deleted on leaving it
		if (caret >= own.trimEnd().length) return rewriteBlock(addItem);
		if (item.querySelector("ul, ol") || own.includes("\n")) return; // only one-line items split
		rewriteBlock(splitItem);
	}

	// Tab nests the item under the one before it; Shift+Tab moves it back out.
	function onItemTab(item, outdent) {
		const parent = item.parentElement.closest("li");
		const reference = outdent ? parent : item.previousElementSibling;
		if (!reference || reference.tagName !== "LI") return;
		const width = markerWidth(E.sourceLine(parseInt(reference.dataset.sourceLine)));
		const shift = outdent
			? (line) => line.replace(new RegExp(`^ {0,${width}}`), "")
			: (line) => (line.trim() ? " ".repeat(width) + line : line);
		rewriteBlock((lines, target, text, caret) => ({
			lines: lines.map(shift),
			focus: { line: target.where.startLine, caret },
		}));
	}

	// --- Paragraphs ---------------------------------------------------------------

	// Markdown has no empty paragraph, so a new block lives only in the page
	// until it has text, which is then inserted after `afterLine` as Markdown:
	// "- " starts a list, "# " a heading.
	function openNewBlock(after, afterLine) {
		const block = document.createElement("p");
		block.className = "lp-new";
		block.dataset.placeholder = "Type, or start with - 1. > # for a list, quote or heading";
		block.setAttribute("contenteditable", "plaintext-only");
		after.after(block);
		E.editing = { host: block, pending: { afterLine }, before: "" };
		block.focus();
	}

	const insertedLines = (text, next) => ["", text, ...(next && next.trim() ? [""] : [])];

	async function commitNew({ host, pending }) {
		const text = host.textContent.trim();
		host.removeAttribute("contenteditable");
		if (!text) {
			host.remove();
			return E.flushHeldRender();
		}
		await E.lastWrite;
		const next = livepreview_source.split("\n")[pending.afterLine];
		const where = { startLine: pending.afterLine + 1, endLine: pending.afterLine };
		return E.write({ where, expected: [] }, insertedLines(text, next));
	}

	// Enter in a new block: its text is written, and the next block is another
	// new one, or the next item when the text started a list.
	async function onNewBlockEnter(state) {
		const text = state.host.textContent.trim();
		if (!text) return state.host.blur();
		E.editing = null;
		const textLine = state.pending.afterLine + 2;
		if (!ITEM.test(text)) {
			commitNew(state);
			return openNewBlock(state.host, textLine);
		}
		await commitNew(state);
		E.flushHeldRender();
		E.focusBlock("li", textLine, text.length);
		if (E.editing) rewriteBlock(addItem);
	}

	function onBlockEnter(host) {
		const caret = E.caretOffset(host);
		if (caret < host.textContent.trimEnd().length) {
			if (host.tagName === "P" && caret > 0) rewriteBlock(splitParagraph);
			return;
		}
		const state = E.editing;
		E.editing = null;
		E.commit(state);
		openNewBlock(host, E.lineRange(state.anchor)[1]);
	}

	// Splits a paragraph at the caret, unless the cut falls inside markup.
	function splitParagraph(lines, target, text, caret) {
		const block = lines.join("\n");
		const cut = align(text, block)[caret - 1] + 1;
		const halves = [block.slice(0, cut).trimEnd(), block.slice(cut).trimStart()];
		if (!splitsCleanly(halves.join("\n\n"), "p", text, caret)) return null;
		const first = halves[0].split("\n");
		return {
			lines: [...first, "", ...halves[1].split("\n")],
			focus: { tag: "p", line: target.where.startLine + first.length + 1, caret: 0 },
		};
	}

	// --- Tables -------------------------------------------------------------------

	const emptyRow = (cells) => "|" + " |".repeat(cells);

	// Adds an empty row after `row` (after the delimiter line for the header)
	// and puts the caret in its `column`.
	async function addRowAfter(row, column) {
		const state = E.editing;
		E.editing = null;
		rowButton.hidden = true;
		if (state) {
			state.host.blur();
			await E.commit(state);
		}
		await E.lastWrite;
		const line = parseInt(row.dataset.sourceLine) + (row.parentElement.tagName === "THEAD" ? 1 : 0);
		const expected = [E.sourceLine(line)];
		const where = { startLine: line, endLine: line };
		if (!(await E.write({ where, expected }, [expected[0], emptyRow(row.cells.length)]))) return;
		E.flushHeldRender();
		const cell = E.markdownBody().querySelector(`tr[data-source-line="${line + 1}"]`)?.cells[column];
		if (cell) cell.focus();
	}

	const rowButton = Object.assign(document.createElement("button"), {
		className: "lp-add-row",
		textContent: "+ Row",
		title: "Add a row at the end (Enter adds one below the cell)",
		hidden: true,
	});
	rowButton.addEventListener("mousedown", (event) => event.preventDefault()); // keep the cell's edit
	rowButton.addEventListener("click", () => {
		const table = E.editing && E.editing.host.closest("table");
		if (table) addRowAfter(table.rows[table.rows.length - 1], 0);
	});

	function showRowButton(table) {
		const rect = table.getBoundingClientRect();
		rowButton.hidden = false;
		rowButton.style.top = `${rect.bottom + window.scrollY + 4}px`;
		rowButton.style.left = `${rect.left + window.scrollX}px`;
	}

	// --- Markdown shortcuts -------------------------------------------------------

	// Typed at the start of a paragraph, a marker and a space turn it into that
	// block, as Notion does; the marker is not written as text.
	const SHORTCUT = /^(#{1,3}|[-*]|1\.|>|\[\]) /;
	const SHORTCUT_KIND = { "#": "h1", "##": "h2", "###": "h3", "-": "bullet", "*": "bullet", "1.": "numbered", ">": "quote", "[]": "todo" };
	const KIND_TAG = { h1: "h1", h2: "h2", h3: "h3", bullet: "li", numbered: "li", todo: "li", quote: "p" };

	function onShortcutTyped(host) {
		if (host.tagName !== "P" || host.parentElement !== E.markdownBody()) return;
		const match = host.textContent.match(SHORTCUT);
		if (match && E.caretOffset(host) === match[0].length) {
			applyShortcut(SHORTCUT_KIND[match[1]], host.textContent.slice(match[0].length));
		}
	}

	async function applyShortcut(kind, rest) {
		const state = E.editing;
		E.editing = null;
		E.hideToolbar();
		state.host.blur();
		await E.lastWrite;
		const { target, block, attempt, conflict } = E.typedSource(state, rest);
		if (conflict) return E.refuse();
		if (block === undefined) return E.openRaw(target, attempt);
		if (!(await E.write(target, livepreview_blocks.turnInto(kind, block.split("\n"))))) return;
		E.flushHeldRender();
		E.focusBlock(KIND_TAG[kind], target.where.startLine, 0);
	}

	// --- Checklists ---------------------------------------------------------------

	// A click on a checkbox ticks the item in the source, in or out of edit mode.
	async function toggleTask(box) {
		const line = parseInt(box.closest("li").dataset.sourceLine);
		await E.lastWrite;
		const expected = [E.sourceLine(line)];
		const ticked = expected[0].replace(/\[([ xX])\]/, (_, mark) => (mark === " " ? "[x]" : "[ ]"));
		E.write({ where: { startLine: line, endLine: line }, expected }, [ticked]);
	}

	document.addEventListener("input", (event) => {
		const state = E.editing;
		if (state && event.target === state.host && !state.pending) onShortcutTyped(state.host);
	});

	document.addEventListener("change", (event) => {
		if (event.target.matches && event.target.matches(".markdown-body .task-list-item-checkbox")) toggleTask(event.target);
	});

	document.body.append(rowButton);
	Object.assign(E, { onItemEnter, onItemTab, onNewBlockEnter, onBlockEnter, commitNew, addRowAfter, rowButton, showRowButton });
})();
