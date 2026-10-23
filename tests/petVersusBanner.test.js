'use strict';

// #1184 — the member battle's banner: both portraits on one strip, drawn for
// real, and the fallbacks when art is missing or will not decode.

const { AttachmentBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('canvas');
const { renderVersusBanner, BANNER_NAME } = require('../src/utils/petVersusBanner');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function portrait(color) {
    const c = createCanvas(64, 64);
    const ctx = c.getContext('2d');
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 64, 64);
    const buffer = c.toBuffer('image/png');
    return { url: 'attachment://p.png', attachment: new AttachmentBuilder(buffer, { name: 'p.png' }) };
}

beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => jest.restoreAllMocks());

test('both portraits draw onto one PNG, named for the embed image', async () => {
    const banner = await renderVersusBanner(portrait('#ff0000'), portrait('#0000ff'), { alt: 'Rex versus Tom' });

    expect(banner.name).toBe(BANNER_NAME);
    expect(banner.description).toBe('Rex versus Tom');
    expect(banner.attachment.subarray(0, 4)).toEqual(PNG_MAGIC);
    const img = await loadImage(banner.attachment);
    expect([img.width, img.height]).toEqual([480, 200]);
});

test('one portrait is still a banner; none is no banner', async () => {
    expect(await renderVersusBanner(portrait('#ff0000'), null)).not.toBeNull();
    expect(await renderVersusBanner(null, null)).toBeNull();
});

test('art that will not decode falls back to no banner rather than failing the battle', async () => {
    const broken = { url: 'attachment://x.png', attachment: new AttachmentBuilder(Buffer.from('not a png'), { name: 'x.png' }) };
    expect(await renderVersusBanner(broken, broken)).toBeNull();
});
