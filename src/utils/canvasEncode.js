'use strict';

/**
 * Encodes a node-canvas surface without blocking the event loop.
 *
 * `canvas.toBuffer()` — the argument-less form, and the `toBuffer('image/png')`
 * form — is a fully synchronous encode. It is not a cheap one: the 800×300
 * welcome card measures around 10 ms, more once a real avatar has been
 * composited in, and every millisecond of it is a millisecond the gateway
 * cannot read a heartbeat (#592).
 *
 * node-canvas also exposes a callback form, and that one hands the PNG encode
 * to libuv's thread pool. The pixels are still drawn on the main thread — that
 * part is the canvas API and cannot move — but the encode, which is the
 * expensive half, stops being ours.
 */

/**
 * @param {import('canvas').Canvas} canvas
 * @param {string} [mimeType] anything node-canvas encodes: PNG, or JPEG where the image is photographic enough that PNG runs large.
 * @param {object} [config] the encoder's options, e.g. `{ quality: 0.9 }` for JPEG.
 * @returns {Promise<Buffer>}
 */
function encodeCanvas(canvas, mimeType = 'image/png', config) {
    return new Promise((resolve, reject) => {
        const done = (err, buffer) => {
            if (err) return reject(err);
            resolve(buffer);
        };
        if (config) canvas.toBuffer(done, mimeType, config);
        else canvas.toBuffer(done, mimeType);
    });
}

module.exports = { encodeCanvas };
