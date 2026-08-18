const { isVersionError, withVersionRetry } = require('../src/utils/versionRetry');

function versionError() {
    const err = new Error('No matching document found for id "x" version 3');
    err.name = 'VersionError';
    return err;
}

// Minimal stand-in for a Mongoose document: save() fails with a VersionError for
// the first `failures` calls, then succeeds.
function fakeDoc(failures = 0) {
    const doc = {
        value: 0,
        saves: 0,
        async save() {
            doc.saves++;
            if (doc.saves <= failures) throw versionError();
        },
    };
    return doc;
}

describe('isVersionError', () => {
    it('recognises a Mongoose VersionError', () => {
        expect(isVersionError(versionError())).toBe(true);
    });

    it('rejects anything else, including null', () => {
        expect(isVersionError(new Error('boom'))).toBe(false);
        expect(isVersionError(null)).toBe(false);
        expect(isVersionError(undefined)).toBe(false);
    });
});

describe('withVersionRetry', () => {
    it('saves once when there is no conflict', async () => {
        const doc = fakeDoc(0);
        const saved = await withVersionRetry(() => doc, d => { d.value = 1; });
        expect(saved).toBe(doc);
        expect(doc.saves).toBe(1);
        expect(doc.value).toBe(1);
    });

    it('re-reads and re-applies the mutation on a lost version race', async () => {
        const docs = [fakeDoc(1), fakeDoc(0)];
        let loads = 0;
        const saved = await withVersionRetry(
            () => docs[loads++],
            d => { d.value = 42; },
            { backoffMs: 0 }
        );
        expect(loads).toBe(2);
        expect(saved).toBe(docs[1]);      // the fresh read is what got saved
        expect(docs[1].value).toBe(42);   // and the mutation was re-applied to it
    });

    it('throws the last VersionError once the attempts are spent', async () => {
        const doc = fakeDoc(Infinity);
        await expect(
            withVersionRetry(() => doc, () => {}, { attempts: 3, backoffMs: 0 })
        ).rejects.toMatchObject({ name: 'VersionError' });
        expect(doc.saves).toBe(3);
    });

    it('rethrows non-version errors immediately without retrying', async () => {
        const doc = {
            saves: 0,
            async save() { this.saves++; throw new Error('connection reset'); },
        };
        await expect(
            withVersionRetry(() => doc, () => {}, { backoffMs: 0 })
        ).rejects.toThrow('connection reset');
        expect(doc.saves).toBe(1);
    });

    it('returns null without saving when the loader finds nothing', async () => {
        const mutate = jest.fn();
        expect(await withVersionRetry(() => null, mutate)).toBeNull();
        expect(mutate).not.toHaveBeenCalled();
    });

    it('returns null without saving when the mutation aborts', async () => {
        const doc = fakeDoc(0);
        expect(await withVersionRetry(() => doc, () => false)).toBeNull();
        expect(doc.saves).toBe(0);
    });

    it('passes the attempt number to the mutation', async () => {
        const docs = [fakeDoc(1), fakeDoc(0)];
        let loads = 0;
        const attempts = [];
        await withVersionRetry(
            () => docs[loads++],
            (_doc, attempt) => { attempts.push(attempt); },
            { backoffMs: 0 }
        );
        expect(attempts).toEqual([1, 2]);
    });
});
