// Single shared HTML-escaper for the dashboard views.
//
// Single quotes and backticks are escaped as well as the usual four, so the
// result is safe inside single-quoted attributes, not just double-quoted ones.
//
// It is NOT safe for building JavaScript source — an inline event handler's
// attribute value is HTML-decoded *before* it is parsed as JS, so `&#39;` turns
// back into a quote and closes the string it was meant to sit inside. Untrusted
// values belong in `data-*` attributes read back through `dataset`, wired up
// with addEventListener; never concatenate them into an `onclick="..."`.
function escHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/`/g, '&#96;');
}

if (typeof module !== 'undefined' && module.exports) module.exports = { escHtml };
