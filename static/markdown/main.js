const md = window.markdownit({
	html: true,
	highlight: function(str, lang) {
		if (lang && hljs.getLanguage(lang)) {
			try {
				return hljs.highlight(str, { language: lang }).value;
			} catch (__) { }
		}

		return ''; // use external default escaping
	}
});
md.use(livepreview_injectLinenumbersPlugin);
// Static files are read from disk but the template that lists them lives in
// Neovim's memory: after an update, a running Neovim may not load this script.
if (typeof livepreview_alertsPlugin === "function") {
	md.use(livepreview_alertsPlugin);
}

md.use(markdownitEmoji);

// Use markdown-it-katex plugin to handle math rendering during markdown parsing
// This prevents markdown-it from corrupting LaTeX syntax before KaTeX can render it
md.use(markdownitKatex);

// YAML front matter is metadata, not content. Blank it out line for line so
// the rendered blocks keep their source line numbers.
const withoutFrontMatter = (text) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, (block) => block.replace(/[^\n]/g, ""));

const livepreview_toHtml = (text) => md.render(withoutFrontMatter(text));

// The Markdown the page shows, which edits made in the page are patches of.
let livepreview_source = "";
// Replaced by the edit script: true while a block is being edited, so an update
// from Neovim waits instead of wiping what is being typed.
let livepreview_holdRender = () => false;
let livepreview_heldText = null;

const livepreview_render = (text) => {
	if (livepreview_holdRender()) {
		livepreview_heldText = text;
		return;
	}
	livepreview_heldText = null;
	livepreview_source = text;
	document.querySelector('.markdown-body').innerHTML = livepreview_toHtml(text);
	hljs.highlightAll();
}

const markdownText = document.querySelector('.markdown-body').textContent;
livepreview_render(markdownText);


