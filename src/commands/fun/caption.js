const { SlashCommandBuilder, AttachmentBuilder, MessageFlags } = require('discord.js');
const { createCanvas, loadImage } = require('canvas');
const dns = require('dns');
const { checkImageRateLimit } = require('../../utils/imageRateLimit');

const MAX_WIDTH   = 800;
const MAX_DIM     = 4000;
const CAPTION_H   = 70;
const FONT_SIZE   = 28;
const LINE_HEIGHT = FONT_SIZE * 1.25;
const LOAD_TIMEOUT_MS = 10_000;

const _measCtx = createCanvas(1, 1).getContext('2d');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('caption')
        .setDescription('Add a caption to any image URL')
        .addStringOption(opt =>
            opt.setName('image_url')
                .setDescription('URL of the image to caption')
                .setRequired(true))
        .addStringOption(opt =>
            opt.setName('text')
                .setDescription('Caption text')
                .setRequired(true)
                .setMaxLength(200)),

    async execute(interaction) {
        const rl = checkImageRateLimit(interaction.user.id);
        if (rl.limited) {
            return interaction.reply({ content: rl.message, flags: MessageFlags.Ephemeral });
        }

        const imageUrl = interaction.options.getString('image_url');
        const text     = interaction.options.getString('text');

        if (!(await isValidHttpUrl(imageUrl))) {
            return interaction.reply({
                content: '❌ Please provide a valid image URL (must start with http:// or https://).',
                flags: MessageFlags.Ephemeral,
            });
        }

        try {
            await interaction.deferReply();

            const src = await loadImageSafe(imageUrl);
            if (src.width > MAX_DIM || src.height > MAX_DIM) {
                return interaction.editReply(`❌ Image is too large. Maximum dimensions are ${MAX_DIM}×${MAX_DIM} pixels.`);
            }

            const scale = src.width > MAX_WIDTH ? MAX_WIDTH / src.width : 1;
            const w     = Math.round(src.width  * scale);
            const h     = Math.round(src.height * scale);

            _measCtx.font  = `bold ${FONT_SIZE}px Arial`;
            const lines    = wrapText(_measCtx, text, w - 20);
            const captionH = Math.max(CAPTION_H, lines.length * LINE_HEIGHT + 20);

            const canvas = createCanvas(w, h + captionH);
            const ctx    = canvas.getContext('2d');

            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, captionH);

            ctx.font         = `bold ${FONT_SIZE}px Arial`;
            ctx.fillStyle    = '#000000';
            ctx.textAlign    = 'center';
            ctx.textBaseline = 'middle';
            const startY     = (captionH - (lines.length - 1) * LINE_HEIGHT) / 2;
            for (let i = 0; i < lines.length; i++) {
                ctx.fillText(lines[i], w / 2, startY + i * LINE_HEIGHT);
            }

            ctx.drawImage(src, 0, captionH, w, h);

            const attachment = new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'caption.png' });
            await interaction.editReply({ files: [attachment] });
        } catch (err) {
            console.error('caption: image load or render failed', err);
            const msg = '❌ Could not load that image. Make sure the URL points to a valid image.';
            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply(msg);
                } else {
                    await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
                }
            } catch (replyErr) {
                console.error('caption: failed to send error reply', replyErr);
            }
        }
    },
};

async function isValidHttpUrl(str) {
    try {
        const { protocol, hostname } = new URL(str);
        if (protocol !== 'http:' && protocol !== 'https:') return false;
        return !(await isPrivateHost(hostname));
    } catch {
        return false;
    }
}

// Canonicalize a hostname for the private-range checks: lowercase, strip IPv6
// brackets, and trim trailing dots (so "localhost." can't slip past).
function canonicalizeHost(hostname) {
    let host = hostname.trim().toLowerCase();
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    while (host.endsWith('.')) host = host.slice(0, -1);
    return host;
}

// Literal-address checks for loopback, link-local, and private ranges (v4 + v6).
function isPrivateAddress(host) {
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
    if (host === '' || host === '::' || host === '::1') return true;
    if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true; // v6 link-local / ULA
    if (host.startsWith('::ffff:')) return isPrivateAddress(host.slice(7));                       // v4-mapped v6
    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
        const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
        if (a === 127 || a === 10 || a === 0) return true;                  // loopback / 10.x / this-net
        if (a === 172 && b >= 16 && b <= 31) return true;                   // 172.16-31.x
        if (a === 192 && b === 168) return true;                            // 192.168.x
        if (a === 169 && b === 254) return true;                            // link-local / cloud metadata
    }
    return false;
}

// Blocks hosts that are, or resolve to, private address space (SSRF). The DNS
// check is best-effort: loadImage re-resolves the name, so a rebinding attacker
// could still race it, but the straightforward private-DNS cases are rejected.
async function isPrivateHost(hostname) {
    const host = canonicalizeHost(hostname);
    if (isPrivateAddress(host)) return true;

    const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
    if (!isIpLiteral) {
        try {
            const addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
            return addrs.some(a => isPrivateAddress(String(a.address).toLowerCase()));
        } catch {
            return true; // unresolvable — the image load would fail anyway
        }
    }
    return false;
}

// loadImage with a hard timeout — node-canvas has none, so a slow or
// unresponsive URL would otherwise hang the deferred reply indefinitely.
function loadImageSafe(url) {
    return Promise.race([
        loadImage(url),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('image load timed out')), LOAD_TIMEOUT_MS).unref?.()),
    ]);
}

function wrapText(ctx, text, maxWidth) {
    const words = text.split(' ');
    const lines = [];
    let line    = '';
    for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (ctx.measureText(candidate).width > maxWidth && line) {
            lines.push(line);
            line = word;
        } else {
            line = candidate;
        }
    }
    if (line) lines.push(line);
    return lines;
}
