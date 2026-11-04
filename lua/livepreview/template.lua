local M = {}

-- HTML escape function using table-based substitution for better performance
local html_escapes = {
	["&"] = "&amp;",
	["<"] = "&lt;",
	[">"] = "&gt;",
	['"'] = "&quot;",
	["'"] = "&#39;",
}

local function html_escape(text)
	if not text or text == "" then
		return ""
	end
	-- Use table lookup which is faster than multiple gsub calls
	return (text:gsub("[&<>\"']", html_escapes))
end

local html_template = function(body, stylesheet, script_tag, after_ws_client)
	return [[
        <!DOCTYPE html>
        <html lang="en">

        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Live preview</title>
]] .. stylesheet .. [[
			<link rel="stylesheet" href="/live-preview.nvim/static/katex/katex.min.css">	
            <script defer src="/live-preview.nvim/static/katex/katex.min.js"></script>
            <script src="/live-preview.nvim/static/mermaid/mermaid.min.js"></script>
			<link rel="stylesheet" href="/live-preview.nvim/static/highlight/main.css">
			<script defer src="/live-preview.nvim/static/highlight/highlight.min.js"></script>
			<style>
				.katex-display{margin:1em 0;text-align:center;overflow-x:auto;overflow-y:hidden}
				.katex{font-size:1.21em}
				.katex .array{border-collapse:collapse}
				.katex .array>tbody>tr>td{padding:0}
				.katex .delimsizing{font-family:KaTeX_Size1,KaTeX_Size2,KaTeX_Size3,KaTeX_Size4,serif}
			</style>
]] .. script_tag .. [[
			<script defer src='/live-preview.nvim/static/ws-client.js'></script>
]] .. (after_ws_client or "") .. [[
        </head>

        <body>
            <div class="markdown-body">]] .. body .. [[
            </div>
            <script defer src="/live-preview.nvim/static/mermaid/main.js"></script>
        </body>
        </html>
    ]]
end

---@param plugin LivePreviewPlugin
---@param file_path string?
local function plugin_applies(plugin, file_path)
	if not plugin.paths then
		return true
	end
	if not file_path then
		return false
	end
	for _, pattern in ipairs(plugin.paths) do
		-- WHY: pages are built inside a libuv callback, where vim.fn is not allowed.
		if vim.glob.to_lpeg(vim.fs.normalize(pattern)):match(file_path) then
			return true
		end
	end
	return false
end

---@param file_path string?
local function plugin_tags(file_path)
	local tags = ""
	for _, plugin in ipairs(require("livepreview.config").config.plugins or {}) do
		if plugin_applies(plugin, file_path) then
			local base = "/live-preview.nvim/static/plugins/" .. plugin.name .. "/"
			tags = tags
				.. ([[<link rel="stylesheet" href="%splugin.css"><script defer src="%splugin.js"></script>]]):format(
					base,
					base
				)
		end
	end
	return tags
end

M.md2html = function(md, file_path)
	local script =
		[[<script defer src="/live-preview.nvim/static/markdown/line-numbers.js"></script><script defer src="/live-preview.nvim/static/markdown/alerts.js"></script><script defer src="/live-preview.nvim/static/markdown/tasks.js"></script><script defer src="/live-preview.nvim/static/markdown/markdown-it-emoji.min.js"></script><script defer src='/live-preview.nvim/static/markdown/markdown-it.min.js'></script><script defer src='/live-preview.nvim/static/markdown/markdown-it-katex.js'></script><script defer src='/live-preview.nvim/static/markdown/main.js'></script>]]
	local stylesheet = [[<link rel="stylesheet" href="/live-preview.nvim/static/markdown/github-markdown.min.css">]]
	local config = require("livepreview.config").config
	local page_scripts = ""
	if config.comments then
		page_scripts = page_scripts
			.. [[<link rel="stylesheet" href="/live-preview.nvim/static/comments/comments.css"><script defer src="/live-preview.nvim/static/comments/comments.js"></script>]]
	end
	if config.hunks then
		page_scripts = page_scripts
			.. [[<link rel="stylesheet" href="/live-preview.nvim/static/hunks/hunks.css"><script defer src="/live-preview.nvim/static/hunks/hunks.js"></script>]]
	end
	if config.file_tree then
		page_scripts = page_scripts
			.. [[<link rel="stylesheet" href="/live-preview.nvim/static/tree/tree.css"><script defer src="/live-preview.nvim/static/tree/tree.js"></script>]]
	end
	page_scripts = page_scripts
		.. [[<link rel="stylesheet" href="/live-preview.nvim/static/edit/edit.css"><script defer src="/live-preview.nvim/static/edit/source.js"></script><script defer src="/live-preview.nvim/static/edit/blocks.js"></script><script defer src="/live-preview.nvim/static/edit/edit.js"></script><script defer src="/live-preview.nvim/static/edit/toolbar.js"></script><script defer src="/live-preview.nvim/static/edit/structure.js"></script>]]
		.. plugin_tags(file_path)
	return html_template(html_escape(md), stylesheet, script, page_scripts)
end

M.adoc2html = function(adoc)
	local script =
		[[<script defer src="/live-preview.nvim/static/asciidoc/asciidoctor.min.js"></script><script defer src='/live-preview.nvim/static/asciidoc/main.js'></script>]]
	local stylesheet = [[<link rel="stylesheet" href="/live-preview.nvim/static/asciidoc/asciidoctor.min.css">]]
	return html_template(adoc, stylesheet, script)
end

M.svg2html = function(svg)
	return [[<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Live preview</title><script defer src='/live-preview.nvim/static/ws-client.js'></script></head><body><div class='markdown-body'>]]
		.. svg:gsub("<%?xml[^>]*%?>%s*", "")
		.. [[</div></body></html>]]
end

M.toHTML = function(text, filetype, file_path)
	if filetype == "markdown" then
		return M.md2html(text, file_path)
	elseif filetype == "asciidoc" then
		return M.adoc2html(text)
	elseif filetype == "svg" then
		return M.svg2html(text)
	end
end

M.handle_body = function(data)
	local ws_script = "<script src='/live-preview.nvim/static/ws-client.js'></script>"
	local body
	if data:match("<head>") then
		body = data:gsub("<head>", "<head>" .. ws_script)
	else
		body = ws_script .. data
	end
	return body
end

return M
