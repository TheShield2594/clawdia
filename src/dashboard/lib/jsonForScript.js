'use strict';

/**
 * Serializes a value for embedding inside an inline `<script>` block.
 *
 * A bare `JSON.stringify` is NOT safe here: any string in the data containing
 * `</script>` closes the block early, and the browser parses the remainder as
 * HTML. Guild settings are full of operator-controlled strings — shop item
 * names, job titles, command-policy entries — so that is a stored XSS vector.
 * The dashboard's CSP does not cover it either, because `script-src-attr
 * 'unsafe-inline'` still permits an injected inline event handler.
 *
 * Escaping `<`, `>` and `&` as unicode escapes keeps the output valid JSON —
 * `JSON.parse` maps them straight back — while making a tag breakout
 * impossible. U+2028 and U+2029 are escaped because they are legal inside a
 * JSON string but are raw line terminators in JavaScript source.
 *
 * Exposed to templates as `res.locals.jsonForScript`. Always use it instead of
 * `JSON.stringify` in a `<script>` context; tests/jsonForScript.test.js asserts
 * that no template reintroduces a bare one.
 */
function jsonForScript(value) {
    return JSON.stringify(value === undefined ? null : value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

module.exports = { jsonForScript };
