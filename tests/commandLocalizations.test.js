'use strict';

// The localization contract, held the way tests/envExampleDrift.test.js holds
// `.env.example`: a command or option missing from any locale file — or a
// localized command name Discord would reject — turns `npm test` red, so a new
// command cannot ship untranslated by accident and a bad translation cannot take
// the whole deploy down at boot.

const {
    loadLocales,
    applyLocalizations,
    missingLocalizations,
    _resetCache,
} = require('../src/utils/commandLocalizations');
const { loadCommandModules } = require('../src/utils/commandLoader');
const { commandSetHash } = require('../src/utils/commandDeployer');
const { buildCategories } = require('../src/utils/helpCatalog');

function commandBodies() {
    const { commands, failures } = loadCommandModules();
    expect(failures).toEqual([]);
    return commands.map(({ command }) => command.data.toJSON());
}

describe('command localizations', () => {
    const { langs, locales } = loadLocales();

    test('at least one locale ships', () => {
        // The machinery is general, but a coverage test that guards zero locales
        // guards nothing.
        expect(langs.length).toBeGreaterThanOrEqual(1);
    });

    test('every command and option is translated in every locale, with valid names', () => {
        const problems = missingLocalizations(commandBodies(), locales);
        expect(problems).toEqual([]);
    });

    test('the loader applies the localizations to the builders', () => {
        // loadCommandModules calls applyLocalizations, so a loaded command should
        // already carry the localized name Discord will render.
        const { commands } = loadCommandModules();
        const help = commands.find(c => c.command.data.name === 'help').command.data;
        expect(help.name_localizations?.['es-ES']).toBe('ayuda');
        expect(help.description_localizations?.['es-ES']).toBeTruthy();
    });

    test('/help renders the localized name for the viewer locale', () => {
        const { commands } = loadCommandModules();
        const mods = commands.map(c => c.command);
        const categories = buildCategories(mods, 'es-ES');
        const names = categories.flatMap(cat => cat.commands.map(c => c.name));
        expect(names).toContain('ayuda');
        // A locale with no file falls back to the base name, as Discord does.
        const english = buildCategories(mods, 'en-US').flatMap(cat => cat.commands.map(c => c.name));
        expect(english).toContain('help');
    });

    test('a localization changes the deployed command hash', () => {
        // The boot-time deploy republishes when the hash changes, so a
        // localization edit has to move it — otherwise a translation would never
        // reach Discord.
        const clientId = '123';
        const withLocalizations = commandBodies();
        const stripped = withLocalizations.map(body => {
            const copy = JSON.parse(JSON.stringify(body));
            const strip = node => {
                delete node.name_localizations;
                delete node.description_localizations;
                for (const opt of node.options || []) strip(opt);
            };
            strip(copy);
            return copy;
        });
        expect(commandSetHash(clientId, withLocalizations)).not.toBe(commandSetHash(clientId, stripped));
    });
});

describe('applyLocalizations with a fixture set', () => {
    afterEach(() => _resetCache());

    test('sets name and description maps only where an entry exists', () => {
        const fixture = {
            'fr': { demo: { name: 'démo', description: 'une démo', options: { x: { description: 'la valeur' } } } },
        };
        // A minimal fake builder mirroring the shape applyLocalizations walks.
        const calls = { name: null, desc: null, optDesc: null };
        const builder = {
            name: 'demo',
            setNameLocalizations(m) { calls.name = m; return this; },
            setDescriptionLocalizations(m) { calls.desc = m; return this; },
            options: [{
                name: 'x',
                setNameLocalizations() { throw new Error('option name should not be set'); },
                setDescriptionLocalizations(m) { calls.optDesc = m; return this; },
            }],
        };

        applyLocalizations(builder, fixture);
        expect(calls.name).toEqual({ fr: 'démo' });
        expect(calls.desc).toEqual({ fr: 'une démo' });
        expect(calls.optDesc).toEqual({ fr: 'la valeur' });
    });
});
