// The guild settings panels, in sidebar order.
//
// Only the default panel is rendered with the page; the rest arrive from
// /dashboard/guild/:guildId/panel/:panel on first visit. This list is what that
// endpoint validates against, so a request can never name an arbitrary template.
const PANELS = [
    'overview',
    'welcome',
    'farewell',
    'birthdays',
    'moderation',
    'leveling',
    'economy',
    'achievements',
    'raiddetection',
    'antinuke',
    'starboard',
    'eventlog',
    'quests',
    'exploration',
    'newspaper',
    'season',
    'progressiontracks',
    'suggestions',
    'reactionroles',
    'rss',
    'tempvoice',
    'commandpolicies',
    'ai',
    'analytics',
    'bibleverses',
];

const DEFAULT_PANEL = 'overview';

const PANEL_SET = new Set(PANELS);

function isPanel(name) {
    return PANEL_SET.has(name);
}

module.exports = { PANELS, DEFAULT_PANEL, isPanel };
