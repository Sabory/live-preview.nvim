const wsUrl = getWebSocketUrl();
let socket;
let connected = true;

function getWebSocketUrl() {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const hostname = window.location.hostname;
	const port = window.location.port ? `:${window.location.port}` : "";
	return `${protocol}//${hostname}${port}`;
}

/**
 * Normalize Windows file path to use forward slashes
 * @param {string} filepath - The file path to normalize
 * @returns {string} - The normalized file path
 */
const normalizePath = (filepath) => {
    if (!filepath) return '';

    const isWindows = /^[a-zA-Z]:\\/.test(filepath) ||
                      filepath.startsWith('\\\\');

    return isWindows ? filepath.replace(/\\/g, '/') : filepath;
};

/**
 * Check if browser should handle websocket message from server
 * @param {string} filepath - The path of the file
 * @returns {boolean} - True if the browser should handle the message, false otherwise
 */
const isRightPath = (filepath) => {
	const decodedPath = decodeURIComponent(window.location.pathname)
	console.log("Checking path:", filepath, "against", decodedPath);
    const normalized = normalizePath(filepath);
    return normalized.endsWith(decodedPath);
};

let livepreview_reload

const currentPath = () => decodeURIComponent(window.location.pathname);

// Replies to livepreview_request(), keyed by request id.
const pendingRequests = new Map();
let lastRequestId = 0;

/**
 * Send a message to Neovim
 * @param {object} message - JSON message, with a `type`
 */
function livepreview_send(message) {
	if (socket.readyState === WebSocket.OPEN) {
		socket.send(JSON.stringify(message));
	} else {
		socket.addEventListener("open", () => socket.send(JSON.stringify(message)), { once: true });
	}
}

/**
 * Send a message to Neovim and wait for its reply
 * @param {string} type - message type
 * @param {object} payload - other fields of the message
 * @returns {Promise<any>} - the result, rejected with Neovim's error
 */
function livepreview_request(type, payload = {}) {
	const request_id = ++lastRequestId;
	return new Promise((resolve, reject) => {
		pendingRequests.set(request_id, { resolve, reject });
		livepreview_send({ ...payload, type, request_id });
	});
}

// Scrolling to follow Neovim, or the browser restoring the position on a
// reload, must not be reported back as the reader scrolling.
let followingEditorUntil = Date.now() + 1000;

function sourceLineOf(element) {
	const block = element && element.closest("[data-source-line]");
	return block ? parseInt(block.getAttribute("data-source-line")) : null;
}

// The block at the middle of the viewport, which Neovim then centers too.
function lineAtViewportCenter() {
	let line = null;
	for (const block of document.querySelectorAll("[data-source-line]")) {
		if (block.getBoundingClientRect().top > window.innerHeight / 2) break;
		line = parseInt(block.getAttribute("data-source-line"));
	}
	return line;
}

let scrollTimer;
let lastRevealedLine;
window.addEventListener("scroll", () => {
	clearTimeout(scrollTimer);
	scrollTimer = setTimeout(() => {
		if (Date.now() < followingEditorUntil) return;
		const line = lineAtViewportCenter();
		if (line === null || line === lastRevealedLine) return;
		lastRevealedLine = line;
		livepreview_send({ type: "reveal", path: currentPath(), line, from_scroll: true });
	}, 150);
});

document.addEventListener("dblclick", (event) => {
	const line = sourceLineOf(event.target);
	if (line !== null) livepreview_send({ type: "reveal", path: currentPath(), line });
});

async function connectWebSocket() {
	socket = new WebSocket(wsUrl);

	socket.onopen = () => {
		if (!connected) {
			window.location.reload();
		}
		connected = true;
		// Also on a back/forward navigation served from the browser's cache.
		livepreview_send({ type: "open", path: currentPath() });
		console.log("Connected to server");
		console.log("connected: ", connected);
		livepreview_reload = 0;
	};

	socket.onmessage = (event) => {
		const message = JSON.parse(event.data);

		if (message.type === "reload") {
			console.log("Reload message received");
			if (livepreview_reload === 0) {
				livepreview_reload = 1;
				connected = false;
				socket.close();
				return;
			}
		} else if (message.type === "update") {
			console.log("Update message received");
			let { filepath, content } = message;
			if (isRightPath(filepath)) {
				// Check if the render function is defined before calling it
				if (typeof livepreview_render !== "undefined") {
					livepreview_render(content);
					if (typeof livepreview_renderKatex !== "undefined") {
						livepreview_renderKatex();
					}
					if (typeof livepreview_renderMermaid !== "undefined") {
						livepreview_renderMermaid();
					}
				} else {
					// Check if viewing svg
					if (window.location.pathname.endsWith(".svg")) {
						const livepreview_render = (text) => {
							document.querySelector('.markdown-body').innerHTML = text;
						}
						livepreview_render(content);
					}
					else {
						console.error("livepreview_render function is not defined");
					}
				}
			}
		} else if (message.type === "navigate") {
			if (message.path !== currentPath()) {
				window.location.assign(encodeURI(message.path));
			}
		} else if (message.type === "reply") {
			const pending = pendingRequests.get(message.request_id);
			if (pending) {
				pendingRequests.delete(message.request_id);
				message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result);
			}
		} else if (message.type === "scroll") {
			console.log("Scroll message received");
			const { filepath, cursor } = message;
			if (isRightPath(filepath)) {
				followingEditorUntil = Date.now() + 1000;
				const line = document.querySelector(`[data-source-line="${cursor[0]}"]`);
				if (line) {
					line.scrollIntoView({ behavior: "smooth", block: "center" });
				} else {
					// Find the closest line number
					const lineNumbers = document.querySelectorAll(".source-line");
					let closest = lineNumbers[0];
					let minDiff = Math.abs(cursor[0] - parseInt(closest.getAttribute("data-source-line")));
					lineNumbers.forEach((lineNumber) => {
						const diff = Math.abs(cursor[0] - parseInt(lineNumber.getAttribute("data-source-line")));
						if (diff < minDiff) {
							minDiff = diff;
							closest = lineNumber;
						}
					});
					closest.scrollIntoView({ behavior: "smooth", block: "center" });
				}
			}
		} else {
			// For the optional page scripts (comments, hunks).
			window.dispatchEvent(new CustomEvent(`livepreview:${message.type}`, { detail: message }));
		}
	};

	socket.onclose = () => {
		connected = false;
		console.log("Disconnected from server");
		window.location.reload();
	};

	socket.onerror = (error) => {
		console.error("WebSocket error:", error);
	};
}

connectWebSocket();
window.onload = () => {
	setInterval(() => {
		if (!connected) {
			connectWebSocket();
		}
	}, 1000);
};

