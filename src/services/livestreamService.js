const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    entersState
} = require('@discordjs/voice');
const play = require('play-dl');
const Guild = require('../models/Guild');

// Map<guildId, { connection, player, retryTimeout, stopped }>
const activeLivestreams = new Map();

async function startLivestream(client, guildId) {
    const guildSettings = await Guild.findOne({ guildId });
    if (!guildSettings?.music?.livestream?.enabled) {
        return { ok: false, reason: 'Livestream is not enabled for this guild.' };
    }

    const { url, channelId } = guildSettings.music.livestream;
    if (!url || !channelId) {
        return { ok: false, reason: 'Livestream URL or channel is missing.' };
    }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) return { ok: false, reason: 'Guild not found in cache.' };

    const channel = guild.channels.cache.get(channelId);
    if (!channel) return { ok: false, reason: 'Configured channel no longer exists.' };

    // Don't start if a regular music queue is active in this guild
    if (client.musicQueues.has(guildId)) {
        return { ok: false, reason: 'A music queue is already active. Stop it first.' };
    }

    // Don't double-start
    if (activeLivestreams.has(guildId)) {
        return { ok: true, alreadyRunning: true };
    }

    return await _connect(client, guildId, guild, channel, url);
}

async function _connect(client, guildId, guild, channel, url) {
    try {
        const connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: true
        });

        const player = createAudioPlayer();
        connection.subscribe(player);

        const state = { connection, player, retryTimeout: null, stopped: false };
        activeLivestreams.set(guildId, state);

        // Wait for the voice connection to be ready before attempting to stream.
        // Without this, audio resources can be created against a half-open
        // connection and silently fail.
        try {
            await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
        } catch (err) {
            activeLivestreams.delete(guildId);
            try { connection.destroy(); } catch {}
            console.error(`[LIVESTREAM] Voice connection never reached Ready for guild ${guildId}:`, err);
            return { ok: false, reason: 'Could not establish a voice connection within 20s. Check the bot has Connect/Speak permissions on that channel.' };
        }

        // Stage channels: request speaker status so the bot can actually be heard.
        if (channel.type === 13) {
            try {
                await guild.members.me.voice.setSuppressed(false);
            } catch (err) {
                console.warn(`[LIVESTREAM] Could not un-suppress in stage for guild ${guildId}:`, err?.message || err);
            }
        }

        await _playStream(state, url);

        // Stream ended (video finished) — restart automatically
        player.on(AudioPlayerStatus.Idle, () => {
            if (state.stopped) return;
            state.retryTimeout = setTimeout(async () => {
                if (state.stopped) return;
                try {
                    await _playStream(state, url);
                } catch (err) {
                    console.error('[LIVESTREAM] Restart error:', err);
                    _scheduleRetry(state, client, guildId, guild, channel, url, 30_000);
                }
            }, 2_000);
        });

        player.on('error', err => {
            console.error('[LIVESTREAM] Player error:', err);
            if (state.stopped) return;
            _scheduleRetry(state, client, guildId, guild, channel, url, 10_000);
        });

        connection.on(VoiceConnectionStatus.Disconnected, async () => {
            if (state.stopped) return;
            try {
                // Give Discord 5s to reconnect on its own before we force a full restart
                await Promise.race([
                    entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                    entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
                ]);
            } catch {
                console.warn(`[LIVESTREAM] Guild ${guildId} disconnected — restarting in 10s`);
                activeLivestreams.delete(guildId);
                try { connection.destroy(); } catch {}
                state.retryTimeout = setTimeout(async () => {
                    if (!state.stopped) await startLivestream(client, guildId);
                }, 10_000);
            }
        });

        connection.on(VoiceConnectionStatus.Destroyed, () => {
            if (!state.stopped) activeLivestreams.delete(guildId);
        });

        return { ok: true };
    } catch (err) {
        console.error(`[LIVESTREAM] Failed to start for guild ${guildId}:`, err);
        const state = activeLivestreams.get(guildId);
        if (state) {
            try { state.player.stop(true); } catch {}
            try { state.connection.destroy(); } catch {}
        }
        activeLivestreams.delete(guildId);
        return { ok: false, reason: err?.message || 'Unknown error while starting livestream.' };
    }
}

async function _playStream(state, url) {
    // discordPlayerCompatibility is required for YouTube *live* streams (HLS).
    // It is harmless for regular videos.
    const stream = await play.stream(url, { discordPlayerCompatibility: true });
    const resource = createAudioResource(stream.stream, { inputType: stream.type, inlineVolume: false });
    state.player.play(resource);
}

function _scheduleRetry(state, client, guildId, guild, channel, url, delay) {
    if (state.retryTimeout) clearTimeout(state.retryTimeout);
    state.retryTimeout = setTimeout(async () => {
        if (state.stopped) return;
        try {
            await _playStream(state, url);
        } catch (err) {
            console.error('[LIVESTREAM] Retry failed:', err);
            // Back off to 60s on repeated failures
            _scheduleRetry(state, client, guildId, guild, channel, url, 60_000);
        }
    }, delay);
}

function stopLivestream(guildId) {
    const state = activeLivestreams.get(guildId);
    if (!state) return;

    state.stopped = true;
    if (state.retryTimeout) clearTimeout(state.retryTimeout);

    try { state.player.stop(true); } catch {}
    try { state.connection.destroy(); } catch {}

    activeLivestreams.delete(guildId);
}

// Called when a music queue ends — resume livestream if configured
async function maybeResumeLivestream(client, guildId) {
    if (activeLivestreams.has(guildId)) return;
    if (client.musicQueues.has(guildId)) return;
    // Small delay so the queue cleanup finishes first
    setTimeout(() => startLivestream(client, guildId), 1_500);
}

// Called on bot ready — start all configured livestreams
async function resumeAllLivestreams(client) {
    try {
        const guilds = await Guild.find({ 'music.livestream.enabled': true });
        for (const g of guilds) {
            await startLivestream(client, g.guildId);
        }
        if (guilds.length) console.log(`[LIVESTREAM] Resumed ${guilds.length} configured livestream(s)`);
    } catch (err) {
        console.error('[LIVESTREAM] Failed to resume all:', err);
    }
}

function isLivestreamActive(guildId) {
    return activeLivestreams.has(guildId);
}

module.exports = { startLivestream, stopLivestream, maybeResumeLivestream, resumeAllLivestreams, isLivestreamActive };
