// Renders the provenance blocks of the AFP docs (`<provenance-compendium-claim>`
// and its siblings) as callouts that name their source and link to it.
// markdown-it passes the tags through as raw HTML; defining them as custom
// elements styles every render without touching the parser.
(() => {
	const ICONS = {
		book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
		scales: '<path d="M12 3v18"/><path d="M5 7h14"/><path d="M5 7l-3 7a4 4 0 0 0 6 0z"/><path d="M19 7l-3 7a4 4 0 0 0 6 0z"/><path d="M8 21h8"/>',
		shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
		sheet: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h8"/>',
		link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
		chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
		mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/>',
		eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
		check: '<path d="M20 6 9 17l-5-5"/>',
		flag: '<path d="M4 22V4"/><path d="M4 4h13l-2 4 2 4H4"/>',
		external: '<path d="M7 17 17 7"/><path d="M7 7h10v10"/>',
	};

	// Labels match docs/lib/provenance-blocks/vocabulary.js in the AFP repo.
	const TYPES = {
		"compendium-claim": { label: "Compendio", tone: "blue", icon: "book" },
		"law-claim": { label: "Ley", tone: "purple", icon: "scales" },
		"ncg-claim": { label: "NCG", tone: "teal", icon: "shield" },
		"oficio-claim": { label: "Oficio", tone: "orange", icon: "sheet" },
		claim: { label: "Referencia", tone: "gray", icon: "link" },
		"slack-claim": { label: "Testimonio", tone: "gray", icon: "chat" },
		"email-claim": { label: "Correo", tone: "gray", icon: "mail" },
		reading: { label: "Lectura", tone: "yellow", icon: "eye" },
		decision: { label: "Decisión", tone: "green", icon: "check" },
		requirement: { label: "Requisito", tone: "red", icon: "flag" },
	};

	const svg = (name) =>
		`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

	const el = (tag, className, text) => {
		const node = document.createElement(tag);
		node.className = className;
		if (text) node.textContent = text;
		return node;
	};

	// ponytail: `data-path` is absolute from the docs folder; the folder is taken
	// as the `/docs` segment of the page URL, or the preview root when there is none.
	const docsRoot = () => {
		const match = decodeURIComponent(window.location.pathname).match(/^(.*?\/docs)\//);
		return match ? match[1] : "";
	};

	function sourceLink(block) {
		const path = block.getAttribute("data-path");
		const url = block.getAttribute("data-url");
		if (!path && !url) return null;
		const link = el("a", "lp-pv-open");
		link.href = path ? docsRoot() + path : url;
		if (!path) {
			link.target = "_blank";
			link.rel = "noopener";
		}
		link.innerHTML = `Abrir fuente${svg("external")}`;
		return link;
	}

	function citeOf(block) {
		const attr = (name) => block.getAttribute(name);
		if (attr("data-cite")) return attr("data-cite");
		if (attr("data-author")) return [attr("data-author"), attr("data-date")].filter(Boolean).join(" · ");
		if (attr("data-from")) return [attr("data-from"), attr("data-date")].filter(Boolean).join(" · ");
		return null;
	}

	function idLinks(label, ids) {
		const line = el("div", "lp-pv-meta", `${label} `);
		ids.split(/\s+/).filter(Boolean).forEach((id, index) => {
			if (index) line.append(", ");
			const link = el("a", "", id);
			link.href = `#${id}`;
			line.append(link);
		});
		return line;
	}

	function decorate(block, type) {
		if (block.querySelector(":scope > .lp-pv-header")) return;
		block.classList.add("lp-pv", `lp-pv--${type.tone}`);

		const header = el("div", "lp-pv-header");
		const kind = el("span", "lp-pv-kind");
		kind.innerHTML = `${svg(type.icon)}<span>${type.label}</span>`;
		header.append(kind);
		const cite = citeOf(block);
		if (cite) header.append(el("span", "lp-pv-cite", cite));
		const open = sourceLink(block);
		if (open) header.append(open);
		block.prepend(header);

		const subject = block.getAttribute("data-subject");
		if (subject) block.append(el("div", "lp-pv-meta", subject));
		const path = block.getAttribute("data-path");
		if (path) block.append(el("div", "lp-pv-meta lp-pv-path", path));
		const informedBy = block.getAttribute("data-informed-by");
		if (informedBy) block.append(idLinks("Se basa en", informedBy));
		const permittedBy = block.getAttribute("data-permitted-by");
		if (permittedBy) block.append(idLinks("Lo permite", permittedBy));
	}

	for (const [suffix, type] of Object.entries(TYPES)) {
		const tag = `provenance-${suffix}`;
		if (customElements.get(tag)) continue;
		customElements.define(
			tag,
			class extends HTMLElement {
				connectedCallback() {
					decorate(this, type);
				}
			}
		);
	}
})();
