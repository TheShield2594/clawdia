'use strict';

// An article's picture and byline, as the RSS poller finds them. Each case is a
// real way a feed attaches one; the refusals are the ways a feed attaches
// something that is not one.

const Parser = require('rss-parser');
const { MEDIA_CUSTOM_FIELDS, articleImage, articleByline } = require('../src/utils/feedMedia');

const parser = new Parser({ customFields: MEDIA_CUSTOM_FIELDS });

async function firstItem(itemXml) {
    const feed = await parser.parseString(`<?xml version="1.0"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel><title>F</title><item><title>A</title>${itemXml}</item></channel></rss>`);
    return feed.items[0];
}

describe('articleImage', () => {
    test('reads <media:content> that is an image', async () => {
        const item = await firstItem('<media:content url="https://cdn.example/a.jpg" medium="image"/>');
        expect(articleImage(item)).toBe('https://cdn.example/a.jpg');
    });

    test('skips <media:content> that is a video for a thumbnail', async () => {
        const item = await firstItem(
            '<media:content url="https://cdn.example/a.mp4" type="video/mp4"/>' +
            '<media:thumbnail url="https://cdn.example/a-thumb.jpg"/>');
        expect(articleImage(item)).toBe('https://cdn.example/a-thumb.jpg');
    });

    test('looks inside <media:group>, the YouTube shape', async () => {
        const item = await firstItem('<media:group><media:thumbnail url="https://i.ytimg.com/vi/x/hq.jpg"/></media:group>');
        expect(articleImage(item)).toBe('https://i.ytimg.com/vi/x/hq.jpg');
    });

    test('takes an image enclosure but never a podcast episode', async () => {
        expect(articleImage(await firstItem('<enclosure url="https://cdn.example/a.png" type="image/png" length="1"/>')))
            .toBe('https://cdn.example/a.png');
        expect(articleImage(await firstItem('<enclosure url="https://cdn.example/ep.mp3" type="audio/mpeg" length="1"/>')))
            .toBeNull();
    });

    test('falls back to podcast episode art', async () => {
        const item = await firstItem('<itunes:image href="https://cdn.example/ep.jpg"/>');
        expect(articleImage(item)).toBe('https://cdn.example/ep.jpg');
    });

    test('falls back to the first <img> in the article, the WordPress shape', async () => {
        const item = await firstItem('<content:encoded><![CDATA[<p>Hi</p><img class="x" src="https://blog.example/wp/a.jpg?w=1&amp;h=2"><img src="https://blog.example/b.jpg">]]></content:encoded>');
        expect(articleImage(item)).toBe('https://blog.example/wp/a.jpg?w=1&h=2');
    });

    test('is null when the article has no picture', async () => {
        expect(articleImage(await firstItem('<description>Just text</description>'))).toBeNull();
    });
});

describe('articleByline', () => {
    test('reads <dc:creator>', async () => {
        expect(articleByline(await firstItem('<dc:creator>Jane Doe</dc:creator>'))).toBe('Jane Doe');
    });

    test('keeps the name from an RSS 2.0 "email (Name)" author', async () => {
        expect(articleByline(await firstItem('<author>jane@example.com (Jane Doe)</author>'))).toBe('Jane Doe');
    });

    test('drops a bare email address', async () => {
        expect(articleByline(await firstItem('<author>jane@example.com</author>'))).toBe('');
    });

    test('reads an Atom author', async () => {
        const feed = await parser.parseString(`<feed xmlns="http://www.w3.org/2005/Atom"><title>t</title>
<entry><title>e</title><id>1</id><author><name>Bob</name></author></entry></feed>`);
        expect(articleByline(feed.items[0])).toBe('Bob');
    });
});
