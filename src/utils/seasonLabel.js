'use strict';

// The name an economy season is shown under (#873, pass 18).
//
// `/season start`'s `name` option had no length limit, and the name is echoed
// into embed titles and field names — capped by Discord at 256 characters, over
// which discord.js throws rather than truncating. The option is capped at input
// now; this is the backstop for a name already stored before that cap, so an
// over-long one renders shortened instead of taking the command down with it.

const SEASON_NAME_MAX = 100;

/** A season's display name: its name, else its id, cut to SEASON_NAME_MAX. */
function seasonLabel(season) {
    const label = String(season?.name || season?.id || 'Season');
    return label.length > SEASON_NAME_MAX ? `${label.slice(0, SEASON_NAME_MAX - 1)}…` : label;
}

module.exports = { seasonLabel, SEASON_NAME_MAX };
