'use strict';

// The two halves of the DM's new mechanics (#837), tested away from Discord and
// Mongo: the dice the model must ask for, and the effects it reports afterwards.
//
// Both take input written by a model, so most of what is worth asserting here is
// what happens when that input is wrong — a modifier of ten thousand, a target
// that is a goblin, a block that is not JSON. None of it may throw inside
// somebody's turn.

const {
    roll, parseNotation, describe: describeRoll, diceTool, MAX_DICE, MAX_ROLLS_PER_TURN
} = require('../src/services/dm/dice');
const {
    extractEffects, applyEffects, effectsInstruction, MAX_AMOUNT, MAX_EFFECTS, MAX_INVENTORY
} = require('../src/services/dm/effects');
const { proseEffects } = require('../src/services/dm/prose');

describe('dice notation', () => {
    test('reads the shapes a model writes', () => {
        expect(parseNotation('1d20')).toEqual({ count: 1, sides: 20, modifier: 0 });
        expect(parseNotation('2d6+3')).toEqual({ count: 2, sides: 6, modifier: 3 });
        expect(parseNotation(' 2d6 + 3 ')).toEqual({ count: 2, sides: 6, modifier: 3 });
        expect(parseNotation('1d8-1')).toEqual({ count: 1, sides: 8, modifier: -1 });
        expect(parseNotation('1D20')).toEqual({ count: 1, sides: 20, modifier: 0 });
    });

    test('refuses what is not a roll', () => {
        for (const bad of ['', null, undefined, 'd20', '20', 'roll a d20', '1d20+3d4', '1d20; DROP TABLE']) {
            expect(parseNotation(bad)).toBeNull();
        }
    });

    // A model that has decided the check needs a thousand dice is not describing
    // a check, and the answer is to say so rather than to compute it.
    test('refuses a roll nobody could mean', () => {
        expect(parseNotation(`${MAX_DICE + 1}d6`)).toBeNull();
        expect(parseNotation('1d1')).toBeNull();
        expect(parseNotation('1d101')).toBeNull();
        expect(parseNotation('1d20+9999')).toBeNull();
    });

    test('every die lands inside its own range', () => {
        for (let i = 0; i < 200; i++) {
            const result = roll('3d6+2');
            expect(result.rolls).toHaveLength(3);
            for (const die of result.rolls) {
                expect(die).toBeGreaterThanOrEqual(1);
                expect(die).toBeLessThanOrEqual(6);
            }
            expect(result.total).toBe(result.rolls.reduce((a, b) => a + b, 0) + 2);
        }
    });

    test('names a natural 20 and a natural 1, and only on a lone d20', () => {
        const seen = { critical: false, fumble: false };
        for (let i = 0; i < 400; i++) {
            const result = roll('1d20');
            expect(result.critical).toBe(result.rolls[0] === 20);
            expect(result.fumble).toBe(result.rolls[0] === 1);
            seen.critical ||= result.critical;
            seen.fumble ||= result.fumble;
        }
        expect(seen).toEqual({ critical: true, fumble: true });

        // Two dice summing to 20 is not a critical, and neither is a d6.
        for (let i = 0; i < 100; i++) {
            expect(roll('2d20').critical).toBe(false);
            expect(roll('1d6').fumble).toBe(false);
        }
    });

    // The description is the audit trail — "17" alone is not checkable, and
    // "17 (14 + 3)" is.
    test('shows its working', () => {
        const line = describeRoll({ notation: '1d20+3', rolls: [14], modifier: 3, total: 17 }, 'picks the lock');
        expect(line).toMatch(/picks the lock/);
        expect(line).toMatch(/1d20\+3/);
        expect(line).toMatch(/17/);
        expect(line).toMatch(/14 \+ 3/);
    });
});

describe('the dice_roll tool', () => {
    test('records what it rolled for the party to see', () => {
        const rolls = [];
        const answer = diceTool(rolls).run({ notation: '1d20', reason: 'Aric leaps the chasm' });

        expect(rolls).toHaveLength(1);
        expect(rolls[0].reason).toBe('Aric leaps the chasm');
        expect(answer).toMatch(/shown to the party/);
    });

    // Everything answers in words: the model reads the result and can try again,
    // rather than the turn failing on a typo.
    test('answers a bad notation instead of throwing', () => {
        const rolls = [];
        const answer = diceTool(rolls).run({ notation: 'a big one' });

        expect(rolls).toHaveLength(0);
        expect(answer).toMatch(/not a roll/);
    });

    test('stops a model that wants to roll all turn', () => {
        const rolls = [];
        const tool = diceTool(rolls);
        for (let i = 0; i < MAX_ROLLS_PER_TURN; i++) tool.run({ notation: '1d20' });

        expect(tool.run({ notation: '1d20' })).toMatch(/already used its/);
        expect(rolls).toHaveLength(MAX_ROLLS_PER_TURN);
    });

    test('needs nobody\'s approval and writes nothing', () => {
        const tool = diceTool([]);
        expect(tool.confirm).toBe(false);
        expect(tool.annotations.readOnlyHint).toBe(true);
        expect(tool.inputSchema.required).toEqual(['notation']);
    });
});

describe('pulling the effects block off a narration', () => {
    test('takes the trailing block and leaves the prose', () => {
        const { cleanText, effects, hadBlock } = extractEffects(
            'The trap springs.\nEFFECTS:[{"type":"damage","target":"Aric","amount":10}]'
        );

        expect(cleanText).toBe('The trap springs.');
        expect(hadBlock).toBe(true);
        expect(effects).toEqual([{ type: 'damage', target: 'Aric', amount: 10 }]);
    });

    test('a narration with no block is left alone', () => {
        const { cleanText, effects, hadBlock } = extractEffects('You look around the empty room.');

        expect(cleanText).toBe('You look around the empty room.');
        expect(hadBlock).toBe(false);
        expect(effects).toEqual([]);
    });

    // Anchored to the end, so a block with prose after it applies nothing — but
    // the tail is still cut, because half a JSON array in the middle of a scene
    // is not something to show the party either.
    test('a block that is not the last line applies nothing', () => {
        const { cleanText, effects, hadBlock } = extractEffects(
            'I would write\nEFFECTS:[{"type":"damage"}]\nbut nothing happened.'
        );

        expect(hadBlock).toBe(false);
        expect(effects).toEqual([]);
        expect(cleanText).toBe('I would write');
    });

    // The one that actually happens: the model hits maxTokens mid-array. The
    // effects are lost either way; what matters is that the fragment does not
    // end up in the embed.
    test('a block truncated mid-array is cut off the scene, not printed', () => {
        const { cleanText, effects, hadBlock } = extractEffects(
            'The trap springs.\nEFFECTS:[{"type":"damage","targ'
        );

        expect(cleanText).toBe('The trap springs.');
        expect(effects).toEqual([]);
        // No usable block, so the prose reader still gets its turn.
        expect(hadBlock).toBe(false);
    });

    test('a block holding something that is not a list yields nothing', () => {
        const { effects, hadBlock } = extractEffects('Scene.\nEFFECTS:{"type":"damage"}');
        expect(hadBlock).toBe(false);
        expect(effects).toEqual([]);
    });

    test('and one holding a hundred effects is cut to the cap', () => {
        const many = Array.from({ length: 100 }, () => ({ type: 'damage', target: 'Aric', amount: 1 }));
        const { effects } = extractEffects(`Scene.\nEFFECTS:${JSON.stringify(many)}`);
        expect(effects).toHaveLength(MAX_EFFECTS);
    });
});

describe('applying effects to a party', () => {
    const ARIC = { userId: 'u1', name: 'Aric', characterClass: 'Warrior', hp: 120, inventory: ['Longsword'] };
    const LYRA = { userId: 'u2', name: 'Lyra', characterClass: 'Mage', hp: 70, inventory: [] };
    const maxHpFor = p => ({ Warrior: 120, Mage: 70 })[p.characterClass] ?? 100;

    const apply = (effects, players = [ARIC, LYRA]) => applyEffects(players, effects, { maxHpFor });

    // The party comes out of Mongo. A hydrated subdocument spreads to
    // `{ __parentArray, $__, _doc }` — every field gone — so a turn applied to
    // one would silently damage an object with no `hp` on it, and the mocked
    // plain objects the service tests use would never notice.
    test('reads a Mongoose subdocument, not the wrapper around it', () => {
        const subdoc = fields => ({
            __parentArray: [], $__: {}, _doc: fields,
            toObject: () => ({ ...fields }),
            get hp() { return fields.hp; },
            get name() { return fields.name; },
        });
        const party = [subdoc({ userId: 'u1', name: 'Aric', characterClass: 'Warrior', hp: 120, inventory: ['Longsword'] })];

        const { players, changed } = applyEffects(party, [{ type: 'damage', target: 'Aric', amount: 20 }], { maxHpFor });

        expect(changed).toBe(true);
        expect(players[0].hp).toBe(100);
        expect(players[0].name).toBe('Aric');
        expect(players[0].inventory).toEqual(['Longsword']);
    });

    test('never mutates the party it was given', () => {
        const players = [{ ...ARIC }, { ...LYRA }];
        apply([{ type: 'damage', target: 'Aric', amount: 20 }], players);

        expect(players[0].hp).toBe(120);
        expect(players[0].inventory).toEqual(['Longsword']);
    });

    test('matches a name however the model cased it', () => {
        expect(apply([{ type: 'damage', target: ' aRiC ', amount: 20 }]).players[0].hp).toBe(100);
    });

    test('hits everybody still standing when the target is the party', () => {
        const fallen = { ...LYRA, hp: 0 };
        const after = apply([{ type: 'damage', target: 'everyone', amount: 10 }], [ARIC, fallen]).players;

        expect(after[0].hp).toBe(110);
        // Already down: nothing to take, and no second "has fallen" line.
        expect(after[1].hp).toBe(0);
    });

    test('clamps a silly number rather than dropping the effect', () => {
        expect(apply([{ type: 'damage', target: 'Aric', amount: 99999 }]).players[0].hp).toBe(0);
        expect(apply([{ type: 'heal', target: 'Aric', amount: MAX_AMOUNT * 10 }], [{ ...ARIC, hp: 1 }]).players[0].hp).toBe(120);
    });

    test('ignores an amount that is not a number, or is zero or negative', () => {
        for (const amount of ['a lot', null, 0, -5, NaN, Infinity]) {
            expect(apply([{ type: 'damage', target: 'Aric', amount }]).changed).toBe(false);
        }
    });

    test('says out loud when a character falls', () => {
        const { changes } = apply([{ type: 'damage', target: 'Lyra', amount: 500 }]);
        expect(changes.join('\n')).toMatch(/Lyra\*\* has fallen/);
    });

    test('adds and removes items, matching the item however it was written', () => {
        const { players } = apply([
            { type: 'add_item', target: 'Aric', item: '  Rusty   Key ' },
            { type: 'remove_item', target: 'Aric', item: 'LONGSWORD' },
        ]);

        expect(players[0].inventory).toEqual(['Rusty Key']);
    });

    test('removing something nobody has changes nothing', () => {
        expect(apply([{ type: 'remove_item', target: 'Aric', item: 'Crown' }]).changed).toBe(false);
    });

    test('a pack only holds so much', () => {
        const packed = { ...ARIC, inventory: Array.from({ length: MAX_INVENTORY }, (_, i) => `Item ${i}`) };
        const { players, changes } = apply([{ type: 'add_item', target: 'Aric', item: 'One more' }], [packed]);

        expect(players[0].inventory).toHaveLength(MAX_INVENTORY);
        expect(changes.join('\n')).toMatch(/pack is full/);
    });

    test('an unknown type, an unknown target and an empty item are all dropped', () => {
        expect(apply([{ type: 'polymorph', target: 'Aric' }]).changed).toBe(false);
        expect(apply([{ type: 'damage', target: 'the goblin', amount: 10 }]).changed).toBe(false);
        expect(apply([{ type: 'add_item', target: 'Aric', item: '   ' }]).changed).toBe(false);
    });

    test('nothing here throws on rubbish', () => {
        expect(() => applyEffects(null, null)).not.toThrow();
        expect(() => apply([null, 42, 'damage', { type: null }])).not.toThrow();
        expect(apply([null, 42, 'damage']).changed).toBe(false);
    });

    test('a scene is carried back, trimmed', () => {
        expect(apply([{ type: 'set_scene', scene: '  The flooded vault  ' }]).scene).toBe('The flooded vault');
        expect(apply([{ type: 'set_scene', scene: '   ' }]).scene).toBeNull();
    });
});

describe('the instruction the model is given', () => {
    test('names the party, so the model has the only targets that resolve', () => {
        const text = effectsInstruction([
            { name: 'Aric' }, { name: 'Lyra' },
        ]);

        expect(text).toMatch(/"Aric", "Lyra"/);
        expect(text).toMatch(/EFFECTS:/);
        // The hole the old regex left: what happens to somebody else still
        // has to be reported.
        expect(text).toMatch(/other than the one acting/);
    });

    test('and survives a party with nobody in it', () => {
        expect(() => effectsInstruction([])).not.toThrow();
    });
});

// The fallback, kept for the model that narrates a good scene and forgets the
// block. Its limits are the reason it is no longer the mechanism.
describe('the prose fallback', () => {
    const ARIC = { userId: 'u1', name: 'Aric', characterClass: 'Warrior', hp: 120, inventory: [] };
    const LYRA = { userId: 'u2', name: 'Lyra', characterClass: 'Mage', hp: 70, inventory: [] };

    test('reads a wound the sentence gives the acting character', () => {
        expect(proseEffects('Aric takes 15 damage.', ARIC, [ARIC])).toEqual([
            { type: 'damage', target: 'Aric', amount: 15 },
        ]);
    });

    test('and leaves the enemy\'s wound where it belongs', () => {
        expect(proseEffects('The goblin takes 12 damage.', ARIC, [ARIC])).toEqual([]);
    });

    test('but can only ever speak for the character who acted', () => {
        expect(proseEffects('Lyra takes 30 damage.', ARIC, [ARIC, LYRA])).toEqual([]);
    });

    test('a name full of regex metacharacters does not break it', () => {
        const odd = { ...ARIC, name: 'A(ric.*' };
        expect(proseEffects('A(ric.* takes 10 damage.', odd, [odd])).toEqual([
            { type: 'damage', target: 'A(ric.*', amount: 10 },
        ]);
    });
});
