// End-to-end tests: `make e2e`, or `node tests/e2e/run.mjs [name filter]`.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assert, sleep, startBrowser, startNvim, until, ORIGIN } from "./lib.mjs";

const selectAndComment = (selector, from, to) => `(() => {
	const text = document.querySelector(${JSON.stringify(selector)}).firstChild;
	const range = document.createRange();
	range.setStart(text, ${from});
	range.setEnd(text, ${to});
	getSelection().removeAllRanges();
	getSelection().addRange(range);
})()`;

const EDIT_FIXTURE = `# Heading

Plain **bold** paragraph with a [link](other.md) inside.

| Name | Value |
| ---- | ----- |
| a b  | a     |
`;

const BLOCKS_FIXTURE = `# Blocks

First paragraph.

Second paragraph.

Third paragraph.

| A | B |
| - | - |
| 1 | 2 |
`;

const LIST_FIXTURE = `# List

- one
- two

1. first

Para after.
`;

// Focuses an editable block and puts the caret `offset` characters into its
// first text, or at its end with -1.
const caretAt = (selector, offset) => `(() => {
	const host = document.querySelector(${JSON.stringify(selector)});
	host.focus();
	const text = document.createTreeWalker(host, NodeFilter.SHOW_TEXT).nextNode();
	const range = document.createRange();
	range.setStart(text, ${offset} < 0 ? text.length : ${offset});
	getSelection().removeAllRanges();
	getSelection().addRange(range);
	return true;
})()`;

// Clicks like a user: the event goes through the page's own handlers.
async function clickOn(browser, selector, modifiers = 0) {
	const [x, y] = await browser.js(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
	for (const type of ["mousePressed", "mouseReleased"]) {
		await browser.cdp("Input.dispatchMouseEvent", { type, x, y, modifiers, button: "left", clickCount: 1 });
	}
}

const META = 4;
const SHIFT = 8;
const KEY_CODES = { Enter: 13, Tab: 9 };
const press = async (browser, key, code = key, modifiers = 0) => {
	for (const type of ["keyDown", "keyUp"]) {
		await browser.cdp("Input.dispatchKeyEvent", { type, key, code, modifiers, windowsVirtualKeyCode: KEY_CODES[key] || 0 });
	}
};

// Focuses the editable block and selects `needle` in it, as a double click would.
const selectIn = (selector, needle) => `(() => {
	const host = document.querySelector(${JSON.stringify(selector)});
	host.focus();
	const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const at = node.nodeValue.indexOf(${JSON.stringify(needle)});
		if (at < 0) continue;
		const range = document.createRange();
		range.setStart(node, at);
		range.setEnd(node, at + ${needle.length});
		getSelection().removeAllRanges();
		getSelection().addRange(range);
		return true;
	}
	return false;
})()`;

// Text the page shows right after typing is what was typed: only the source it
// received from Neovim proves the edit made the round trip.
const received = (browser, text) => until(() => browser.js(`livepreview_source.includes(${JSON.stringify(text)})`), `the page to receive "${text}"`);

// The format toolbar moves to a new selection on the next animation frame.
const nextFrames = (browser) => browser.js(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))`);

// Leaving a block, as a click elsewhere does, is what saves it: Enter splits
// a paragraph or adds a block, the way Notion does.
const leave = (browser) => browser.js(`document.activeElement.blur()`);

async function retype(browser, selector, needle, text) {
	assert(await browser.js(selectIn(selector, needle)), `"${needle}" in ${selector}`);
	await browser.cdp("Input.insertText", { text });
	await leave(browser);
}

// Neovim writes a new file and renames it over the old one, so a read can land in between.
function readLines(file) {
	try {
		return readFileSync(file, "utf8").split("\n");
	} catch {
		return [];
	}
}

function socketClient() {
	const socket = new WebSocket(ORIGIN.replace("http", "ws"));
	const inbox = [];
	const replies = new Map();
	let lastId = 0;
	socket.onmessage = (event) => {
		const message = JSON.parse(event.data);
		if (message.type === "reply") replies.get(message.request_id)(message);
		else inbox.push(message);
	};
	return {
		inbox,
		opened: new Promise((resolve) => (socket.onopen = resolve)),
		send: (message) => socket.send(JSON.stringify(message)),
		request: (type, payload = {}) =>
			new Promise((resolve) => {
				const request_id = ++lastId;
				replies.set(request_id, resolve);
				socket.send(JSON.stringify({ ...payload, type, request_id }));
			}),
		close: () => socket.close(),
	};
}

const tests = {
	async "server: comment requests, reveal and navigation"({ nvim }) {
		const client = socketClient();
		await client.opened;
		assert(((await client.request("comments.list")).result?.length ?? 0) === 0, "starts with no comments");
		const added = await client.request("comment.add", { path: "/a.md", start_line: 8, end_line: 9, text: "hi", quote: "First" });
		assert(added.result === 1, `add returns the id: ${JSON.stringify(added)}`);
		await until(() => client.inbox.some((m) => m.type === "comments"), "a comments broadcast");
		const [listed] = (await client.request("comments.list")).result;
		assert(listed.path === "/a.md" && listed.quote === "First" && listed.start_line === 8, `listed: ${JSON.stringify(listed)}`);
		await client.request("comment.edit", { id: 1, text: "edited" });
		assert(nvim.lua(`return _G.COMMENTS[1].text`) === "edited", "edit reaches the provider");
		await client.request("comments.send", { ids: [1], submit: true });
		const [sent] = nvim.lua(`return _G.SENT`);
		assert(sent.submit === true && sent.ids[0] === 1, `send: ${JSON.stringify(sent)}`);
		assert((await client.request("comment.edit", { id: 99, text: "x" })).error, "provider errors are replied");
		await client.request("comment.delete", { id: 1 });
		assert(nvim.lua(`return vim.tbl_count(_G.COMMENTS)`) === 0, "delete reaches the provider");

		client.send({ type: "reveal", path: "/a.md", line: 11 });
		await until(() => nvim.expr("line('.')") === "11", "reveal to move the cursor");

		client.inbox.length = 0;
		nvim.keys(":e other.md<CR>");
		await until(() => client.inbox.some((m) => m.type === "navigate" && m.path === "/other.md"), "a navigate message");
		client.send({ type: "open", path: "/a.md" });
		await until(() => nvim.expr("expand('%:t')") === "a.md", "open to move the source window");
		client.close();
	},

	async "server: replace source lines and write them to disk"({ nvim }) {
		const client = socketClient();
		await client.opened;
		const file = join(nvim.root, "a.md");
		const before = readFileSync(file, "utf8").split("\n");
		const replaced = await client.request("source.replace", {
			path: "/a.md",
			start_line: 6,
			end_line: 6,
			expected: [before[5]],
			lines: ["# Renamed"],
		});
		assert(!replaced.error, `replace: ${replaced.error}`);
		assert(readFileSync(file, "utf8").split("\n")[5] === "# Renamed", "the line is written to disk");
		assert(nvim.expr("&modified") === "0", "the buffer is saved");
		await until(() => client.inbox.some((m) => m.type === "update" && m.content.includes("# Renamed")), "an update broadcast");

		const inserted = await client.request("source.replace", { path: "/a.md", start_line: 7, end_line: 6, expected: [], lines: ["new"] });
		assert(!inserted.error && readFileSync(file, "utf8").split("\n")[6] === "new", `insert before a line: ${inserted.error}`);

		const stale = await client.request("source.replace", { path: "/a.md", start_line: 6, end_line: 6, expected: [before[5]], lines: ["x"] });
		assert(stale.error?.includes("changed"), `stale lines are refused: ${JSON.stringify(stale)}`);
		assert(readFileSync(file, "utf8").split("\n")[5] === "# Renamed", "a refused edit writes nothing");

		const hidden = await client.request("source.replace", { path: "/other.md", start_line: 1, end_line: 0, expected: [], lines: ["top"] });
		assert(!hidden.error && readFileSync(join(nvim.root, "other.md"), "utf8").startsWith("top\n"), `a file not open in Neovim: ${hidden.error}`);
		client.close();
	},

	async "edit: reword a paragraph, a header and a table cell"({ nvim, browser }) {
		const file = join(nvim.root, "edit.md");
		writeFileSync(file, EDIT_FIXTURE);
		const line = (n) => readLines(file)[n - 1] ?? "";
		await browser.open("/edit.md");
		await clickOn(browser, ".lp-edit-toggle");
		assert(await browser.js(`document.querySelector("p").getAttribute("contenteditable") === "plaintext-only"`), "the pencil makes blocks editable");

		await retype(browser, "p", "paragraph", "sentence");
		await until(() => line(3) === "Plain **bold** sentence with a [link](other.md) inside.", `a reworded paragraph: ${line(3)}`);
		await received(browser, "sentence");

		await retype(browser, "h1", "Heading", "Encabezado");
		await until(() => line(1) === "# Encabezado", `a changed header: ${line(1)}`);

		await retype(browser, "tbody td:nth-child(2)", "a", "z");
		await until(() => line(7) === "| a b  | z     |", `the second cell, not the first "a": ${line(7)}`);

		await received(browser, "| z ");
		await retype(browser, "p", "link", "enlace");
		await until(() => line(3) === "Plain **bold** sentence with a [enlace](other.md) inside.", `text inside a link: ${line(3)}`);

		await received(browser, "[enlace]");
		await retype(browser, "p", "bold", "");
		await until(() => line(3) === "Plain  sentence with a [enlace](other.md) inside.", `emptied bold drops its markers: ${line(3)}`);

		await received(browser, "Plain  sentence");
		await retype(browser, "p", "Plain", "Simple");
		await retype(browser, "p", "sentence", "frase");
		await until(() => line(3) === "Simple  frase with a [enlace](other.md) inside.", `two edits in a row, the second before the first renders: ${line(3)}`);
		assert(browser.errors.length === 0, `page errors: ${browser.errors}`);
	},

	async "edit: fall back to Markdown, refuse stale lines, hold updates"({ nvim, browser }) {
		const file = join(nvim.root, "edit.md");
		writeFileSync(file, EDIT_FIXTURE);
		const line = (n) => readLines(file)[n - 1] ?? "";
		await browser.open("/edit.md");
		await press(browser, "e");
		assert(await browser.js(`document.body.classList.contains("lp-edit-mode")`), "e turns on edit mode");

		await retype(browser, "h1", "Heading", "2*3*4");
		await until(() => browser.js(`document.querySelector(".lp-raw")?.value === "# 2*3*4"`), "Markdown that would not render as typed opens raw");
		assert(line(1) === "# Heading", "nothing is written before the raw edit ends");
		await browser.js(`(() => { const raw = document.querySelector(".lp-raw"); raw.value = ${JSON.stringify("# 2\\*3\\*4")}; raw.blur(); })()`);
		await until(() => line(1) === "# 2\\*3\\*4", `the raw edit is written: ${line(1)}`);
		await until(() => browser.js(`document.querySelector("h1").textContent === "2*3*4"`), "the escaped header to render");

		assert(await browser.js(selectIn("p", "paragraph")), "focus the paragraph");
		await browser.cdp("Input.insertText", { text: "typed" });
		const client = socketClient();
		await client.opened;
		await client.request("source.replace", { path: "/edit.md", start_line: 7, end_line: 7, expected: ["| a b  | a     |"], lines: ["| c    | d     |"] });
		await sleep(300);
		assert(await browser.js(`document.querySelector("p").textContent.includes("typed")`), "an update waits while a block is edited");
		await leave(browser);
		await until(() => line(3).includes("typed") && line(7) === "| c    | d     |", "both edits on disk");
		await until(() => browser.js(`document.querySelector("tbody td").textContent === "c"`), "the held update renders after the edit");

		assert(await browser.js(selectIn("p", "Plain")), "focus the paragraph again");
		nvim.lua(`local b = vim.fn.bufadd("${file}"); vim.fn.bufload(b); vim.api.nvim_buf_set_lines(b, 2, 3, true, { "from nvim" }); vim.api.nvim_buf_call(b, function() vim.cmd("silent write") end); return true`);
		await browser.cdp("Input.insertText", { text: "Stale" });
		await leave(browser);
		await until(() => browser.js(`document.querySelector(".lp-toast--error")?.textContent.includes("changed")`), "a refused edit is reported");
		assert(line(3) === "from nvim", `a stale edit writes nothing: ${line(3)}`);
		client.close();
	},

	async "edit: format a selection from the toolbar and shortcuts"({ nvim, browser }) {
		const file = join(nvim.root, "edit.md");
		writeFileSync(file, EDIT_FIXTURE);
		const line = (n) => readLines(file)[n - 1] ?? "";
		const original = EDIT_FIXTURE.split("\n")[2];
		await browser.open("/edit.md");
		await press(browser, "e");

		assert(await browser.js(selectIn("p", "paragraph")), "select a word");
		await until(() => browser.js(`!document.querySelector(".lp-format").hidden`), "the toolbar over the selection");
		await press(browser, "b", "KeyB", META);
		await until(() => line(3) === "Plain **bold** **paragraph** with a [link](other.md) inside.", `bold: ${line(3)}`);
		await until(
			() => browser.js(`document.activeElement === document.querySelector("p") && getSelection().toString() === "paragraph"`),
			"the selection to stay on the formatted words",
		);
		await press(browser, "b", "KeyB", META);
		await until(() => line(3) === original, `bold toggles off: ${line(3)}`);
		await until(() => browser.js(`document.querySelectorAll("p strong").length === 1`), "the unbolded render");

		assert(await browser.js(selectIn("p", "Plain")), "select the first word");
		await nextFrames(browser);
		await clickOn(browser, '.lp-format [data-format="italic"]');
		await until(() => line(3).startsWith("*Plain* **bold**"), `italic: ${line(3)}`);
		await until(() => browser.js(`!!document.querySelector("p em")`), "the italic render");

		assert(await browser.js(selectIn("p", "with")), "select another word");
		await press(browser, "S", "KeyS", META | SHIFT);
		await until(() => line(3).includes(" ~~with~~ "), `strikethrough: ${line(3)}`);
		await until(() => browser.js(`!!document.querySelector("p s")`), "the strikethrough render");

		assert(await browser.js(selectIn("h1", "Heading")), "select the header");
		await nextFrames(browser);
		await clickOn(browser, '.lp-format [data-format="code"]');
		await until(() => line(1) === "# `Heading`", `code: ${line(1)}`);
		await until(() => browser.js(`!!document.querySelector("h1 code")`), "the code render");

		assert(await browser.js(selectIn("p", "inside")), "select the word to link");
		await press(browser, "k", "KeyK", META);
		await until(() => browser.js(`document.activeElement === document.querySelector(".lp-format input")`), "the link input");
		await browser.cdp("Input.insertText", { text: "https://example.com" });
		await press(browser, "Enter");
		await until(() => line(3).endsWith(" [inside](https://example.com)."), `link: ${line(3)}`);
		await until(() => browser.js(`!!document.querySelector('p a[href="https://example.com"]')`), "the link render");

		assert(await browser.js(selectIn("tbody td", "a b")), "select a cell's text");
		await browser.cdp("Input.insertText", { text: "uno dos" });
		assert(await browser.js(selectIn("tbody td", "uno")), "select a typed word");
		await press(browser, "b", "KeyB", META);
		await until(() => line(7) === "| **uno** dos  | a     |", `typed text and its format in one write: ${line(7)}`);
		assert(browser.errors.length === 0, `page errors: ${browser.errors}`);
	},

	async "edit: turn blocks into quotes, lists and headings"({ nvim, browser }) {
		const file = join(nvim.root, "blocks.md");
		writeFileSync(file, BLOCKS_FIXTURE);
		const source = () => readLines(file).join("\n");
		const paragraph = (n) => `.markdown-body > p:nth-of-type(${n})`;
		const turn = async (kind) => {
			await nextFrames(browser);
			await clickOn(browser, `.lp-format [data-block="${kind}"]`);
		};
		await browser.open("/blocks.md");
		await press(browser, "e");

		assert(await browser.js(selectIn(paragraph(1), "First")), "select in the first paragraph");
		await turn("quote");
		await until(() => source().includes("\n> First paragraph.\n"), `a quote: ${source()}`);
		await received(browser, "> First");
		assert(await browser.js(selectIn("blockquote p", "First")), "select in the quote");
		await turn("quote");
		await until(() => source() === BLOCKS_FIXTURE, `the quote toggles off: ${source()}`);
		await until(() => browser.js(`!livepreview_source.includes("> First")`), "the page to receive the unquoted text");

		assert(await browser.js(selectIn(paragraph(2), "Second")), "select in the second paragraph");
		await turn("h2");
		await until(() => source().includes("\n## Second paragraph.\n"), `a heading: ${source()}`);
		await received(browser, "## Second");
		assert(await browser.js(selectIn("h2", "Second")), "select in the heading");
		await turn("h2");
		await until(() => source() === BLOCKS_FIXTURE, `the heading toggles off: ${source()}`);
		await until(() => browser.js(`!livepreview_source.includes("## Second")`), "the page to receive the plain text");

		assert(await browser.js(selectIn(paragraph(1), "First")), "focus the first paragraph");
		await press(browser, "Escape");
		await until(() => browser.js(`document.querySelectorAll(".lp-block-selected").length === 1`), "Esc to select the block");
		await clickOn(browser, paragraph(3), SHIFT);
		await until(() => browser.js(`document.querySelectorAll(".lp-block-selected").length === 3`), "Shift+click to extend the selection");
		assert(await browser.js(`document.querySelector(".lp-format").classList.contains("lp-format--blocks")`), "only block actions for several blocks");
		await turn("bullet");
		await until(() => source().includes("\n- First paragraph.\n- Second paragraph.\n- Third paragraph.\n\n| A"), `paragraphs into one list: ${source()}`);
		await received(browser, "- Third");

		assert(await browser.js(selectIn("li", "First")), "focus the first item");
		await press(browser, "Escape");
		await clickOn(browser, "li:last-child", SHIFT);
		await until(() => browser.js(`document.querySelectorAll(".lp-block-selected").length === 3`), "the three items");
		await turn("numbered");
		await until(() => source().includes("\n1. First paragraph.\n2. Second paragraph.\n3. Third paragraph.\n"), `a numbered list: ${source()}`);
		await received(browser, "3. Third");

		assert(await browser.js(selectIn("li:last-child", "Third")), "focus the last item");
		await press(browser, "Escape");
		await clickOn(browser, "tbody td", SHIFT);
		await turn("quote");
		await until(() => browser.js(`document.querySelector(".lp-toast--error")?.textContent.includes("Tables")`), "a table is refused");
		assert(source().includes("\n3. Third paragraph.\n\n| A | B |"), `nothing written: ${source()}`);
		assert(browser.errors.length === 0, `page errors: ${browser.errors}`);
	},

	async "edit: add, split, nest and delete list items"({ nvim, browser }) {
		const file = join(nvim.root, "list.md");
		writeFileSync(file, LIST_FIXTURE);
		const source = () => readLines(file).join("\n");
		const focusedItem = (text) => browser.js(`document.activeElement.tagName === "LI" && document.activeElement.textContent === ${JSON.stringify(text)}`);
		await browser.open("/list.md");
		await press(browser, "e");

		await browser.js(caretAt(".markdown-body > ul > li:nth-child(2)", -1));
		await press(browser, "Enter");
		await until(() => /\n- two\n- ?\n/.test(source()), `Enter at the end adds an item: ${source()}`);
		await until(() => focusedItem(""), "the caret in the new item");
		await browser.cdp("Input.insertText", { text: "three" });
		await press(browser, "Enter");
		await until(() => /\n- three\n- ?\n/.test(source()), `typing fills it, Enter adds the next: ${source()}`);
		await until(() => focusedItem(""), "the caret in the next item");
		await press(browser, "Enter");
		await until(() => source() === LIST_FIXTURE.replace("- two\n", "- two\n- three\n"), `Enter on an empty item deletes it: ${source()}`);
		await received(browser, "- three\n\n");

		await browser.js(caretAt("ol > li", -1));
		await press(browser, "Enter");
		await until(() => /\n1\. first\n2\. ?\n/.test(source()), `a numbered item continues the count: ${source()}`);
		await until(() => focusedItem(""), "the caret in the numbered item");
		await browser.cdp("Input.insertText", { text: "second" });
		await browser.js(`document.activeElement.blur()`);
		await until(() => source().includes("\n1. first\n2. second\n"), `the numbered item is written: ${source()}`);
		await received(browser, "2. second");

		await browser.js(caretAt(".markdown-body > ul > li:nth-child(2)", -1));
		await press(browser, "Tab");
		await until(() => source().includes("\n- one\n  - two\n- three\n"), `Tab nests the item: ${source()}`);
		await until(() => focusedItem("two"), "the caret stays in the nested item");
		await press(browser, "Tab", "Tab", SHIFT);
		await until(() => source().includes("\n- one\n- two\n- three\n"), `Shift+Tab moves it back: ${source()}`);
		await until(() => focusedItem("two"), "the caret stays in the item");

		await browser.js(caretAt(".markdown-body > ul > li:nth-child(3)", 2));
		await press(browser, "Enter");
		await until(() => source().includes("\n- th\n- ree\n"), `Enter in the middle splits the item: ${source()}`);
		await until(() => focusedItem("ree"), "the caret in the second half");

		assert(await browser.js(selectIn(".markdown-body > ul > li:nth-child(4)", "ree")), "select the item's text");
		await browser.cdp("Input.insertText", { text: "" });
		await browser.js(`document.activeElement.blur()`);
		await until(() => source().includes("\n- two\n- th\n\n1. first"), `clearing an item deletes it: ${source()}`);
		assert(browser.errors.length === 0, `page errors: ${browser.errors}`);
	},

	async "edit: new paragraphs, a list in a new paragraph, and splits"({ nvim, browser }) {
		const file = join(nvim.root, "para.md");
		const original = "# Notes\n\nAlpha beta gamma.\n\nLast line.\n";
		writeFileSync(file, original);
		const source = () => readLines(file).join("\n");
		const active = (text) => browser.js(`document.activeElement.textContent === ${JSON.stringify(text)}`);
		await browser.open("/para.md");
		await press(browser, "e");

		await browser.js(caretAt(".markdown-body > p", -1));
		await press(browser, "Enter");
		await until(() => browser.js(`document.activeElement.classList.contains("lp-new")`), "Enter at the end opens a new block");
		assert(source() === original, "an empty new block writes nothing");
		await browser.cdp("Input.insertText", { text: "New paragraph." });
		await press(browser, "Enter");
		await until(() => source().includes("\nAlpha beta gamma.\n\nNew paragraph.\n\nLast line."), `the new paragraph: ${source()}`);
		await until(() => browser.js(`document.activeElement.classList.contains("lp-new") && document.activeElement.textContent === ""`), "Enter opens the next new block");

		await browser.cdp("Input.insertText", { text: "- uno" });
		await press(browser, "Enter");
		await until(() => /\nNew paragraph\.\n\n- uno\n- ?\n\nLast line\./.test(source()), `a list typed in a new block continues as items: ${source()}`);
		await until(() => browser.js(`document.activeElement.tagName === "LI" && document.activeElement.textContent === ""`), "the caret in the next item");
		await browser.cdp("Input.insertText", { text: "dos" });
		await browser.js(`document.activeElement.blur()`);
		await until(() => source().includes("\n- uno\n- dos\n\nLast line."), `the second item: ${source()}`);
		await received(browser, "- dos");

		await browser.js(caretAt(".markdown-body > p", 6));
		await press(browser, "Enter");
		await until(() => source().startsWith("# Notes\n\nAlpha\n\nbeta gamma.\n\nNew paragraph."), `Enter in the middle splits the paragraph: ${source()}`);
		await until(() => active("beta gamma."), "the caret in the second half");
		await received(browser, "\nbeta gamma.");

		const before = source();
		await browser.js(caretAt(".markdown-body > p:last-of-type", -1));
		await press(browser, "Enter");
		await browser.js(`document.activeElement.blur()`);
		await until(() => browser.js(`!document.querySelector(".lp-new")`), "an empty new block goes away");
		assert(source() === before, `and writes nothing: ${source()}`);
		assert(browser.errors.length === 0, `page errors: ${browser.errors}`);
	},

	async "edit: add table rows with Enter and the row button"({ nvim, browser }) {
		const file = join(nvim.root, "table.md");
		writeFileSync(file, "# T\n\n| Tipo | Monto |\n| ---- | ----- |\n| Normal | 100 |\n\nFin.\n");
		const source = () => readLines(file).join("\n");
		const activeCell = (row, column) => browser.js(`document.activeElement === document.querySelectorAll("tr")[${row}]?.cells[${column}]`);
		await browser.open("/table.md");
		await press(browser, "e");

		await browser.js(`document.querySelector("tbody td:nth-child(2)").focus()`);
		assert(await browser.js(`!document.querySelector(".lp-add-row").hidden`), "the row button shows while a cell is edited");
		await press(browser, "Enter");
		await until(() => source().includes("\n| Normal | 100 |\n| | |\n\nFin."), `Enter adds a row below: ${source()}`);
		await until(() => activeCell(2, 1), "the caret in the same column of the new row");
		await browser.cdp("Input.insertText", { text: "50" });
		await leave(browser);
		await until(() => source().includes("\n| | 50 |\n"), `typing fills the empty cell: ${source()}`);
		await received(browser, "| 50 |");

		await browser.js(`document.querySelector("thead th").focus()`);
		await press(browser, "Enter");
		await until(() => source().includes("\n| ---- | ----- |\n| | |\n| Normal"), `Enter in the header adds the first row: ${source()}`);
		await until(() => activeCell(1, 0), "the caret in the first new row");
		await browser.cdp("Input.insertText", { text: "Rezago" });
		await clickOn(browser, ".lp-add-row");
		await until(() => source().includes("\n| Rezago | |\n| Normal | 100 |\n| | 50 |\n| | |\n\nFin."), `the button adds a row at the end and keeps the typed cell: ${source()}`);
		await until(() => activeCell(4, 0), "the caret in the last row");
		assert(browser.errors.length === 0, `page errors: ${browser.errors}`);
	},

	async "edit: Markdown shortcuts at the start of a paragraph"({ nvim, browser }) {
		const file = join(nvim.root, "shortcuts.md");
		writeFileSync(file, "# S\n\nfirst **bold**\n\nsecond\n\nthird\n\nfourth\n");
		const source = () => readLines(file).join("\n");
		// One key at a time, as typed: the shortcut fires on the space.
		const typeAtStart = async (selector, keys) => {
			await browser.js(caretAt(selector, 0));
			for (const key of keys) await browser.cdp("Input.insertText", { text: key });
		};
		const focused = (tag, text) => browser.js(`document.activeElement.tagName === "${tag}" && document.activeElement.textContent === ${JSON.stringify(text)}`);
		await browser.open("/shortcuts.md");
		await press(browser, "e");

		await typeAtStart(".markdown-body > p", "## ");
		await until(() => source().includes("\n## first **bold**\n"), `## makes a heading and keeps the markup: ${source()}`);
		await until(() => focused("H2", "first bold"), "the caret in the heading");
		await typeAtStart(".markdown-body > p", "- ");
		await until(() => source().includes("\n- second\n"), `- makes a list: ${source()}`);
		await until(() => focused("LI", "second"), "the caret in the item");
		await typeAtStart(".markdown-body > p", "1. ");
		await until(() => source().includes("\n1. third\n"), `1. makes a numbered list: ${source()}`);
		await typeAtStart(".markdown-body > p", "> ");
		await until(() => source().includes("\n> fourth\n"), `> makes a quote: ${source()}`);
		await until(() => focused("P", "fourth"), "the caret in the quote");
		await browser.cdp("Input.insertText", { text: "!" });
		await leave(browser);
		await until(() => source().includes("\n> !fourth\n"), `typing goes on in the quote: ${source()}`);
		assert(browser.errors.length === 0, `page errors: ${browser.errors}`);
	},

	async "edit: Cmd+Z undoes and redoes saved edits"({ nvim, browser }) {
		const file = join(nvim.root, "undo.md");
		writeFileSync(file, "# U\n\nOne two.\n");
		const line = () => readLines(file)[2] ?? "";
		await browser.open("/undo.md");
		await press(browser, "e");

		await retype(browser, "p", "two", "three");
		await until(() => line() === "One three.", `the edit: ${line()}`);
		await received(browser, "One three.");
		await press(browser, "z", "KeyZ", META);
		await until(() => line() === "One two.", `Cmd+Z undoes it on disk: ${line()}`);
		await until(() => browser.js(`document.querySelector("p").textContent === "One two."`), "the page to show the undone text");
		await press(browser, "z", "KeyZ", META | SHIFT);
		await until(() => line() === "One three.", `Cmd+Shift+Z redoes it: ${line()}`);
		await received(browser, "One three.");

		assert(await browser.js(selectIn("p", "One")), "select a word");
		await press(browser, "b", "KeyB", META);
		await until(() => line() === "**One** three.", `bold: ${line()}`);
		await until(() => browser.js(`document.activeElement === document.querySelector("p")`), "the caret back in the block");
		await press(browser, "z", "KeyZ", META);
		await until(() => line() === "One three.", `Cmd+Z in a block with nothing unsaved undoes the format: ${line()}`);
		await received(browser, "\nOne three.");

		await browser.js(caretAt("p", -1));
		await browser.cdp("Input.insertText", { text: "!!" });
		await press(browser, "z", "KeyZ", META);
		await sleep(400);
		assert(line() === "One three.", `unsaved typing is left to the browser's undo: ${line()}`);
		await leave(browser);
		await until(() => line().startsWith("One three."), "leaving saves what is left");
		await sleep(300);
		await press(browser, "z", "KeyZ", META | SHIFT);
		await until(() => browser.js(`document.querySelector(".lp-toast--error")?.textContent.includes("nothing to redo")`), "nothing to redo is reported");
		assert(browser.errors.length === 0, `page errors: ${browser.errors}`);
	},

	async "render: front matter, line ranges and alerts"({ browser }) {
		await browser.open("/a.md");
		const blocks = await browser.js(`JSON.stringify([...document.querySelector(".markdown-body").children].map((e) => [e.tagName, e.dataset.sourceLine, e.dataset.sourceEnd]))`);
		assert(blocks.startsWith(`[["H1","6","6"],["P","8","9"],["UL"`), `front matter hidden, blocks keep lines: ${blocks}`);
		await browser.open("/alerts.md");
		const alerts = await browser.js(`JSON.stringify([...document.querySelectorAll(".markdown-body > div, .markdown-body > blockquote")].map((e) => e.className.split(" ")[1] || e.tagName))`);
		assert(alerts === `["markdown-alert-note","markdown-alert-tip","markdown-alert-important","markdown-alert-warning","markdown-alert-caution","BLOCKQUOTE"]`, `alerts: ${alerts}`);
		assert(await browser.js(`!document.body.textContent.includes("[!")`), "no alert marker is left");
		assert(browser.errors.length === 0, `page errors: ${browser.errors}`);
	},

	async "comments: select, comment, highlight, edit, delete, send"({ nvim, browser }) {
		await browser.open("/a.md");
		await browser.js(selectAndComment("p[data-source-line]", 6, 15));
		await until(() => browser.js(`!document.querySelector(".lp-selection-button").hidden`), "the selection button");
		await browser.js(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }))`);
		await browser.js(`(() => { const t = document.querySelector(".lp-composer textarea"); t.value = "Clarify"; t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
		await until(() => browser.js(`document.querySelector(".lp-count").textContent === "1"`), "the comment count");
		const stored = nvim.lua(`local c = _G.COMMENTS[1]; return { c.start_line, c.end_line, c.text }`);
		assert(JSON.stringify(stored) === `[8,9,"Clarify"]`, `stored: ${JSON.stringify(stored)}`);
		assert((await browser.js(`[...CSS.highlights.get("lp-comment")][0].toString()`)) === "paragraph", "the quote is highlighted");

		nvim.lua(`local id = 2; _G.COMMENTS[id] = { id = id, file = vim.api.nvim_buf_get_name(0), start_line = 11, end_line = 11, text = "from nvim" }; require("livepreview").refresh_comments(); return true`);
		await until(() => browser.js(`document.querySelectorAll(".lp-commented").length === 1`), "a comment made in Neovim");
		nvim.keys("6GA!<Esc>");
		await until(() => browser.js(`document.querySelector("h1").textContent === "Title!"`), "the live update");
		assert((await browser.js(`CSS.highlights.get("lp-comment")?.size`)) === 1, "highlights survive a re-render");

		await browser.js(`document.querySelector(".lp-topbar .lp-icon-button").click()`);
		await browser.js(`[...document.querySelectorAll(".lp-card")].find((c) => c.textContent.includes("Clarify")).querySelector(".lp-card-actions button").click()`);
		await sleep(100);
		await browser.js(`(() => { const t = document.querySelector(".lp-card textarea"); t.value = "Clarify, please"; t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
		await until(() => nvim.lua(`return _G.COMMENTS[1].text`) === "Clarify, please", "an edit from the panel");
		await browser.js(`[...[...document.querySelectorAll(".lp-card")].find((c) => c.textContent.includes("from nvim")).querySelectorAll("button")].find((b) => b.textContent === "Delete").click()`);
		await until(() => nvim.lua(`return _G.COMMENTS[2] == nil`), "a delete from the panel");
		await browser.js(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "S", bubbles: true }))`);
		await until(() => nvim.lua(`return #_G.SENT`) === 1, "S to send them all");
		assert(nvim.lua(`return _G.SENT[1].submit`) === true, "S submits");
	},

	async "hunks: bars for added, changed and deleted lines"({ nvim, browser }) {
		await browser.open("/a.md");
		nvim.lua(`_G.HUNKS = { { type = "add", start_line = 6, end_line = 6 }, { type = "change", start_line = 8, end_line = 9 }, { type = "delete", start_line = 13, end_line = 13 } }; require("livepreview").refresh_hunks(vim.api.nvim_get_current_buf()); return true`);
		await until(() => browser.js(`document.querySelectorAll(".lp-hunk").length === 3`), "three bars");
		const kinds = await browser.js(`[...document.querySelectorAll(".lp-hunk")].map((b) => b.className.split("--")[1]).join(",")`);
		assert(kinds === "add,change,delete", `bars: ${kinds}`);
		assert(await browser.js(`[...document.querySelectorAll(".lp-hunk")].every((b) => parseFloat(b.style.left) >= 0)`), "bars are on screen");
	},

	async "sync: browser scroll and links move the source window"({ nvim, browser }) {
		await browser.open("/long.md");
		await sleep(1200); // the page ignores scrolls right after loading
		await browser.js(`scrollTo(0, 2500)`);
		await until(() => Number(nvim.expr("line('.')")) > 20, "the cursor to follow the scroll");
		nvim.keys("gg");
		await until(() => browser.js(`scrollY < 200`), "the preview to follow the cursor", 6000);

		await browser.open("/a.md");
		await browser.js(`document.querySelector("a[href='other.md']").click()`);
		await until(() => nvim.expr("expand('%:t')") === "other.md", "the source to follow a link");
		nvim.keys(":e a.md<CR>");
		await until(() => browser.js(`location.pathname === "/a.md"`), "the preview to follow the source");
	},

	async "tree: list, open and hide the Markdown files"({ nvim, browser }) {
		await browser.open("/a.md");
		await until(() => browser.js(`document.querySelectorAll(".lp-tree a").length === 5`), "five files in the tree");
		const entries = await browser.js(`[...document.querySelectorAll(".lp-tree summary, .lp-tree a")].map((e) => e.textContent).join(",")`);
		assert(entries === "notes,nested.md,a.md,alerts.md,long.md,other.md", `folders first, then files: ${entries}`);
		assert((await browser.js(`document.querySelector(".lp-tree [aria-current]").textContent`)) === "a.md", "the current file is marked");

		await browser.js(`document.querySelector(".lp-tree a[href='/notes/nested.md']").click()`);
		await until(() => nvim.expr("expand('%:t')") === "nested.md", "the source to follow the tree");
		await until(() => browser.js(`document.querySelector(".lp-tree [aria-current]")?.closest("details")?.open === true`), "the current file's folder to open");

		await browser.js(`document.querySelector(".lp-tree-toggle").click()`);
		await browser.open("/a.md");
		assert(await browser.js(`!document.body.classList.contains("lp-tree-open")`), "a hidden tree stays hidden");
	},

	async "cache: a page reflects the Neovim serving it"({ browser }, restart) {
		let nvim = await restart({ env: { LP_NO_COMMENTS: "1" } });
		await browser.open("/a.md");
		assert(await browser.js(`!document.querySelector(".lp-panel")`), "no comment UI without a provider");
		await nvim.stop();
		nvim = await restart();
		await browser.open("/a.md");
		assert(await browser.js(`!!document.querySelector(".lp-panel")`), "a reload picks up the new config");
		return nvim;
	},
};

const filter = process.argv[2] || "";
let failed = 0;
for (const [name, test] of Object.entries(tests).filter(([name]) => name.includes(filter))) {
	let nvim = await startNvim();
	const browser = await startBrowser();
	const restart = async (options) => {
		await nvim.stop();
		nvim = await startNvim(options);
		return nvim;
	};
	try {
		await test({ nvim, browser }, restart);
		console.log(`PASS ${name}`);
	} catch (error) {
		failed++;
		console.log(`FAIL ${name}: ${error.message}`);
	}
	await browser.close();
	await nvim.stop().catch(() => {});
}
process.exit(failed ? 1 : 0);
