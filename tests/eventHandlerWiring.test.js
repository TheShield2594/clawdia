'use strict';

// src/index.js reads every file in src/events and does
// `client.on(event.name, ...)` with it. Nothing validates the name, so a
// handler registered under a string discord.js never emits is a feature that is
// simply switched off — no error, no warning, and the file still looks wired.
//
// `ready` became `clientReady` in discord.js v14.16 exactly this way, which is
// why the check is against the library's own Events map rather than a list kept
// here.

const fs = require('fs');
const path = require('path');
const { Events } = require('discord.js');

const EVENTS_DIR = path.join(__dirname, '..', 'src', 'events');
const files = fs.readdirSync(EVENTS_DIR).filter(file => file.endsWith('.js')).sort();

const GATEWAY_EVENTS = new Set(Object.values(Events));

it('finds the handler directory index.js loads', () => {
    expect(files.length).toBeGreaterThan(0);
});

describe.each(files)('%s', file => {
    const handler = require(path.join(EVENTS_DIR, file));

    it('is registered under an event discord.js actually emits', () => {
        expect(GATEWAY_EVENTS.has(handler.name)).toBe(true);
    });

    it('exports an execute() index.js can call', () => {
        expect(typeof handler.execute).toBe('function');
    });
});

it('registers each gateway event only once', () => {
    // Two files claiming the same name both run on every event, which for
    // anything that writes is a double write.
    const names = files.map(file => require(path.join(EVENTS_DIR, file)).name);
    expect(names).toHaveLength(new Set(names).size);
});
