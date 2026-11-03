// GitHub task lists: an item starting with [ ] or [x] renders with a checkbox,
// in GitHub's classes so its stylesheet applies.
function livepreview_tasksPlugin(md) {
	const BOX = /^\[([ xX])\](?:\s+|$)/;

	// The box may span several text tokens before they are joined.
	function dropPrefix(children, length) {
		while (length > 0 && children[0] && children[0].type === "text") {
			const taken = Math.min(length, children[0].content.length);
			children[0].content = children[0].content.slice(taken);
			length -= taken;
			if (!children[0].content) children.shift();
		}
	}

	md.core.ruler.push("livepreview_tasks", (state) => {
		const tokens = state.tokens;
		for (let i = 2; i < tokens.length; i++) {
			const inline = tokens[i];
			if (inline.type !== "inline" || tokens[i - 1].type !== "paragraph_open" || tokens[i - 2].type !== "list_item_open") continue;
			const match = inline.content.match(BOX);
			if (!match) continue;
			dropPrefix(inline.children, match[0].length);
			const box = new state.Token("html_inline", "", 0);
			box.content = `<input type="checkbox" class="task-list-item-checkbox"${match[1] === " " ? "" : " checked"}>`;
			inline.children.unshift(box);
			tokens[i - 2].attrJoin("class", "task-list-item");
		}
	});
}
