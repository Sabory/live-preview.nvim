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

const livepreview_render = (text) => {
	const html = md.render(text);
	document.querySelector('.markdown-body').innerHTML = html;
	hljs.highlightAll();
}

const markdownText = document.querySelector('.markdown-body').textContent;
livepreview_render(markdownText);


