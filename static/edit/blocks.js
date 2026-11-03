// Turning source lines into another kind of block: lines in, lines out.
const livepreview_blocks = (() => {
	const MARKER = /^(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/;
	const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;
	const IS = {
		bullet: /^\s*[-*+]\s(?!\s*\[[ xX]\])/,
		todo: /^\s*[-*+]\s+\[[ xX]\]\s/,
		numbered: /^\s*\d+[.)]\s/,
		h1: /^# /,
		h2: /^## /,
		h3: /^### /,
	};
	const unquote = (line) => line.replace(/^\s*>\s?/, "");
	const allLines = (lines, pattern) => lines.filter((line) => line.trim()).every((line) => pattern.test(line));

	// One text per paragraph or list item, without its marker; soft-wrapped
	// lines of a paragraph join into one.
	function texts(lines) {
		const result = [];
		let current = null;
		for (const line of lines.map(unquote)) {
			if (!line.trim()) {
				current = null;
				continue;
			}
			const trimmed = line.trim();
			if (!current || MARKER.test(trimmed)) result.push((current = []));
			current.push(trimmed.replace(MARKER, ""));
		}
		return result.map((parts) => parts.join(" "));
	}

	const separated = (blocks) => blocks.flatMap((block, i) => (i ? ["", block] : [block]));

	function turnInto(kind, lines) {
		if (kind === "quote") {
			return allLines(lines, /^\s*>/) ? lines.map(unquote) : lines.map((line) => (line.trim() ? `> ${line}` : ">"));
		}
		const target = IS[kind] && allLines(lines, IS[kind]) ? "text" : kind;
		const items = texts(lines);
		if (target === "bullet") return items.map((text) => `- ${text}`);
		if (target === "todo") return items.map((text) => `- [ ] ${text}`);
		if (target === "numbered") return items.map((text, i) => `${i + 1}. ${text}`);
		if (/^h[1-3]$/.test(target)) return separated(items.map((text) => `${"#".repeat(target[1])} ${text}`));
		return separated(items);
	}

	// Blank lines a result needs so it does not merge with its neighbors; list
	// items next to list items stay one list.
	function padded(result, before, after) {
		const merges = (neighbor, edge) => neighbor !== undefined && neighbor.trim() !== "" && !(LIST_ITEM.test(neighbor) && LIST_ITEM.test(edge));
		return [
			...(merges(before, result[0]) ? [""] : []),
			...result,
			...(merges(after, result[result.length - 1]) ? [""] : []),
		];
	}

	const turnable = (lines) => !lines.some((line) => /^\s*(?:\||```|~~~)/.test(line));

	return { turnInto, padded, turnable };
})();
