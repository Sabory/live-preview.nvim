local utils = require("livepreview.utils")

print("Test module livepreview.utils")

print()
print("supported_filetype()")
assert(utils.supported_filetype("test.html") == "html", "should return `html`")
assert(utils.supported_filetype("test.md") == "markdown", "should return `markdown`")
assert(utils.supported_filetype("test.markdown") == "markdown", "should return `markdown`")
assert(utils.supported_filetype("test.adoc") == "asciidoc", "should return `asciidoc`")
assert(utils.supported_filetype("test.asciidoc") == "asciidoc", "should return `asciidoc`")
assert(utils.supported_filetype("test.txt") == nil, "should return `nil`")
assert(utils.supported_filetype("test/test.html") == "html", "should return `html`")
assert(utils.supported_filetype("test/test.md") == "markdown", "should return `markdown`")
assert(utils.supported_filetype("test/test.markdown") == "markdown", "should return `markdown`")
assert(utils.supported_filetype("test/test.adoc") == "asciidoc", "should return `asciidoc`")
assert(utils.supported_filetype("test/test.asciidoc") == "asciidoc", "should return `asciidoc`")
assert(utils.supported_filetype("test/test.txt") == nil, "should return `nil`")
assert(utils.supported_filetype("test/test test with spaces.md") == "markdown", "should return `markdown`")

print()
print("get_plugin_path()")
vim.cmd.cd()
local plugin_path = utils.get_plugin_path()
assert(plugin_path:match("live%-preview%.nvim$"), "should return the path where live-preview.nvim is installed")
vim.cmd.cd("-")

print()
print("list_supported_files()")
local supported_files = utils.list_supported_files(plugin_path)
assert(type(supported_files) == "table" and #supported_files > 0, "should return a table with values")

print()
print("list_markdown_files()")
local markdown_files = utils.list_markdown_files(plugin_path)
assert(vim.tbl_contains(markdown_files, "README.md"), "should list README.md")
assert(vim.tbl_contains(markdown_files, "tests/test with space.md"), "should list nested files")
assert(not vim.tbl_contains(markdown_files, "tests/test.adoc"), "should skip non-Markdown files")
local outside_git = vim.fn.tempname()
vim.fn.mkdir(outside_git .. "/notes", "p")
vim.fn.writefile({}, outside_git .. "/notes/b.md")
vim.fn.writefile({}, outside_git .. "/a.markdown")
vim.fn.writefile({}, outside_git .. "/c.txt")
assert(
	vim.deep_equal(utils.list_markdown_files(outside_git), { "a.markdown", "notes/b.md" }),
	"should walk the directory outside a git repository"
)

print()
print("read_file()")
local raw_packspec = utils.read_file(vim.fs.joinpath(plugin_path, "pkg.json"))
assert(type(raw_packspec) == "string" and #raw_packspec > 0, "should return a string with content")
assert(vim.json.decode(raw_packspec), "The content of pkg.json should be a valid JSON string")

print()
print("get_relative_path()")
local relative_path =
	utils.get_relative_path("/home/user/.config/nvim/lua/livepreview/utils.lua", "/home/user/.config/nvim/")
assert(relative_path == "lua/livepreview/utils.lua", "should return the relative path")

print()
print("is_absolute_path()")
assert(utils.is_absolute_path("/home/user/.config/nvim/lua/livepreview/utils.lua"), "should return true in Unix")
assert(
	utils.is_absolute_path("C:\\Users\\user\\AppData\\Local\\nvim\\lua\\livepreview\\utils.lua"),
	"should return true in Windows"
)
assert(not utils.is_absolute_path("lua/livepreview/utils.lua"), "should return false")
