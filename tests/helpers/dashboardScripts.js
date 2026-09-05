'use strict';

// The guild settings page's own scripts, and their source.
//
// It was one guild-settings.js until #935 and is a dozen files now — the shared
// machinery, one script per panel, then the shell. So a suite that sweeps "the
// page's JavaScript" has to sweep all of them: reading one file would report
// clean for a rule that the eleven it never opened are breaking.
//
// The list comes from scripts/build-assets.js, which is the same list
// views/guild-settings.ejs loads and the image minifies, in the order they
// execute. One list rather than three copies of it, and
// tests/guildSettingsView holds the view to it.

const fs = require('fs');
const path = require('path');
const { SOURCES, PUBLIC } = require('../../scripts/build-assets');

/** Every first-party script on the page, in load order. */
const PAGE_SCRIPTS = SOURCES.filter(file => file.endsWith('.js'));

/** One script's source. */
const readScript = file => fs.readFileSync(path.join(PUBLIC, file), 'utf8');

/** Every page script's source, joined in load order. */
const pageScriptSource = () => PAGE_SCRIPTS.map(readScript).join('\n');

module.exports = { PUBLIC, PAGE_SCRIPTS, readScript, pageScriptSource };
