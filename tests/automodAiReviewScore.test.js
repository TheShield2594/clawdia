'use strict';

// #1017: how a filter trip's AI review flows into the case and the behaviour
// score. The review is attached to the case either way; a false-positive verdict
// holds the score back only when the guild opted into that, so one wrong filter
// cannot walk a member up the ladder — while the case is still filed.

jest.mock('../src/models/User', () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../src/models/Case', () => ({ findOne: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../src/services/moderationLogService', () => ({ logModeration: jest.fn() }));
jest.mock('../src/services/aiFilterReviewService', () => ({
    reviewFilterTrip: jest.fn(),
    aiReviewEnabled: jest.fn(() => true),
}));

const User = require('../src/models/User');
const Case = require('../src/models/Case');
const { logModeration } = require('../src/services/moderationLogService');
const { reviewFilterTrip } = require('../src/services/aiFilterReviewService');
const { applyAutoModAction } = require('../src/services/autoModService');
const { makeMessage } = require('./helpers/messageCreateMessage');

function settings(over = {}) {
    return {
        moderation: {
            behaviorScoreMuteAt: 10, behaviorScoreKickAt: 20, behaviorScoreBanAt: 30,
            behaviorScoreDecayDays: 7, warnThreshold: 3,
            ...over,
        },
    };
}

function userDoc(score = 0) {
    const doc = { userId: 'author1', guildId: 'guild1', behaviorScore: score, lastScoreDecay: null };
    doc.save = jest.fn(async () => {});
    return doc;
}

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    Case.countDocuments.mockResolvedValue(0);
    Case.findOne.mockResolvedValue(null);
});
afterEach(() => jest.restoreAllMocks());

/** The aiReview the mod-log/case was given, from the logModeration warn call. */
function reviewFiledOnCase() {
    const warnCall = logModeration.mock.calls.find(c => c[1] === 'warn');
    return warnCall?.[5]?.aiReview;
}

const FALSE_POSITIVE = { verdict: 'false_positive', reason: 'A Batman reference.', model: 'gpt-x', at: new Date() };
const VIOLATION = { verdict: 'violation', reason: 'A slur.', model: 'gpt-x', at: new Date() };

it('attaches the review to the case whatever the verdict', async () => {
    reviewFilterTrip.mockResolvedValue(FALSE_POSITIVE);
    const doc = userDoc(0);
    User.findOne.mockResolvedValue(doc);

    await applyAutoModAction(makeMessage('Dick Grayson is Robin'), settings(), 'using prohibited language', 2);

    expect(reviewFiledOnCase()).toEqual(FALSE_POSITIVE);
});

it('holds the behaviour score back on a false positive when the guild opted in', async () => {
    reviewFilterTrip.mockResolvedValue(FALSE_POSITIVE);
    const doc = userDoc(5);
    User.findOne.mockResolvedValue(doc);

    await applyAutoModAction(
        makeMessage('Dick Grayson is Robin'),
        settings({ aiReviewSkipScoreOnFalsePositive: true }),
        'using prohibited language', 2
    );

    // The case was still filed; only the score was spared.
    expect(reviewFiledOnCase().verdict).toBe('false_positive');
    expect(doc.behaviorScore).toBe(5);
    expect(doc.save).toHaveBeenCalled();
});

it('still scores a false positive when the guild did not opt in', async () => {
    reviewFilterTrip.mockResolvedValue(FALSE_POSITIVE);
    const doc = userDoc(5);
    User.findOne.mockResolvedValue(doc);

    await applyAutoModAction(
        makeMessage('Dick Grayson is Robin'),
        settings({ aiReviewSkipScoreOnFalsePositive: false }),
        'using prohibited language', 2
    );

    expect(doc.behaviorScore).toBe(7);
});

it('scores a genuine violation even with the skip setting on', async () => {
    reviewFilterTrip.mockResolvedValue(VIOLATION);
    const doc = userDoc(5);
    User.findOne.mockResolvedValue(doc);

    await applyAutoModAction(
        makeMessage('a real slur'),
        settings({ aiReviewSkipScoreOnFalsePositive: true }),
        'using prohibited language', 2
    );

    expect(doc.behaviorScore).toBe(7);
});

it('scores normally when there is no review', async () => {
    reviewFilterTrip.mockResolvedValue(null);
    const doc = userDoc(0);
    User.findOne.mockResolvedValue(doc);

    await applyAutoModAction(
        makeMessage('https://example.com'),
        settings({ aiReviewSkipScoreOnFalsePositive: true }),
        'posting a link', 1
    );

    expect(doc.behaviorScore).toBe(1);
    expect(reviewFiledOnCase()).toBeNull();
});
