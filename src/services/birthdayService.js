const { PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const Guild = require('../models/Guild');
const User = require('../models/User');
const { handlesGuild } = require('../utils/sharding');
const { getBirthdayFlair } = require('../utils/birthdayFlair');
const COLORS = require('../utils/embedColors');

// The default wish text, mirrored from the Guild schema, used when a guild has
// somehow stored an empty message so the embed always has a description.
const DEFAULT_MESSAGE = '🎂 Happy Birthday, {user}! 🎉 Wishing you a wonderful day!';

function isLeapYear(year) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function calculateAge(year, now) {
    if (!year) return null;
    const age = now.getUTCFullYear() - year;
    return age > 0 ? age : null;
}

// 1 → "1st", 2 → "2nd", 11 → "11th", 21 → "21st". Used by the {age_ordinal}
// template variable ("celebrating their 25th!").
function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

// The variables every birthday template understands. {user} and {mention} both
// produce a real ping-capable mention; {age_ordinal} is empty when the year is
// unknown so a template can lean on it without printing "?th".
function birthdayVars(member, u, now) {
    const age = calculateAge(u.birthday?.year, now);
    const username = member.displayName || member.user?.username || 'friend';
    return {
        mention: `<@${u.userId}>`,
        username,
        age: age != null ? String(age) : '?',
        ageOrdinal: age != null ? ordinal(age) : '',
        server: member.guild?.name || 'the server',
    };
}

function renderTemplate(str, vars) {
    if (!str) return '';
    return String(str)
        .replace(/\{user\}/g, vars.mention)
        .replace(/\{mention\}/g, vars.mention)
        .replace(/\{username\}/g, vars.username)
        .replace(/\{age_ordinal\}/g, vars.ageOrdinal)
        .replace(/\{age\}/g, vars.age)
        .replace(/\{server\}/g, vars.server);
}

// Split the message field into variants on a line that is only `---`, and pick
// one at random so a member is not greeted with the identical sentence every
// year. A message with no separator is a single variant (unchanged behaviour).
function pickMessage(template) {
    const variants = String(template || '')
        .split(/\r?\n\s*---\s*\r?\n/)
        .map(s => s.trim())
        .filter(Boolean);
    if (!variants.length) return '';
    return variants[Math.floor(Math.random() * variants.length)];
}

// Accepts "#rrggbb" or "rrggbb"; anything else falls back to the celebratory
// gold so a typo in the dashboard never throws inside setColor.
function parseColor(value) {
    const hex = String(value || '').trim().replace(/^#/, '');
    return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex}` : COLORS.PRIZE;
}

/**
 * Build the birthday message payload for one member — a celebratory embed by
 * default, or the classic plain-text line when the guild has turned the embed
 * off (or the bot lacks Embed Links).
 *
 * The mention always rides in `content`, never only in the embed: a mention
 * inside embed text does not fire a notification, so the birthday person would
 * not be pinged if the whole wish lived in the embed.
 *
 * @returns {{ content: string, embeds?: EmbedBuilder[], files?: any[], allowedMentions: object }}
 */
function buildWish(cfg, member, u, now, flair, canEmbed) {
    const vars = birthdayVars(member, u, now);
    const description = renderTemplate(pickMessage(cfg.message) || DEFAULT_MESSAGE, vars);

    if (cfg.useEmbed === false || !canEmbed) {
        return {
            content: description,
            allowedMentions: { users: [u.userId] },
        };
    }

    const embed = new EmbedBuilder()
        .setColor(parseColor(cfg.embedColor))
        .setDescription(description)
        .setTimestamp();

    // Bundled art is only attached when the embed actually references it — an
    // explicit URL wins over the baked default and needs no upload.
    const attach = (name) => flair.files.find(f => f.name === name);
    const files = [];

    const title = renderTemplate(cfg.title, vars);
    if (title) embed.setTitle(title);

    // Author line — its icon is an explicit URL if set, otherwise the bundled
    // birthday art (when baked in). Discord only renders the icon alongside a
    // name, so an empty author text drops the icon too.
    const authorText = renderTemplate(cfg.authorText, vars);
    if (authorText) {
        const iconURL = cfg.authorIcon || flair.iconUrl || undefined;
        embed.setAuthor({ name: authorText, iconURL });
        if (!cfg.authorIcon && flair.iconUrl) {
            const f = attach('birthday-icon.png');
            if (f) files.push(f);
        }
    }

    // The member's avatar as the thumbnail — the strongest personal signal.
    if (cfg.showAvatar !== false) {
        const avatar = member.displayAvatarURL?.({ size: 256, extension: 'png' });
        if (avatar) embed.setThumbnail(avatar);
    }

    // Optional banner: an explicit URL, else the bundled birthday banner.
    const bannerUrl = cfg.image || flair.bannerUrl;
    if (bannerUrl) {
        embed.setImage(bannerUrl);
        if (!cfg.image && flair.bannerUrl) {
            const f = attach('birthday-banner.png');
            if (f) files.push(f);
        }
    }

    const footerText = renderTemplate(cfg.footerText, vars);
    if (footerText) {
        const iconURL = cfg.footerIcon || member.guild?.iconURL?.() || undefined;
        embed.setFooter({ text: footerText, iconURL });
    }

    return {
        content: vars.mention,
        embeds: [embed],
        files,
        allowedMentions: { users: [u.userId] },
    };
}

/**
 * Remove the birthday role from members who are no longer having a birthday.
 *
 * The role was only ever added, so before this every member who ever had a
 * birthday kept it forever, defeating the point of a one-day spotlight. Anyone
 * flagged `roleAssigned` whose birthday is not *today* has run out their day and
 * gets the role stripped and the flag cleared. Runs once a day per guild (the
 * job is gated on the wishing hour), so the spotlight lasts ~24h.
 */
async function cleanupBirthdayRole(guild, roleId, todayConditions) {
    const stale = await User.find({
        guildId: guild.id,
        'birthday.roleAssigned': true,
        $nor: todayConditions,
    });

    for (const u of stale) {
        const member = await guild.members.fetch(u.userId).catch(() => null);
        if (member && member.roles.cache.has(roleId)) {
            await member.roles.remove(roleId).catch(() => null);
        }
        // Clear the flag even if the member left or the role was gone — the point
        // is that we are no longer tracking them as holding it.
        u.birthday.roleAssigned = false;
        await u.save().catch(() => null);
    }
}

async function checkBirthdays(client) {
    const now = new Date();
    const month = now.getUTCMonth() + 1;
    const day = now.getUTCDate();
    const hour = now.getUTCHours();

    // Not gated on channelId: a guild may run the birthday *role* without an
    // announcement channel, and the daily role cleanup has to run for it too.
    const guilds = await Guild.find({
        'birthdays.enabled': true,
        'birthdays.wishingHourUtc': hour,
    });

    // On Feb 28 of a non-leap year, also celebrate Feb 29 birthdays.
    const includeFeb29 = month === 2 && day === 28 && !isLeapYear(now.getUTCFullYear());

    // The set of (month, day) pairs that count as "today". Shared by the
    // celebrant query and the role cleanup so both agree on who is celebrating.
    const todayConditions = includeFeb29
        ? [{ 'birthday.month': 2, 'birthday.day': 28 }, { 'birthday.month': 2, 'birthday.day': 29 }]
        : [{ 'birthday.month': month, 'birthday.day': day }];

    // Fetch the bundled birthday art once — it is read from disk and identical
    // for every guild and member.
    const flair = getBirthdayFlair();

    for (const settings of guilds) {
        // Per-guild job: each shard wishes only its own guilds.
        if (!handlesGuild(settings.guildId, client)) continue;

        const guild = client.guilds.cache.get(settings.guildId);
        if (!guild) continue;

        const cfg = settings.birthdays;

        // Retire yesterday's birthday role first, so a member whose birthday is
        // today keeps theirs while everyone else loses it.
        if (cfg.roleId) {
            await cleanupBirthdayRole(guild, cfg.roleId, todayConditions).catch(() => null);
        }

        const channel = cfg.channelId ? guild.channels.cache.get(cfg.channelId) : null;
        const canAnnounce = channel
            && channel.isTextBased()
            && channel.permissionsFor(guild.members.me).has(PermissionFlagsBits.SendMessages);

        // Combined with $and so the date match and the "not yet celebrated this
        // year" match cannot collide on a shared $or key — the pre-existing bug
        // that made the Feb 29 path match every uncelebrated user.
        const users = await User.find({
            guildId: settings.guildId,
            $and: [
                { $or: todayConditions },
                {
                    $or: [
                        { 'birthday.lastCelebratedYear': { $ne: now.getUTCFullYear() } },
                        { 'birthday.lastCelebratedYear': { $exists: false } },
                    ],
                },
            ],
        });

        for (const u of users) {
            const member = await guild.members.fetch(u.userId).catch(() => null);
            if (!member) continue;

            if (canAnnounce) {
                const canEmbed = channel.permissionsFor(guild.members.me)
                    .has(PermissionFlagsBits.EmbedLinks);
                const wish = buildWish(cfg, member, u, now, flair, canEmbed);
                const sent = await channel.send(wish).catch(() => null);

                // Pile 🎉🎂 onto the wish so members can join in with one tap.
                if (sent && cfg.reactions !== false
                    && channel.permissionsFor(guild.members.me).has(PermissionFlagsBits.AddReactions)) {
                    await sent.react('🎉').catch(() => null);
                    await sent.react('🎂').catch(() => null);
                }
            }

            if (cfg.roleId && member.roles.cache.has(cfg.roleId) === false) {
                await member.roles.add(cfg.roleId).catch(() => null);
            }
            // Track that they hold the role so tomorrow's cleanup can take it back.
            if (cfg.roleId) u.birthday.roleAssigned = true;

            u.birthday.lastCelebratedYear = now.getUTCFullYear();
            await u.save();
        }
    }
}

module.exports = { checkBirthdays, buildWish, renderTemplate, pickMessage, ordinal, parseColor };
