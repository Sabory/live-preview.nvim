// Helpers for the end-to-end tests: a headless Neovim serving the preview and
// a headless Chromium driven over the DevTools protocol.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PORT = process.env.LP_PORT || "5599";
export const ORIGIN = `http://127.0.0.1:${PORT}`;
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const here = new URL(".", import.meta.url).pathname;

export function assert(condition, message) {
	if (!condition) throw new Error(message);
}

export async function until(check, what, timeout = 4000) {
	for (const start = Date.now(); Date.now() - start < timeout; await sleep(100)) {
		if (await check()) return;
	}
	throw new Error(`timed out waiting for ${what}`);
}

export async function startNvim({ file = "a.md", env = {} } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "lp-e2e-"));
	const socket = join(dir, "nvim.sock");
	const nvim = spawn("nvim", ["--headless", "--clean", "--listen", socket, "-u", join(here, "init.lua")], {
		env: { ...process.env, LP_PORT: PORT, LP_FILE: file, ...env },
		stdio: "ignore",
	});
	await until(() => existsSync(socket), "nvim to listen");
	await until(async () => (await fetch(ORIGIN).catch(() => null)) !== null, "the preview server");
	const remote = (flag, arg) => execFileSync("nvim", ["--server", socket, flag, arg]).toString().trim();
	return {
		expr: (expression) => remote("--remote-expr", expression),
		lua: (code) => JSON.parse(remote("--remote-expr", `luaeval('vim.json.encode((function() ${code} end)())')`)),
		keys: (keys) => remote("--remote-send", keys),
		async stop() {
			nvim.kill();
			await until(async () => (await fetch(ORIGIN).catch(() => null)) === null, "the server to stop");
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

function chromiumPath() {
	const candidates = [
		process.env.CHROMIUM,
		"/opt/homebrew/bin/chromium",
		"/usr/bin/chromium",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	];
	const found = candidates.find((path) => path && existsSync(path));
	assert(found, "no Chromium found; set CHROMIUM to its binary");
	return found;
}

export async function startBrowser() {
	const profile = mkdtempSync(join(tmpdir(), "lp-e2e-chrome-"));
	const debugPort = 9333;
	const chrome = spawn(
		chromiumPath(),
		["--headless=new", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "--window-size=1100,800", "about:blank"],
		{ stdio: "ignore" },
	);
	let targets;
	await until(async () => {
		targets = await fetch(`http://127.0.0.1:${debugPort}/json`).then((r) => r.json()).catch(() => null);
		return targets;
	}, "Chromium");
	const cdp = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
	await new Promise((resolve) => (cdp.onopen = resolve));
	const pending = new Map();
	const errors = [];
	let lastId = 0;
	cdp.onmessage = (event) => {
		const message = JSON.parse(event.data);
		if (pending.has(message.id)) {
			pending.get(message.id)(message);
			pending.delete(message.id);
		} else if (message.method === "Runtime.exceptionThrown") {
			errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
		}
	};
	const call = (method, params = {}) =>
		new Promise((resolve) => {
			const id = ++lastId;
			pending.set(id, resolve);
			cdp.send(JSON.stringify({ id, method, params }));
		});
	await call("Runtime.enable");
	// A navigating page never answers, so give up on an evaluation after a second.
	const js = async (expression) => {
		const reply = await Promise.race([
			call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }),
			sleep(1000).then(() => null),
		]);
		return reply?.result?.result?.value;
	};
	return {
		errors,
		js,
		async open(path) {
			await call("Page.navigate", { url: ORIGIN + path });
			await until(() => js(`!!document.querySelector(".markdown-body [data-source-line]")`), `${path} to render`);
		},
		async screenshot(path) {
			const reply = await call("Page.captureScreenshot");
			writeFileSync(path, Buffer.from(reply.result.data, "base64"));
		},
		async close() {
			chrome.kill();
			await sleep(300);
			rmSync(profile, { recursive: true, force: true });
		},
	};
}
