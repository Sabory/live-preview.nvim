// MIT License
//
// Copyright (c) 2017 Brett Walker
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
function livepreview_injectLinenumbersPlugin(md) {
	//
	// Inject the 1-indexed, inclusive source line range of each block, for sync
	// scroll and for mapping a selection in the preview back to the source.
	// Notes:
	//
	// - TODO Footnotes content causes jumps. Level limit filters it automatically.
	function markLines(token) {
		if (token.map) {
			token.attrJoin('class', 'source-line')
			token.attrSet('data-source-line', String(token.map[0] + 1))
			token.attrSet('data-source-end', String(token.map[1]))
		}
	}

	function injectLineNumbers(tokens, idx, options, env, slf) {
		markLines(tokens[idx])
		return slf.renderToken(tokens, idx, options, env, slf)
	}

	function wrapRule(name) {
		const render = md.renderer.rules[name]
		md.renderer.rules[name] = (tokens, idx, options, env, slf) => {
			markLines(tokens[idx])
			return render(tokens, idx, options, env, slf)
		}
	}

	md.renderer.rules.paragraph_open = injectLineNumbers
	md.renderer.rules.heading_open = injectLineNumbers
	md.renderer.rules.list_item_open = injectLineNumbers
	md.renderer.rules.table_open = injectLineNumbers
	md.renderer.rules.tr_open = injectLineNumbers
	md.renderer.rules.blockquote_open = injectLineNumbers
	wrapRule('fence')
	wrapRule('code_block')
}
