'use strict';

// The /fish cast button waits (reel-in and every boss phase) go through one
// helper. Two things it has to get right, both of which the inline collectors
// it replaced got wrong:
//   - a failed click acknowledgement must not leave the cast waiting forever
//     (the old handler awaited deferUpdate before resolving, and the collector's
//     `end` was told to ignore the 'limit' reason a collected click ends with);
//   - the window starts when the prompt is up, not before the edit that shows it.

const { EventEmitter } = require('events');


const { awaitCasterClick } = require('../src/commands/economy/fish/shared');

function fakeMessage() {
    const collector = new EventEmitter();
    collector.resetTimer = jest.fn();
    const message = { createMessageComponentCollector: jest.fn(() => collector) };
    return { message, collector };
}

const click = (customId, deferUpdate) => ({ customId, user: { id: 'u1' }, deferUpdate });

test('a click resolves even when acknowledging it fails', async () => {
    const { message, collector } = fakeMessage();
    const { choice } = awaitCasterClick(message, 'u1', ['reel']);

    collector.emit('collect', click('reel', () => Promise.reject(new Error('Unknown interaction'))));
    collector.emit('end', null, 'limit');

    await expect(choice).resolves.toBe('reel');
});

test('a window that closes with no click resolves null', async () => {
    const { message, collector } = fakeMessage();
    const { choice } = awaitCasterClick(message, 'u1', ['reel']);

    collector.emit('end', null, 'time');

    await expect(choice).resolves.toBeNull();
});

test('the collector is listening before the prompt is sent, and its window is set once it is up', () => {
    const { message, collector } = fakeMessage();
    const pick = awaitCasterClick(message, 'u1', ['reel']);

    expect(message.createMessageComponentCollector).toHaveBeenCalledTimes(1);
    expect(collector.resetTimer).not.toHaveBeenCalled();

    pick.start(2000);
    expect(collector.resetTimer).toHaveBeenCalledWith({ time: 2000 });
});
