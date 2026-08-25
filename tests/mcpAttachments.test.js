'use strict';

// A tool that answers with a picture.
//
// Every non-text block used to become "[image content omitted]" — the one thing
// a Discord bot is better placed to handle than any other MCP client, thrown
// away. The bytes go to the channel as a file now, and the model is told one
// arrived so it can refer to it instead of answering as though the tool
// returned nothing.
//
// The other half is what is refused: this is a third party's server handing
// bytes to a bot that can post files into a channel, so the type has to be one
// of a small known set and the size has to fit.

const mockListTools = jest.fn();
const mockCallTool = jest.fn();
const mockClose = jest.fn(async () => {});

jest.mock('../src/services/ai/mcp/client', () => {
    class McpError extends Error {}
    return {
        McpError,
        MAX_RESPONSE_BYTES: 2 * 1024 * 1024,
        McpHttpClient: class {
            constructor() {
                this.listTools = mockListTools;
                this.callTool = mockCallTool;
                this.close = mockClose;
            }
        }
    };
});

const {
    prepareMcpToolkit,
    renderResult,
    resetMcpCache,
    MAX_ATTACHMENTS_PER_RESULT
} = require('../src/services/ai/mcp/toolkit');
const { createToolActivity, MAX_ATTACHMENTS } = require('../src/services/ai/mcp/activity');

const GITHUB = { name: 'github', url: 'https://api.githubcopilot.com/mcp/', enabled: true };

const base64 = (bytes = 8) => Buffer.alloc(bytes, 1).toString('base64');
const image = (mimeType = 'image/png', bytes) => ({ type: 'image', data: base64(bytes), mimeType });
const result = content => ({ content, structuredContent: null, isError: false });

beforeEach(() => {
    jest.clearAllMocks();
    resetMcpCache();
    mockListTools.mockResolvedValue([{ name: 'render_chart' }]);
});

describe('what becomes a file', () => {
    test('an image block, named after the tool that produced it', async () => {
        const { text, attachments } = renderResult(result([image()]), { namePrefix: 'render_chart-1' });

        expect(attachments).toHaveLength(1);
        expect(attachments[0].name).toBe('render_chart-1-1.png');
        expect(Buffer.isBuffer(attachments[0].buffer)).toBe(true);
        // The model cannot use the bytes, but it can refer to the picture.
        expect(text).toBe('[image sent to the channel as render_chart-1-1.png]');
    });

    test('audio, and a PDF handed back as a resource blob', async () => {
        const { attachments } = renderResult(result([
            { type: 'audio', data: base64(), mimeType: 'audio/mpeg' },
            { type: 'resource', resource: { uri: 'file:///r.pdf', blob: base64(), mimeType: 'application/pdf' } }
        ]), { namePrefix: 'x' });

        expect(attachments.map(a => a.name)).toEqual(['x-1.mp3', 'x-2.pdf']);
    });

    test('text still reads as text, alongside the picture', async () => {
        const { text, attachments } = renderResult(result([
            { type: 'text', text: 'Here is last week.' },
            image()
        ]), { namePrefix: 'x' });

        expect(text).toBe('Here is last week.\n[image sent to the channel as x-1.png]');
        expect(attachments).toHaveLength(1);
    });

    test('a text resource is still read, not attached', async () => {
        const { text, attachments } = renderResult(result([
            { type: 'resource', resource: { uri: 'file:///r.md', text: '# Notes' } }
        ]), { namePrefix: 'x' });

        expect(text).toBe('# Notes');
        expect(attachments).toEqual([]);
    });
});

describe('what does not', () => {
    const omitted = content => renderResult(result(content), { namePrefix: 'x' });

    test('a type outside the small set worth showing', () => {
        // An allow list, not "anything with a mimeType": the far side must not
        // be able to drop an executable into somebody's channel.
        const { text, attachments } = omitted([{ type: 'image', data: base64(), mimeType: 'application/zip' }]);
        expect(attachments).toEqual([]);
        expect(text).toBe('[image content omitted]');
    });

    test('a block with no content type at all', () => {
        expect(omitted([{ type: 'image', mimeType: 'image/png' }]).attachments).toEqual([]);
    });

    test('something too big to hold until the reply lands', () => {
        const { attachments } = omitted([image('image/png', 3 * 1024 * 1024)]);
        expect(attachments).toEqual([]);
    });

    test('more than one result is allowed to carry', () => {
        const many = Array.from({ length: MAX_ATTACHMENTS_PER_RESULT + 3 }, () => image());
        const { attachments, text } = omitted(many);

        expect(attachments).toHaveLength(MAX_ATTACHMENTS_PER_RESULT);
        // The ones past the cap are reported rather than silently vanishing.
        expect(text).toContain('[image content omitted]');
    });
});

describe('reaching the transport', () => {
    test('the toolkit reports each file to whoever is listening', async () => {
        mockCallTool.mockResolvedValue(result([image()]));
        const seen = [];
        const toolkit = await prepareMcpToolkit([GITHUB], { onToolEvent: event => seen.push(event) });

        await toolkit.call('github__render_chart', {});

        const files = seen.filter(event => event.type === 'attachment');
        expect(files).toHaveLength(1);
        expect(files[0]).toMatchObject({ server: 'github', tool: 'render_chart', name: 'render_chart-1-1.png' });
    });

    test('two calls to one tool do not produce two files with one name', async () => {
        mockCallTool.mockResolvedValue(result([image()]));
        const seen = [];
        const toolkit = await prepareMcpToolkit([GITHUB], { onToolEvent: event => seen.push(event) });

        await toolkit.call('github__render_chart', {});
        await toolkit.call('github__render_chart', {});

        const names = seen.filter(e => e.type === 'attachment').map(e => e.name);
        expect(new Set(names).size).toBe(2);
    });

    test('a tool name is reduced to something that cannot be read as a path', async () => {
        mockListTools.mockResolvedValue([{ name: '../../etc/passwd' }]);
        mockCallTool.mockResolvedValue(result([image()]));
        const seen = [];
        const toolkit = await prepareMcpToolkit([GITHUB], { onToolEvent: event => seen.push(event) });

        await toolkit.call(toolkit.definitions[0].name, {});

        const [file] = seen.filter(e => e.type === 'attachment');
        expect(file.name).not.toContain('/');
        expect(file.name).not.toContain('..');
        expect(file.name).toMatch(/\.png$/);
    });
});

describe('collecting them for one reply', () => {
    const attachment = (name, bytes = 8) => ({
        type: 'attachment', id: 1, server: 'github', tool: 'render_chart',
        name, buffer: Buffer.alloc(bytes, 1)
    });

    test('hands them over in the shape discord.js takes', () => {
        const activity = createToolActivity();
        activity.onEvent(attachment('chart.png'));

        expect(activity.attachments).toEqual([{ attachment: expect.any(Buffer), name: 'chart.png' }]);
        expect(activity.used).toBe(true);
    });

    test('stops at the number a reply can carry without becoming a dump', () => {
        const activity = createToolActivity();
        for (let i = 0; i < MAX_ATTACHMENTS + 3; i++) activity.onEvent(attachment(`c${i}.png`));

        expect(activity.attachments).toHaveLength(MAX_ATTACHMENTS);
    });

    test('stops on total size before it stops on count', () => {
        // A reply that arrives is worth more than every picture in it.
        const activity = createToolActivity();
        activity.onEvent(attachment('big.png', 7 * 1024 * 1024));
        activity.onEvent(attachment('also-big.png', 7 * 1024 * 1024));

        expect(activity.attachments.map(a => a.name)).toEqual(['big.png']);
    });

    test('ignores an event carrying nothing', () => {
        const activity = createToolActivity();
        activity.onEvent({ type: 'attachment', name: 'nope.png' });
        activity.onEvent({ type: 'attachment', name: 'empty.png', buffer: Buffer.alloc(0) });

        expect(activity.attachments).toEqual([]);
        expect(activity.used).toBe(false);
    });

    test('a retried attempt does not send the same picture twice', () => {
        const activity = createToolActivity();
        activity.onEvent(attachment('chart.png'));
        activity.reset();

        expect(activity.attachments).toEqual([]);
    });
});
