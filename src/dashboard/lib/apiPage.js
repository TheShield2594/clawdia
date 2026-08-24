'use strict';

/**
 * The one list envelope the API answers with, and the one place `?page=` and
 * `?limit=` are parsed (#582, #583).
 *
 * Five shapes used to coexist across the routers — bare arrays, `{entries,…}`,
 * `{cases,…}`, bare objects and `{success:true,…}` — so a caller had to learn
 * each endpoint separately, and two of the lists could not be paged through at
 * all: knowledge base entries past the hundredth were unreachable behind a hard
 * `.limit(100)`, and summary jobs were returned unbounded.
 *
 * The convention, which tests/apiEnvelope.test.js holds every router to:
 *
 *   list      { items, page, limit, total, pages }   — always, even when empty
 *   resource  the object itself
 *   write     { success: true, … }
 *   error     { error: '…' }
 *
 * `items` rather than a per-endpoint name: a client that can render one page of
 * one collection can render every other, and the key that differed per route
 * was the inconsistency the issue was filed about. Nothing here is a bare
 * array — an array body cannot grow a field later without breaking every
 * caller, which is how the unpaginated lists got stuck in the first place.
 */

/**
 * Reads `?page=` and `?limit=` off a request, clamped.
 *
 * Both are clamped rather than rejected: a dashboard that asked for `limit=500`
 * should get the largest page the endpoint serves, not a 400 in the middle of a
 * table render. `limit` is capped because it is the only thing standing between
 * a query string and an unbounded scan.
 *
 * @param {import('express').Request} req
 * @param {{ defaultLimit?: number, maxLimit?: number }} [opts]
 * @returns {{ page: number, limit: number, skip: number }}
 */
function readPage(req, { defaultLimit = 20, maxLimit = 100 } = {}) {
    const page = Math.max(1, parseInt(req?.query?.page, 10) || 1);
    const requested = parseInt(req?.query?.limit, 10) || defaultLimit;
    const limit = Math.min(maxLimit, Math.max(1, requested));
    return { page, limit, skip: (page - 1) * limit };
}

/**
 * Wraps one page of results in the list envelope.
 *
 * `pages` is 1 for an empty collection, not 0: "page 1 of 0" is the kind of
 * thing a pager renders as a disabled control or a crash, and every caller
 * asking for page 1 of an empty list is asking a reasonable question.
 *
 * @param {{ items: any[], total: number, page: number, limit: number }} args
 */
function pageEnvelope({ items, total, page, limit }) {
    return {
        items,
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
    };
}

module.exports = { readPage, pageEnvelope };
