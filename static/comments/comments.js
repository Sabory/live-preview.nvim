// Comments in the Markdown preview. Neovim's comment provider owns them; this
// page only asks for the list and sends edits through livepreview_request().
(() => {
	const ICONS = {
		comment:
			'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5c-4.97 0-9 3.47-9 7.75 0 2.04.92 3.9 2.43 5.28L4.5 20.5l4.32-1.73c.99.3 2.06.48 3.18.48 4.97 0 9-3.47 9-7.75S16.97 3.5 12 3.5Z"/></svg>',
		chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
		close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
	};

	let comments = [];
	let pending = null; // selection being commented: { range, start_line, end_line, quote }
	let editingId = null;

	const currentPath = () => decodeURIComponent(window.location.pathname);
	const markdownBody = () => document.querySelector(".markdown-body");

	function el(tag, attrs = {}, children = []) {
		const node = document.createElement(tag);
		for (const [key, value] of Object.entries(attrs)) {
			if (key === "text") node.textContent = value;
			else if (key === "icon") node.innerHTML = ICONS[value];
			else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
			else node.setAttribute(key, value);
		}
		node.append(...children);
		return node;
	}

	function toast(message, isError = false) {
		const node = el("div", { class: `lp-toast${isError ? " lp-toast--error" : ""}`, text: message });
		document.body.append(node);
		setTimeout(() => node.remove(), 2500);
	}

	async function request(type, payload) {
		try {
			return await livepreview_request(type, payload);
		} catch (error) {
			toast(error.message, true);
			throw error;
		}
	}

	// --- Mapping the preview back to source lines -------------------------

	const lineRange = (block) => [
		parseInt(block.getAttribute("data-source-line")),
		parseInt(block.getAttribute("data-source-end")),
	];

	function blockOf(node) {
		const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
		return element && element.closest("[data-source-end]");
	}

	function selectionToComment() {
		const selection = window.getSelection();
		if (!selection.rangeCount || selection.isCollapsed) return null;
		const range = selection.getRangeAt(0);
		const body = markdownBody();
		if (!body || !body.contains(range.commonAncestorContainer)) return null;
		const first = blockOf(range.startContainer);
		const last = blockOf(range.endContainer);
		const quote = selection.toString().trim();
		if (!first || !last || !quote) return null;
		const [firstStart, firstEnd] = lineRange(first);
		const [lastStart, lastEnd] = lineRange(last);
		return {
			range: range.cloneRange(),
			start_line: Math.min(firstStart, lastStart),
			end_line: Math.max(firstEnd, lastEnd),
			quote,
		};
	}

	const blocksIn = livepreview_blocksIn;

	// The selection's text and the DOM's text nodes disagree on whitespace
	// between blocks, so match the quote ignoring all whitespace.
	function findQuote(blocks, quote) {
		const target = quote.replace(/\s+/g, "");
		const positions = [];
		let text = "";
		for (const block of blocks) {
			const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				const value = node.nodeValue;
				for (let i = 0; i < value.length; i++) {
					if (/\s/.test(value[i])) continue;
					positions.push({ node, offset: i });
					text += value[i];
				}
			}
		}
		const at = target ? text.indexOf(target) : -1;
		if (at < 0) return null;
		const start = positions[at];
		const end = positions[at + target.length - 1];
		const range = document.createRange();
		range.setStart(start.node, start.offset);
		range.setEnd(end.node, end.offset + 1);
		return range;
	}

	// --- Topbar -----------------------------------------------------------

	const count = el("span", { class: "lp-count" });
	const menu = el("div", { class: "lp-menu", hidden: "" }, [
		el("button", { text: "Paste all to agent", title: "s", onclick: () => sendComments(null, false) }),
		el("button", { text: "Send all to agent", title: "S", onclick: () => sendComments(null, true) }),
	]);
	const topbar = el("div", { class: "lp-topbar" }, [
		el("div", { class: "lp-split" }, [
			el("button", { class: "lp-icon-button", title: "Comments", onclick: () => togglePanel() }, [
				el("span", { icon: "comment" }),
				count,
			]),
			el("button", {
				class: "lp-icon-button lp-chevron",
				title: "Send comments",
				icon: "chevron",
				onclick: (event) => {
					event.stopPropagation();
					menu.toggleAttribute("hidden");
				},
			}),
		]),
		menu,
	]);
	document.addEventListener("click", (event) => {
		if (!topbar.contains(event.target)) menu.setAttribute("hidden", "");
	});

	// --- Panel ------------------------------------------------------------

	const list = el("div", { class: "lp-list" });
	const panelTitle = el("h2", { text: "Comments" });
	const panel = el("aside", { class: "lp-panel", hidden: "" }, [
		el("header", {}, [
			panelTitle,
			el("button", { class: "lp-icon-button", title: "Close", icon: "close", onclick: () => togglePanel(false) }),
		]),
		list,
		el("footer", {}, [
			el("button", { text: "Paste all", onclick: () => sendComments(null, false) }),
			el("button", { class: "lp-primary", text: "Send all", onclick: () => sendComments(null, true) }),
		]),
	]);

	function togglePanel(open = panel.hasAttribute("hidden")) {
		panel.toggleAttribute("hidden", !open);
		document.body.classList.toggle("lp-panel-open", open);
		placeBadges();
	}

	const fileLabel = (comment) => (comment.path || comment.file).split("/").pop();
	const lines = (c) => (c.start_line === c.end_line ? `L${c.start_line}` : `L${c.start_line}–${c.end_line}`);

	function startEditing(id) {
		editingId = id;
		renderPanel();
	}

	function renderCard(comment) {
		const isEditing = editingId === comment.id;
		const textarea = el("textarea", { rows: "3" });
		textarea.value = comment.text;
		const save = async () => {
			const text = textarea.value.trim();
			if (text && text !== comment.text) await request("comment.edit", { id: comment.id, text });
			startEditing(null);
		};
		textarea.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				save();
			} else if (event.key === "Escape") {
				startEditing(null);
			}
		});

		const action = (text, onclick) =>
			el("button", {
				text,
				onclick: (event) => {
					event.stopPropagation();
					onclick();
				},
			});
		const card = el("article", { class: "lp-card", "data-comment-id": String(comment.id) }, [
			el("div", { class: "lp-card-meta" }, [
				el("span", { class: "lp-file", text: fileLabel(comment) }),
				el("span", { text: lines(comment) }),
			]),
			...(comment.quote ? [el("blockquote", { text: comment.quote })] : []),
			isEditing ? textarea : el("p", { text: comment.text }),
			el(
				"div",
				{ class: "lp-card-actions" },
				isEditing
					? [action("Cancel", () => startEditing(null)), action("Save", save)]
					: [
							action("Edit", () => startEditing(comment.id)),
							action("Delete", () => request("comment.delete", { id: comment.id })),
							action("Paste", () => sendComments([comment.id], false)),
							action("Send", () => sendComments([comment.id], true)),
						],
			),
		]);
		card.addEventListener("click", () => !isEditing && goTo(comment));
		if (isEditing) requestAnimationFrame(() => textarea.focus());
		return card;
	}

	function renderPanel() {
		count.textContent = comments.length ? String(comments.length) : "";
		panelTitle.textContent = comments.length ? `Comments (${comments.length})` : "Comments";
		const here = currentPath();
		const sorted = [...comments].sort((a, b) => (b.path === here) - (a.path === here));
		list.replaceChildren(
			...(sorted.length
				? sorted.map(renderCard)
				: [el("p", { class: "lp-empty", text: "No comments yet. Select text and press c." })]),
		);
	}

	function focusCard(id) {
		togglePanel(true);
		const card = list.querySelector(`[data-comment-id="${CSS.escape(String(id))}"]`);
		if (!card) return;
		card.scrollIntoView({ block: "nearest", behavior: "smooth" });
		card.classList.add("lp-flash");
		setTimeout(() => card.classList.remove("lp-flash"), 1200);
	}

	function goTo(comment) {
		if (comment.path && comment.path !== currentPath()) {
			window.location.assign(encodeURI(comment.path));
			return;
		}
		const [block] = blocksIn(comment.start_line, comment.end_line);
		if (block) block.scrollIntoView({ block: "center", behavior: "smooth" });
		livepreview_send({ type: "reveal", path: currentPath(), line: comment.start_line });
	}

	async function sendComments(ids, submit) {
		menu.setAttribute("hidden", "");
		if (!comments.length) {
			toast("No comments to send");
			return;
		}
		await request("comments.send", ids ? { ids, submit } : { submit });
		toast(submit ? "Sending to the agent" : "Pasting into the agent");
	}

	// --- Highlights and margin badges --------------------------------------

	const badges = el("div", { class: "lp-badges" });

	function setHighlight(name, ranges) {
		if (!window.CSS || !CSS.highlights) return;
		ranges.length ? CSS.highlights.set(name, new Highlight(...ranges)) : CSS.highlights.delete(name);
	}

	function placeBadges() {
		const body = markdownBody();
		badges.replaceChildren();
		if (!body) return;
		const right = body.getBoundingClientRect().right + window.scrollX;
		const perBlock = new Map();
		for (const comment of comments.filter((c) => c.path === currentPath())) {
			const [block] = blocksIn(comment.start_line, comment.end_line);
			if (!block) continue;
			const stacked = perBlock.get(block) || 0;
			perBlock.set(block, stacked + 1);
			const top = block.getBoundingClientRect().top + window.scrollY;
			badges.append(
				el("button", {
					class: "lp-badge",
					title: comment.text,
					icon: "comment",
					style: `top:${top}px;left:${right - 28 - stacked * 22}px`,
					onclick: () => focusCard(comment.id),
				}),
			);
		}
	}

	function applyHighlights() {
		document.querySelectorAll(".lp-commented").forEach((block) => block.classList.remove("lp-commented"));
		const ranges = [];
		for (const comment of comments.filter((c) => c.path === currentPath())) {
			const blocks = blocksIn(comment.start_line, comment.end_line);
			const quoted = comment.quote && findQuote(blocks, comment.quote);
			if (quoted) ranges.push(quoted);
			else blocks.forEach((block) => block.classList.add("lp-commented"));
		}
		setHighlight("lp-comment", ranges);
		placeBadges();
	}

	async function loadComments() {
		comments = (await request("comments.list")) || [];
		renderPanel();
		applyHighlights();
	}

	// --- Commenting a selection -------------------------------------------

	const selectionButton = el("button", {
		class: "lp-selection-button",
		title: "Comment (c)",
		icon: "comment",
		hidden: "",
		onmousedown: (event) => event.preventDefault(), // keep the selection
		onclick: () => openComposer(),
	});

	const composerInput = el("textarea", { rows: "3", placeholder: "Comment for the agent…" });
	const composerQuote = el("blockquote");
	const composer = el("div", { class: "lp-composer", hidden: "" }, [
		composerQuote,
		composerInput,
		el("div", { class: "lp-card-actions" }, [
			el("button", { text: "Cancel", onclick: () => closeComposer() }),
			el("button", { class: "lp-primary", text: "Comment", onclick: () => submitComposer() }),
		]),
	]);
	composerInput.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			submitComposer();
		} else if (event.key === "Escape") {
			closeComposer();
		}
	});

	function placeBelow(node, rect) {
		const width = Math.min(360, window.innerWidth - 32);
		const left = Math.max(16, Math.min(rect.left, window.innerWidth - width - 16));
		node.style.left = `${left + window.scrollX}px`;
		node.style.top = `${rect.bottom + window.scrollY + 8}px`;
		node.style.width = `${width}px`;
	}

	function openComposer() {
		pending = selectionToComment();
		if (!pending) return;
		selectionButton.setAttribute("hidden", "");
		composerQuote.textContent = pending.quote;
		composerInput.value = "";
		composer.removeAttribute("hidden");
		placeBelow(composer, pending.range.getBoundingClientRect());
		// Focusing the textarea drops the page selection; keep it visible.
		setHighlight("lp-pending", [pending.range]);
		composerInput.focus();
	}

	function closeComposer() {
		pending = null;
		composer.setAttribute("hidden", "");
		setHighlight("lp-pending", []);
	}

	async function submitComposer() {
		const text = composerInput.value.trim();
		if (!pending || !text) return;
		const { start_line, end_line, quote } = pending;
		await request("comment.add", { path: currentPath(), start_line, end_line, text, quote });
		window.getSelection().removeAllRanges();
		closeComposer();
	}

	let selectionTimer;
	document.addEventListener("selectionchange", () => {
		clearTimeout(selectionTimer);
		selectionTimer = setTimeout(() => {
			const selected = composer.hasAttribute("hidden") && selectionToComment();
			if (!selected) {
				selectionButton.setAttribute("hidden", "");
				return;
			}
			const rect = selected.range.getBoundingClientRect();
			selectionButton.style.top = `${rect.top + window.scrollY - 36}px`;
			selectionButton.style.left = `${Math.min(rect.right, window.innerWidth - 40) + window.scrollX}px`;
			selectionButton.removeAttribute("hidden");
		}, 120);
	});

	document.addEventListener("keydown", (event) => {
		const typing = event.target.closest && event.target.closest("input, textarea, [contenteditable]");
		if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
		if (event.key === "c" && selectionToComment()) {
			event.preventDefault();
			openComposer();
		} else if (event.key === "s" || event.key === "S") {
			event.preventDefault();
			sendComments(null, event.key === "S");
		} else if (event.key === "Escape") {
			menu.setAttribute("hidden", "");
			togglePanel(false);
		}
	});

	// --- Wiring -----------------------------------------------------------

	document.body.append(topbar, panel, badges, selectionButton, composer);
	window.addEventListener("livepreview:comments", loadComments);
	window.addEventListener("focus", loadComments);
	window.addEventListener("resize", placeBadges);
	// Every edit in Neovim re-renders the whole body, dropping highlights.
	let renderFrame;
	new MutationObserver(() => {
		cancelAnimationFrame(renderFrame);
		renderFrame = requestAnimationFrame(applyHighlights);
	}).observe(markdownBody(), { childList: true });
	loadComments();
})();
