// Mapping text edited in the page back to the Markdown it was rendered from.
const livepreview_patch = (() => {
	const ITEM = /^(\s*)([-*+]|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/;

	// The part of the block's source a host's text comes from: a table cell is
	// one segment of its row, so a word repeated in another cell is not matched.
	function scopeOf(host, source) {
		// An item's text starts after its marker and box, so "[x]" is not matched as text.
		if (host.tagName === "LI") return [(source.match(ITEM) || [""])[0].length, source.length];
		if (host.tagName !== "TD" && host.tagName !== "TH") return [0, source.length];
		const pipes = [...source.matchAll(/(?<!\\)\|/g)].map((m) => m.index);
		const leading = source.trimStart().startsWith("|") ? 1 : 0;
		const bounds = [-1, ...pipes, source.length].slice(leading);
		const index = host.cellIndex;
		return [bounds[index] + 1, bounds[index + 1] ?? source.length];
	}

	function changedSpan(before, after) {
		let start = 0;
		while (start < before.length && before[start] === after[start]) start++;
		let end = 0;
		while (
			end < before.length - start &&
			end < after.length - start &&
			before[before.length - 1 - end] === after[after.length - 1 - end]
		)
			end++;
		return { from: start, to: before.length - end, text: after.slice(start, after.length - end) };
	}

	// Source offset of each rendered character, matched in order: whatever is
	// skipped between two matches is markup.
	function align(rendered, source) {
		const offsets = [];
		let j = 0;
		for (let i = 0; i < rendered.length; i++) {
			const char = rendered[i];
			if (/\s/.test(char)) {
				// Rendered space the source may not have (around a checkbox, at an
				// edge): it only takes a source space found before the next word.
				const next = (rendered.slice(i + 1).match(/\S/) || [])[0];
				let k = j;
				while (k < source.length && !/\s/.test(source[k]) && source[k] !== next) k++;
				const found = k < source.length && /\s/.test(source[k]);
				offsets.push(found ? k : j);
				if (found) j = k + 1;
				continue;
			}
			while (j < source.length && source[j] !== char) j++;
			offsets.push(j++);
		}
		return offsets;
	}

	function patch(source, before, span) {
		const at = align(before, source);
		const start = span.from < span.to || span.from === 0 ? (at[span.from] ?? source.length) : at[span.from - 1] + 1;
		const end = span.from < span.to ? at[span.to - 1] + 1 : start;
		return source.slice(0, start) + span.text + source.slice(end);
	}

	// Deleting all the text of a bold or code span leaves its markers behind.
	const withoutEmptyMarkup = (text) => text.replace(/(\*\*|__|~~|\*|_|`)\1/g, "");

	// The last item of a list also spans the blank line after the list.
	const lastFilled = (lines) => lines.findLastIndex((line) => line.trim());

	const markerWidth = (line) => {
		const match = line.match(ITEM);
		return match ? match[2].length + match[5].length : 0;
	};

	// The marker of the item after `line`: the next number, an unchecked box.
	function nextMarker(line) {
		const [, indent, bullet, number, dot, space, box] = line.match(ITEM);
		return `${indent}${number ? `${Number(number) + 1}${dot}` : bullet}${space}${box ? "[ ] " : ""}`;
	}

	return { ITEM, scopeOf, changedSpan, align, patch, withoutEmptyMarkup, lastFilled, markerWidth, nextMarker };
})();
