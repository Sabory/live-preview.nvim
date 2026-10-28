// The repository's Markdown files, as a collapsible sidebar left of the preview.
// Opening one navigates the page, and Neovim follows it like any other navigation.
(() => {
	const STORAGE_KEY = "lp-tree-open";
	const ICON =
		'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18M3 12h18M3 19h18"/></svg>';

	const currentPath = () => decodeURIComponent(window.location.pathname);

	function readOpen() {
		try {
			return localStorage.getItem(STORAGE_KEY) !== "false";
		} catch {
			return true;
		}
	}

	function setOpen(open) {
		document.body.classList.toggle("lp-tree-open", open);
		try {
			localStorage.setItem(STORAGE_KEY, String(open));
		} catch {}
	}

	// "a/b.md" and "a/c.md" become { a: { "b.md": "a/b.md", "c.md": "a/c.md" } }.
	function nest(files) {
		const root = {};
		for (const file of files) {
			const parts = file.split("/");
			let node = root;
			for (const dir of parts.slice(0, -1)) node = node[dir] ??= {};
			node[parts.at(-1)] = file;
		}
		return root;
	}

	function render(node) {
		const list = document.createElement("ul");
		const entries = Object.entries(node).sort(
			([a, x], [b, y]) => (typeof x === "string") - (typeof y === "string") || a.localeCompare(b),
		);
		for (const [name, child] of entries) {
			const item = document.createElement("li");
			if (typeof child === "string") {
				const link = document.createElement("a");
				link.textContent = name;
				link.href = "/" + child.split("/").map(encodeURIComponent).join("/");
				if ("/" + child === currentPath()) link.setAttribute("aria-current", "page");
				item.append(link);
			} else {
				const folder = document.createElement("details");
				const summary = document.createElement("summary");
				summary.textContent = name;
				folder.append(summary, render(child));
				item.append(folder);
			}
			list.append(item);
		}
		return list;
	}

	const nav = document.createElement("nav");
	nav.className = "lp-tree";
	const toggle = document.createElement("button");
	toggle.className = "lp-tree-toggle";
	toggle.title = "Files";
	toggle.innerHTML = ICON;
	toggle.addEventListener("click", () => setOpen(!document.body.classList.contains("lp-tree-open")));
	document.body.append(nav, toggle);
	setOpen(readOpen());

	livepreview_request("files").then((files) => {
		nav.replaceChildren(render(nest(files)));
		const current = nav.querySelector("[aria-current]");
		if (!current) return;
		for (let folder = current.closest("details"); folder; folder = folder.parentElement.closest("details")) {
			folder.open = true;
		}
		current.scrollIntoView({ block: "center" });
	});
})();
