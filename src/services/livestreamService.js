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
    if (!guildSettings?.music?.livestream?.enabled) return;

    const { url, channelId } = guildSettings.music.livestream;
    if (!url || !channelId) return;

    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;

    const channel = guild.channels.cache.get(channelId);
    if (!channel) return;

    // Don't start if a regular music queue is active in this guild
    if (client.musicQueues.has(guildId)) return;

    // Don't double-start
    if (activeLivestreams.has(guildId)) return;

    await _connect(client, guildId, guild, channel, url);
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

        // Stage channels: request speaker status
        if (channel.type === 13) {
            try {
                await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
                await guild.members.me.voice.setSuppressed(false);
            } catch {
                // Non-fatal — the bot may still play even if suppressed on some servers
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

    } catch (err) {
        console.error(`[LIVESTREAM] Failed to start for guild ${guildId}:`, err);
        activeLivestreams.delete(guildId);
    }
}

async function _playStream(state, url) {
    const stream = await play.stream(url);
    const resource = createAudioResource(stream.stream, { inputType: stream.type });
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
