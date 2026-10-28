// End-to-end tests: `make e2e`, or `node tests/e2e/run.mjs [name filter]`.
import { assert, sleep, startBrowser, startNvim, until, ORIGIN } from "./lib.mjs";

const selectAndComment = (selector, from, to) => `(() => {
	const text = document.querySelector(${JSON.stringify(selector)}).firstChild;
	const range = document.createRange();
	range.setStart(text, ${from});
	range.setEnd(text, ${to});
	getSelection().removeAllRanges();
	getSelection().addRange(range);
})()`;

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

	async "cache: a page reflects the Neovim serving it"({ browser }, restart) {
		let nvim = await restart({ env: { LP_NO_COMMENTS: "1" } });
		await browser.open("/a.md");
		assert(await browser.js(`!document.querySelector(".lp-topbar")`), "no comment UI without a provider");
		await nvim.stop();
		nvim = await restart();
		await browser.open("/a.md");
		assert(await browser.js(`!!document.querySelector(".lp-topbar")`), "a reload picks up the new config");
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
