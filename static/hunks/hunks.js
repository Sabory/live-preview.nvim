// Changed lines of the previewed buffer, drawn as bars left of the text like
// the editor's sign column. Neovim pushes them whenever they change.
(() => {
	let hunks = [];
	const layer = document.createElement("div");
	layer.className = "lp-hunks";
	document.body.append(layer);

	function draw() {
		const body = document.querySelector(".markdown-body");
		layer.replaceChildren();
		if (!body || !body.firstElementChild) return;
		const left = body.firstElementChild.getBoundingClientRect().left + window.scrollX - 12;
		for (const hunk of hunks) {
			// Removed lines no longer render: mark the gap after the block before them.
			const blocks =
				hunk.type === "delete"
					? livepreview_blocksIn(1, hunk.start_line).slice(-1)
					: livepreview_blocksIn(hunk.start_line, hunk.end_line);
			if (!blocks.length) continue;
			const first = blocks[0].getBoundingClientRect();
			const last = blocks[blocks.length - 1].getBoundingClientRect();
			const bar = document.createElement("div");
			bar.className = `lp-hunk lp-hunk--${hunk.type}`;
			bar.style.left = `${left}px`;
			bar.style.top = `${(hunk.type === "delete" ? last.bottom : first.top) + window.scrollY}px`;
			if (hunk.type !== "delete") bar.style.height = `${last.bottom - first.top}px`;
			layer.append(bar);
		}
	}

	window.addEventListener("livepreview:hunks", ({ detail }) => {
		if (detail.path !== decodeURIComponent(window.location.pathname)) return;
		// An empty Lua table arrives as {}.
		hunks = Array.isArray(detail.hunks) ? detail.hunks : [];
		draw();
	});

	let frame;
	const redraw = () => {
		cancelAnimationFrame(frame);
		frame = requestAnimationFrame(draw);
	};
	const body = document.querySelector(".markdown-body");
	new MutationObserver(redraw).observe(body, { childList: true });
	new ResizeObserver(redraw).observe(body);
})();
