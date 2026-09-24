'use strict';

// The guild command-policy check, now shared by the slash-command dispatcher
// and the buttons that start what a command would (/hunt's "Hunt again").

jest.mock('../src/utils/commandCooldowns', () => ({ claimIfAvailable: jest.fn() }));

const cooldownStore = require('../src/utils/commandCooldowns');
const {
    getPolicyDecision, isWithinRuleWindow, memberHasAnyRole,
    getCooldownSeconds, getCooldownKey, claimCommandCooldown,
} = require('../src/utils/commandPolicy');

const member = roleIds => ({ roles: { cache: new Map(roleIds.map(id => [id, {}])) } });
const ctx = (over = {}) => ({ commandName: 'hunt', user: { id: 'u1' }, member: member([]), channelId: 'c1', ...over });
const policy = (rules, exceptions = {}) => ({ commandPolicies: { enabled: true, rules, exceptions } });

describe('getPolicyDecision', () => {
    test('allows everything while policies are off', () => {
        expect(getPolicyDecision(ctx(), { commandPolicies: { enabled: false, rules: [{ command: '*', effect: 'deny' }] } }))
            .toEqual({ allowed: true });
        expect(getPolicyDecision(ctx(), null)).toEqual({ allowed: true });
    });

    test('denies a matching rule, and says why', () => {
        const decision = getPolicyDecision(ctx(), policy([{ command: 'hunt', effect: 'deny', channelIds: ['c1'] }]));
        expect(decision.allowed).toBe(false);
        expect(decision.reason).toMatch(/blocked by server policy/);
    });

    test('a rule for another channel, role or command does not apply', () => {
        expect(getPolicyDecision(ctx(), policy([{ command: 'hunt', effect: 'deny', channelIds: ['c2'] }])).allowed).toBe(true);
        expect(getPolicyDecision(ctx(), policy([{ command: 'hunt', effect: 'deny', roleIds: ['r1'] }])).allowed).toBe(true);
        expect(getPolicyDecision(ctx(), policy([{ command: 'fish', effect: 'deny' }])).allowed).toBe(true);
    });

    test('a wildcard rule covers every command', () => {
        expect(getPolicyDecision(ctx(), policy([{ command: '*', effect: 'deny' }])).allowed).toBe(false);
    });

    test('user and role exceptions win over any rule', () => {
        const rules = [{ command: '*', effect: 'deny' }];
        expect(getPolicyDecision(ctx(), policy(rules, { userIds: ['u1'] })).allowed).toBe(true);
        expect(getPolicyDecision(ctx({ member: member(['vip']) }), policy(rules, { roleIds: ['vip'] })).allowed).toBe(true);
    });

    test('the command name can be given for an interaction that is not the command', () => {
        const button = { user: { id: 'u1' }, member: member([]), channelId: 'c1' };
        expect(getPolicyDecision(button, policy([{ command: 'hunt', effect: 'deny' }]), 'hunt').allowed).toBe(false);
        expect(getPolicyDecision(button, policy([{ command: 'hunt', effect: 'deny' }]), 'fish').allowed).toBe(true);
    });
});

describe('isWithinRuleWindow', () => {
    const at = iso => new Date(iso);

    test('no window means always', () => {
        expect(isWithinRuleWindow({}, at('2026-09-24T03:00:00Z'))).toBe(true);
    });

    test('a same-day window is inclusive at both ends', () => {
        const rule = { startHourUtc: 9, endHourUtc: 17 };
        expect(isWithinRuleWindow(rule, at('2026-09-24T09:00:00Z'))).toBe(true);
        expect(isWithinRuleWindow(rule, at('2026-09-24T17:30:00Z'))).toBe(true);
        expect(isWithinRuleWindow(rule, at('2026-09-24T18:00:00Z'))).toBe(false);
    });

    test('a window can wrap past midnight', () => {
        const rule = { startHourUtc: 22, endHourUtc: 2 };
        expect(isWithinRuleWindow(rule, at('2026-09-24T23:00:00Z'))).toBe(true);
        expect(isWithinRuleWindow(rule, at('2026-09-24T01:00:00Z'))).toBe(true);
        expect(isWithinRuleWindow(rule, at('2026-09-24T12:00:00Z'))).toBe(false);
    });

    test('days of the week narrow it', () => {
        // 2026-09-24 is a Thursday (4).
        expect(isWithinRuleWindow({ daysOfWeek: [4] }, at('2026-09-24T12:00:00Z'))).toBe(true);
        expect(isWithinRuleWindow({ daysOfWeek: [0, 6] }, at('2026-09-24T12:00:00Z'))).toBe(false);
    });
});

describe('memberHasAnyRole', () => {
    test('is false for no member or no roles to match', () => {
        expect(memberHasAnyRole(null, ['r'])).toBe(false);
        expect(memberHasAnyRole(member(['r']), [])).toBe(false);
    });

    test('matches any one of the roles', () => {
        expect(memberHasAnyRole(member(['a', 'b']), ['x', 'b'])).toBe(true);
    });
});

describe('command cooldowns', () => {
    const command = (over = {}) => ({ cooldown: 5, data: { name: 'hunt' }, ...over });
    const who = roles => ({ user: { id: 'u1' }, guild: { id: 'g1' }, member: member(roles) });

    test('uses the command\'s own cooldown, or 3s without one, or a function of the interaction', () => {
        expect(getCooldownSeconds(command(), who([]), {})).toBe(5);
        expect(getCooldownSeconds(command({ cooldown: undefined }), who([]), {})).toBe(3);
        expect(getCooldownSeconds(command({ cooldownAmount: () => 30 }), who([]), {})).toBe(30);
        expect(getCooldownSeconds(command({ cooldown: -1 }), who([]), {})).toBe(3);
    });

    test('the shortest matching role override wins, and non-matching roles are ignored', () => {
        const settings = { commandPolicies: { cooldownOverrides: [
            { command: 'hunt', roleId: 'a', cooldownSeconds: 60 },
            { command: 'hunt', roleId: 'b', cooldownSeconds: 20 },
            { command: 'hunt', roleId: 'c', cooldownSeconds: 1 },
            { command: 'fish', roleId: 'a', cooldownSeconds: 0 },
        ] } };
        expect(getCooldownSeconds(command(), who(['a', 'b']), settings)).toBe(20);
        expect(getCooldownSeconds(command(), who([]), settings)).toBe(5);
    });

    test('an absurd cooldown is clamped to what a timer can hold', () => {
        expect(getCooldownSeconds(command({ cooldown: 1e12 }), who([]), {})).toBe(Math.floor(2_147_483_647 / 1000));
    });

    test('the bucket is the command name unless the command keys its own', () => {
        expect(getCooldownKey(command(), who([]))).toBe('hunt');
        expect(getCooldownKey(command({ cooldownKey: () => 'hunt:start' }), who([]))).toBe('hunt:start');
    });

    test('a free cooldown is claimed and nothing is said', async () => {
        cooldownStore.claimIfAvailable.mockResolvedValueOnce(0);
        expect(await claimCommandCooldown({}, command(), who([]), {})).toBeNull();
        expect(cooldownStore.claimIfAvailable).toHaveBeenLastCalledWith({}, { bucket: 'hunt', userId: 'u1', guildId: 'g1', cooldownMs: 5000 });
    });

    test('a held one says when it lifts, with the full date past twelve hours', async () => {
        const soon = Date.now() + 60_000;
        cooldownStore.claimIfAvailable.mockResolvedValueOnce(soon);
        expect(await claimCommandCooldown({}, command(), who([]), {}))
            .toBe(`Please wait, you are on cooldown. You can use \`/hunt\` again <t:${Math.round(soon / 1000)}:R>.`);

        const later = Date.now() + 13 * 3_600_000;
        cooldownStore.claimIfAvailable.mockResolvedValueOnce(later);
        expect(await claimCommandCooldown({}, command(), who([]), {})).toContain(`(<t:${Math.round(later / 1000)}:F>)`);
    });
});
