'use strict';

const { getTimeBand } = require('../src/utils/timeBand');

// 03:30 UTC: night in London, the evening before in Los Angeles, midday in Tokyo.
const AT = new Date('2026-01-15T03:30:00Z');

describe('getTimeBand', () => {
    it('reads the UTC hour when no timezone is given', () => {
        expect(getTimeBand(null, AT)).toMatchObject({ label: 'Night', local: false });
    });

    it('reads the player\'s own hour when they have set one', () => {
        expect(getTimeBand('America/Los_Angeles', AT)).toMatchObject({ label: 'Dusk', local: true });
        expect(getTimeBand('Asia/Tokyo', AT)).toMatchObject({ label: 'Noon', local: true });
    });

    it('falls back to UTC for a timezone that no longer resolves', () => {
        expect(getTimeBand('Not/AZone', AT)).toMatchObject({ label: 'Night', local: false });
    });
});
