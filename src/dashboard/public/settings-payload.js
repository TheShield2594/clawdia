// The section → request-body half of saveSettings().
//
// Split out of guild-settings.js so it can be required and tested (#788). The
// bundle it came from is 5,000 lines of DOM wiring that no test loads, and this
// is the part of it worth pinning: every key here has to be one the settings
// endpoint's whitelist accepts, or the save 400s with "Disallowed setting
// key(s)" and the panel silently stops saving. Nothing checked that the two
// agreed.
//
// It still reads the live document — these are form panels, and the values are
// in the DOM — so it is not pure. What it no longer does is fetch, toast or
// touch the unsaved-changes bookkeeping: hand it a section and a page, and it
// hands back the body that section would POST.
//
// Everything the panels keep outside the DOM — the shop list, the achievement
// arrays, the command-policy rules, whether the Connections tab has hydrated —
// arrives in `ctx` rather than being read off the bundle's module scope.

function buildSettingsPayload(section, ctx = {}) {
    const {
        // The escalation ladder is rebuilt from its rows on demand.
        serializeEscalationLadder = () => [],
        storeItems = [],
        jobsList = [],
        jobTiersList = [],
        disabledAchievements = [],
        customAchievements = [],
        cpRules = [],
        cpCooldowns = [],
        // The MCP controls live on the Connections tab and default to the first
        // option until it loads, so they are only sent once it has: null here
        // means "that tab never hydrated, leave those two fields alone".
        mcpSettings = () => null,
    } = ctx;
    const mcp = mcpSettings();

    if (section === 'welcome') {
        return {
            'welcome.enabled': document.getElementById('welcome-enabled').checked,
            'welcome.channelId': document.getElementById('welcome-channel').value,
            'welcome.message': document.getElementById('welcome-message').value,
            'welcome.cardEnabled': document.getElementById('welcome-card').checked,
            'welcome.dmEnabled': document.getElementById('welcome-dm-enabled').checked,
            'welcome.dmMessage': document.getElementById('welcome-dm-message').value
        };
    } else if (section === 'farewell') {
        return {
            'farewell.enabled': document.getElementById('farewell-enabled').checked,
            'farewell.channelId': document.getElementById('farewell-channel').value,
            'farewell.message': document.getElementById('farewell-message').value
        };
    } else if (section === 'birthdays') {
        return {
            'birthdays.enabled': document.getElementById('birthday-enabled').checked,
            'birthdays.channelId': document.getElementById('birthday-channel').value || null,
            'birthdays.wishingHourUtc': (() => { const v = parseInt(document.getElementById('birthday-hour').value, 10); return Number.isNaN(v) ? 9 : v; })(),
            'birthdays.roleId': document.getElementById('birthday-role').value || null,
            'birthdays.message': document.getElementById('birthday-message').value || "It's the birthday of {user} ({age}) ! 🎂"
        };
    } else if (section === 'moderation') {
        const immunityRoleIds = Array.from(document.getElementById('mod-immunity-roles').selectedOptions).map(o => o.value);
        return {
            'moderation.enabled': document.getElementById('mod-enabled').checked,
            'moderation.logChannelId': document.getElementById('mod-log-channel').value || null,
            'moderation.muteRoleId': document.getElementById('mod-mute-role').value || null,
            'moderation.autoModEnabled': document.getElementById('mod-automod').checked,
            'moderation.immunityRoleIds': immunityRoleIds,
            'moderation.spamProtection': document.getElementById('mod-spam').checked,
            'moderation.spamThreshold': parseInt(document.getElementById('mod-spam-threshold').value, 10) || 5,
            'moderation.spamWindow': parseInt(document.getElementById('mod-spam-window').value, 10) || 5,
            'moderation.inviteFilter': document.getElementById('mod-invites').checked,
            'moderation.inviteAllowlist': document.getElementById('mod-invite-allowlist').value.split('\n').map(s => s.trim()).filter(Boolean),
            'moderation.linkFilter': document.getElementById('mod-links').checked,
            'moderation.linkAllowlist': document.getElementById('mod-link-allowlist').value.split('\n').map(s => s.trim()).filter(Boolean),
            'moderation.profanityFilter': document.getElementById('mod-profanity').checked,
            'moderation.customBadWords': document.getElementById('mod-bad-words').value.split('\n').map(w => w.trim()).filter(Boolean),
            'moderation.repeatedTextFilter': document.getElementById('mod-repeated').checked,
            'moderation.excessiveCapsFilter': document.getElementById('mod-caps').checked,
            'moderation.capsThresholdPercent': parseInt(document.getElementById('mod-caps-threshold').value, 10) || 70,
            'moderation.excessiveEmojisFilter': document.getElementById('mod-emojis').checked,
            'moderation.emojiThreshold': parseInt(document.getElementById('mod-emoji-threshold').value, 10) || 8,
            'moderation.zalgoFilter': document.getElementById('mod-zalgo').checked,
            'moderation.excessiveMentionsFilter': document.getElementById('mod-mentions').checked,
            'moderation.mentionThreshold': parseInt(document.getElementById('mod-mention-threshold').value, 10) || 5,
            'moderation.warnThreshold': parseInt(document.getElementById('mod-warn-threshold').value, 10) || 3,
            'moderation.kickThreshold': parseInt(document.getElementById('mod-kick-threshold').value, 10) || 0,
            'moderation.banThreshold': parseInt(document.getElementById('mod-ban-threshold').value, 10) || 0,
            'moderation.behaviorScoreMuteAt': parseInt(document.getElementById('mod-score-mute').value, 10) || 0,
            'moderation.behaviorScoreKickAt': parseInt(document.getElementById('mod-score-kick').value, 10) || 0,
            'moderation.behaviorScoreBanAt': parseInt(document.getElementById('mod-score-ban').value, 10) || 0,
            'moderation.behaviorScoreDecayDays': parseInt(document.getElementById('mod-score-decay').value, 10) || 7,
            'moderation.appealsEnabled': document.getElementById('mod-appeals-enabled').checked,
            'moderation.appealChannelId': document.getElementById('mod-appeal-channel').value || null,
            'moderation.escalation.enabled': document.getElementById('mod-escalation-enabled').checked,
            'moderation.escalation.ladder': serializeEscalationLadder()
        };
    } else if (section === 'leveling') {
        const noXpRoleIds = Array.from(document.querySelectorAll('#level-no-xp-roles-list [data-role-id]')).map(el => el.dataset.roleId);
        const noXpChannelIds = Array.from(document.querySelectorAll('#level-no-xp-channels-list [data-channel-id]')).map(el => el.dataset.channelId);
        const levelRoles = Array.from(document.querySelectorAll('#level-role-rewards-list .level-reward-row')).map(row => ({
            level: parseInt(row.querySelector('.level-reward-level').value, 10),
            roleId: row.querySelector('.level-reward-role').value
        })).filter(r => r.level > 0 && r.roleId);
        const maxLevelRaw = parseInt(document.getElementById('level-max-level').value, 10);
        return {
            'leveling.enabled': document.getElementById('level-enabled').checked,
            'leveling.xpRate': parseFloat(document.getElementById('level-xp-rate').value) || 1.0,
            'leveling.maxLevel': Number.isFinite(maxLevelRaw) && maxLevelRaw > 0 ? maxLevelRaw : null,
            'leveling.levelUpMessage': document.getElementById('level-message').value,
            'leveling.rewardsEnabled': document.getElementById('level-rewards-enabled').checked,
            'leveling.noXpRoleIds': noXpRoleIds,
            'leveling.noXpChannelIds': noXpChannelIds,
            'leveling.rewardChannelId': document.getElementById('level-reward-channel').value || null,
            'leveling.voiceXpEnabled': document.getElementById('level-voice-xp').checked,
            'leveling.voiceXpRate': parseFloat(document.getElementById('level-voice-rate').value) || 1.0,
            levelRoles
        };
    } else if (section === 'economy') {
        const safeInt = (id, fallback) => { const v = parseInt(document.getElementById(id).value, 10); return Number.isFinite(v) ? v : fallback; };
        return {
            'economy.enabled': document.getElementById('economy-enabled').checked,
            'economy.currency': document.getElementById('economy-currency').value,
            'economy.dailyAmount': safeInt('economy-daily', 100),
            'economy.workMin': safeInt('economy-work-min', 50),
            'economy.workMax': safeInt('economy-work-max', 150),
            'economy.shopEnabled': document.getElementById('economy-shop-enabled').checked,
            'economy.gamesEnabled': document.getElementById('economy-games-enabled').checked,
            'economy.coinflipEnabled': document.getElementById('economy-coinflip-enabled').checked,
            'economy.rollEnabled': document.getElementById('economy-roll-enabled').checked,
            'economy.blackjackEnabled': document.getElementById('economy-blackjack-enabled').checked,
            'economy.casinoEnabled': document.getElementById('economy-casino-enabled').checked,
            'economy.duelEnabled': document.getElementById('economy-duel-enabled').checked,
            'economy.crimeEnabled': document.getElementById('economy-crime-enabled').checked,
            'economy.robEnabled': document.getElementById('economy-rob-enabled').checked,
            'economy.quizEnabled': document.getElementById('economy-quiz-enabled').checked,
            'economy.jobsEnabled': document.getElementById('economy-jobs-enabled').checked,
            'economy.announcementChannelId': document.getElementById('economy-announcement-channel').value || null,
            shop: storeItems,
            jobs: jobsList,
            jobTiers: jobTiersList
        };
    } else if (section === 'achievements') {
        return {
            'achievements.enabled': document.getElementById('ach-enabled').checked,
            'achievements.announcementChannelId': document.getElementById('ach-announce-channel').value || null,
            'achievements.disabledAchievements': disabledAchievements,
            'achievements.customAchievements': customAchievements
        };
    } else if (section === 'raiddetection') {
        return {
            'raidDetection.enabled': document.getElementById('raid-enabled').checked,
            'raidDetection.threshold': parseInt(document.getElementById('raid-threshold').value, 10) || 10,
            'raidDetection.windowSeconds': parseInt(document.getElementById('raid-window').value, 10) || 60,
            'raidDetection.minAccountAgeDays': parseInt(document.getElementById('raid-min-age').value, 10) || 0,
            'raidDetection.action': document.getElementById('raid-action').value,
            'raidDetection.quarantineRoleId': document.getElementById('raid-quarantine-role').value || null,
            'raidDetection.alertChannelId': document.getElementById('raid-alert-channel').value || null
        };
    } else if (section === 'starboard') {
        return {
            'starboard.enabled': document.getElementById('starboard-enabled').checked,
            'starboard.channelId': document.getElementById('starboard-channel').value || null,
            'starboard.emoji': document.getElementById('starboard-emoji').value || '⭐',
            'starboard.threshold': parseInt(document.getElementById('starboard-threshold').value, 10) || 3
        };
    } else if (section === 'eventlog') {
        return {
            'eventLog.enabled': document.getElementById('eventlog-enabled').checked,
            'eventLog.channelId': document.getElementById('eventlog-channel').value || null,
            'eventLog.logMessageEdit': document.getElementById('log-msg-edit').checked,
            'eventLog.logMessageDelete': document.getElementById('log-msg-delete').checked,
            'eventLog.logMessageBulkDelete': document.getElementById('log-msg-bulk-delete').checked,
            'eventLog.logMemberJoin': document.getElementById('log-member-join').checked,
            'eventLog.logMemberLeave': document.getElementById('log-member-leave').checked,
            'eventLog.logNicknameChange': document.getElementById('log-nickname-change').checked,
            'eventLog.logUsernameChange': document.getElementById('log-username-change').checked,
            'eventLog.logAvatarChange': document.getElementById('log-avatar-change').checked,
            'eventLog.logTimeout': document.getElementById('log-timeout').checked,
            'eventLog.logBoost': document.getElementById('log-boost').checked,
            'eventLog.logRoleChanges': document.getElementById('log-role-changes').checked,
            'eventLog.logChannelChanges': document.getElementById('log-channel-changes').checked,
            'eventLog.logVoiceJoin': document.getElementById('log-voice-join').checked,
            'eventLog.logVoiceLeave': document.getElementById('log-voice-leave').checked,
            'eventLog.logVoiceMove': document.getElementById('log-voice-move').checked,
            'eventLog.logVoiceMuteDeafen': document.getElementById('log-voice-mute').checked,
            'eventLog.logInviteCreate': document.getElementById('log-invite-create').checked,
            'eventLog.logInviteDelete': document.getElementById('log-invite-delete').checked,
            'eventLog.logServerUpdate': document.getElementById('log-server-update').checked,
            'eventLog.logEmojiUpdate': document.getElementById('log-emoji-update').checked,
            'eventLog.logWebhookUpdate': document.getElementById('log-webhook-update').checked,
            'eventLog.logBotAdd': document.getElementById('log-bot-add').checked,
            'eventLog.logThreadCreate': document.getElementById('log-thread-create').checked,
            'eventLog.logThreadDelete': document.getElementById('log-thread-delete').checked,
            'eventLog.logThreadArchive': document.getElementById('log-thread-archive').checked
        };
    } else if (section === 'quests') {
        const safeReward = (id, fallback) => { const v = parseInt(document.getElementById(id).value, 10); return Number.isFinite(v) ? v : fallback; };
        const safeSlot = (id, fallback, min, max) => { const v = parseInt(document.getElementById(id).value, 10); return Number.isFinite(v) ? Math.min(Math.max(v, min), max) : fallback; };
        return {
            'quests.enabled': document.getElementById('quests-enabled').checked,
            'quests.notificationChannelId': document.getElementById('quests-notif-channel').value || null,
            'quests.questsPerDay': safeSlot('quests-per-day', 3, 1, 6),
            'quests.questsPerWeek': safeSlot('quests-per-week', 2, 1, 4),
            'quests.dailyXpReward': safeReward('quests-daily-xp', 50),
            'quests.dailyCoinReward': safeReward('quests-daily-coins', 25),
            'quests.weeklyXpReward': safeReward('quests-weekly-xp', 300),
            'quests.weeklyCoinReward': safeReward('quests-weekly-coins', 150)
        };
    } else if (section === 'suggestions') {
        return {
            'suggestions.enabled': document.getElementById('suggestions-enabled').checked,
            'suggestions.channelId': document.getElementById('suggestions-channel').value || null,
            'suggestions.upvoteEmoji': document.getElementById('suggestions-upvote').value || '👍',
            'suggestions.downvoteEmoji': document.getElementById('suggestions-downvote').value || '👎',
            'suggestions.staffReviewChannelId': document.getElementById('suggestions-staff-channel').value || null,
            'suggestions.autoThread': document.getElementById('suggestions-auto-thread').checked,
            'suggestions.anonymous': document.getElementById('suggestions-anonymous').checked,
            'suggestions.minAccountAgeDays': parseInt(document.getElementById('suggestions-min-age').value, 10) || 0,
            'suggestions.statusEmojis.approve': document.getElementById('sug-status-approve').value || '✅',
            'suggestions.statusEmojis.deny': document.getElementById('sug-status-deny').value || '❌',
            'suggestions.statusEmojis.review': document.getElementById('sug-status-review').value || '🔎',
            'suggestions.statusEmojis.implement': document.getElementById('sug-status-implement').value || '🚀'
        };
    } else if (section === 'antinuke') {
        const splitIds = id => document.getElementById(id).value.split('\n').map(s => s.trim()).filter(Boolean);
        return {
            'antiNuke.enabled': document.getElementById('an-enabled').checked,
            'antiNuke.alertChannelId': document.getElementById('an-alert-channel').value || null,
            'antiNuke.windowSeconds': parseInt(document.getElementById('an-window').value, 10) || 30,
            'antiNuke.punishment': document.getElementById('an-punishment').value,
            'antiNuke.autoLockdown': document.getElementById('an-auto-lockdown').checked,
            'antiNuke.thresholds': {
                channelDelete: parseInt(document.getElementById('an-t-channelDelete').value, 10) || 3,
                channelCreate: parseInt(document.getElementById('an-t-channelCreate').value, 10) || 5,
                roleDelete:    parseInt(document.getElementById('an-t-roleDelete').value, 10) || 3,
                roleCreate:    parseInt(document.getElementById('an-t-roleCreate').value, 10) || 5,
                ban:           parseInt(document.getElementById('an-t-ban').value, 10) || 3,
                kick:          parseInt(document.getElementById('an-t-kick').value, 10) || 5,
                webhookCreate: parseInt(document.getElementById('an-t-webhookCreate').value, 10) || 2
            },
            'antiNuke.whitelistUserIds': splitIds('an-whitelist-users'),
            'antiNuke.whitelistRoleIds': splitIds('an-whitelist-roles'),
            'antiNuke.joinGate': {
                enabled:           document.getElementById('an-jg-enabled').checked,
                minAccountAgeDays: parseInt(document.getElementById('an-jg-age').value, 10) || 3,
                action:            document.getElementById('an-jg-action').value
            }
        };
    } else if (section === 'casesettings') {
        return {
            'caseSettings.slaHours':    parseInt(document.getElementById('cs-sla-hours').value, 10) || 48,
            'caseSettings.slaChannelId': document.getElementById('cs-sla-channel').value || null
        };
    } else if (section === 'season') {
        const tierRewards = Array.from(document.querySelectorAll('#season-tier-rewards-list .season-tier-row')).map(row => ({
            tier: parseInt(row.querySelector('.season-tier-num').value, 10),
            coins: parseInt(row.querySelector('.season-tier-coins').value, 10) || 0,
            roleId: row.querySelector('.season-tier-role').value || null,
            label: row.querySelector('.season-tier-label').value.trim()
        })).filter(r => !isNaN(r.tier) && r.tier > 0).sort((a, b) => a.tier - b.tier);
        return {
            'season.enabled':    document.getElementById('season-enabled').checked,
            'season.name':       document.getElementById('season-name').value.trim() || 'Season 1',
            'season.seasonId':   document.getElementById('season-id').value.trim() || null,
            'season.startDate':  document.getElementById('season-start').value || null,
            'season.endDate':    document.getElementById('season-end').value || null,
            'season.xpPerTier':  parseInt(document.getElementById('season-xp-per-tier').value, 10) || 100,
            'season.maxTiers':   parseInt(document.getElementById('season-max-tiers').value, 10) || 50,
            'season.tierRewards': tierRewards
        };
    } else if (section === 'progressiontracks') {
        const helperChannels = Array.from(document.getElementById('pt-helper-channels').selectedOptions).map(o => o.value);
        return {
            'progressionTracks.enabled':       document.getElementById('pt-enabled').checked,
            'progressionTracks.creatorBonus':  parseInt(document.getElementById('pt-creator-bonus').value, 10) || 20,
            'progressionTracks.helperBonus':   parseInt(document.getElementById('pt-helper-bonus').value, 10) || 20,
            'progressionTracks.raiderBonus':   parseInt(document.getElementById('pt-raider-bonus').value, 10) || 20,
            'progressionTracks.helperChannels': helperChannels
        };
    } else if (section === 'commandpolicies') {
        const excRoleIds = Array.from(document.querySelectorAll('#cp-exc-roles-list [data-role-id]')).map(el => el.dataset.roleId);
        const excUserIds = document.getElementById('cp-exc-users').value.split('\n').map(s => s.trim()).filter(Boolean);
        return {
            'commandPolicies.enabled': document.getElementById('cp-enabled').checked,
            'commandPolicies.exceptions': {
                userIds: excUserIds,
                roleIds: excRoleIds
            },
            'commandPolicies.rules':            cpRules,
            'commandPolicies.cooldownOverrides': cpCooldowns
        };
    } else if (section === 'ai') {
        const aiPromptVal = document.getElementById('ai-prompt').value;
        return {
            'ai.enabled': document.getElementById('ai-enabled').checked,
            'ai.provider': document.getElementById('ai-provider').value,
            'ai.model': document.getElementById('ai-model').value.trim(),
            ...(document.getElementById('ai-openai-key').value ? {'ai.openaiKey': document.getElementById('ai-openai-key').value} : {}),
            ...(document.getElementById('ai-anthropic-key').value ? {'ai.anthropicKey': document.getElementById('ai-anthropic-key').value} : {}),
            ...(document.getElementById('ai-gemini-key').value ? {'ai.geminiKey': document.getElementById('ai-gemini-key').value} : {}),
            ...(document.getElementById('ai-openrouter-key').value ? {'ai.openrouterKey': document.getElementById('ai-openrouter-key').value} : {}),
            'ai.ollamaBaseUrl': document.getElementById('ai-ollama-url').value.trim(),
            'ai.channelId': document.getElementById('ai-channel').value,
            'ai.systemPrompt': aiPromptVal,
            'ai.temperature': parseFloat(document.getElementById('ai-temperature').value),
            'ai.maxTokens': parseInt(document.getElementById('ai-max-tokens').value, 10),
            'ai.maxHistory': parseInt(document.getElementById('ai-max-history').value, 10),
            // Empty means "derive it from the model name", which is null rather
            // than a NaN the schema would refuse.
            'ai.contextTokens': document.getElementById('ai-context-tokens').value.trim()
                ? parseInt(document.getElementById('ai-context-tokens').value, 10)
                : null,
            'ai.streaming': document.getElementById('ai-streaming').checked,
            'ai.rateLimitPerUser': parseInt(document.getElementById('ai-rate-limit').value, 10),
            'ai.rateLimitPerChannel': parseInt(document.getElementById('ai-rate-channel').value, 10),
            'ai.rateLimitWindowMin': parseInt(document.getElementById('ai-rate-window').value, 10),
            'ai.monthlyTokenLimit': parseInt(document.getElementById('ai-monthly-tokens').value, 10) || 0,
            'ai.monthlyCostLimit': parseFloat(document.getElementById('ai-monthly-cost').value) || 0,
            'ai.actionsEnabled': document.getElementById('ai-actions-enabled').checked,
            'ai.taskModeEnabled': document.getElementById('ai-task-mode').checked,
            // These live on the Connections tab but belong to the same ai
            // document, so they save with everything else rather than needing
            // their own endpoint.
            //
            // Only once that tab has actually loaded, though. The controls are
            // in the markup from the start and default to the first option, so
            // sending them unhydrated would take a guild that had approvals on
            // `writes` and quietly put them back to `off` — because somebody
            // changed the temperature on the Chat tab and pressed Save.
            ...(mcp ? {
                'ai.mcpConfirm': mcp.confirm,
                'ai.mcpRoute': mcp.route
            } : {})
        };
    } else if (section === 'tempvoice') {
        return {
            'tempVoice.enabled': document.getElementById('tv-enabled').checked,
            'tempVoice.lobbyChannelId': document.getElementById('tv-lobby').value || null,
            'tempVoice.categoryId': document.getElementById('tv-category').value || null,
            'tempVoice.channelName': document.getElementById('tv-channel-name').value.trim() || "{username}'s VC",
            'tempVoice.userLimit': parseInt(document.getElementById('tv-user-limit').value, 10) || 0,
            'tempVoice.bitrate': parseInt(document.getElementById('tv-bitrate').value, 10) || 64
        };
    } else if (section === 'bibleverses') {
        return {
            'bibleVerse.enabled': document.getElementById('bv-enabled').checked,
            'bibleVerse.channelId': document.getElementById('bv-channel').value || null,
            'bibleVerse.time': document.getElementById('bv-time').value.trim() || '08:00',
            'bibleVerse.timezone': document.getElementById('bv-timezone').value.trim() || 'UTC',
            'bibleVerse.translation': document.getElementById('bv-translation').value,
            'bibleVerse.autoRespond': document.getElementById('bv-autorespond').checked
        };
    } else if (section === 'dailynews') {
        const feedsText = document.getElementById('dailynews-feeds').value;
        const feeds = feedsText.split('\n').filter(f => f.trim() !== '');
        const profiles = JSON.parse(document.getElementById('dailynews-profiles-list').dataset.profiles || '[]')
            .map((p, index) => ({
                profileId: p.profileId || `profile-${index + 1}`,
                name: (p.name || '').trim(),
                enabled: p.enabled !== false,
                channelId: (p.channelId || '').trim(),
                time: (p.time || '09:00').trim(),
                timezone: (p.timezone || '').trim() || null,
                title: (p.title || '📰 Daily News Digest').trim(),
                feeds: (Array.isArray(p.feeds) ? p.feeds : []).map(f => f.trim()).filter(Boolean),
                maxItemsPerFeed: parseInt(document.getElementById('dailynews-max-items').value, 10) || 3
            }))
            .filter(p => p.channelId && p.feeds.length);
        return {
            'dailyNews.enabled': document.getElementById('dailynews-enabled').checked,
            'dailyNews.channelId': document.getElementById('dailynews-channel').value,
            'dailyNews.time': document.getElementById('dailynews-time').value,
            'dailyNews.timezone': document.getElementById('dailynews-timezone').value.trim() || null,
            'dailyNews.title': document.getElementById('dailynews-title').value,
            // Same radix and same fallback as the per-profile copy above: an
            // empty field parses to NaN, JSON.stringify turns that into null,
            // and the schema's `default: 3` does not apply to an explicit null.
            'dailyNews.maxItemsPerFeed': parseInt(document.getElementById('dailynews-max-items').value, 10) || 3,
            'dailyNews.feeds': feeds,
            dailyNewsProfiles: profiles
        };
    } else if (section === 'newspaper') {
        const safeInt = (id, fallback) => { const v = parseInt(document.getElementById(id).value, 10); return Number.isFinite(v) ? v : fallback; };
        return {
            'newspaper.enabled':         document.getElementById('newspaper-enabled').checked,
            'newspaper.channelId':        document.getElementById('newspaper-channel').value || null,
            'newspaper.deliveryDay':      safeInt('newspaper-day', 1),
            'newspaper.deliveryHourUtc':  safeInt('newspaper-hour', 9),
            'newspaper.sections': {
                topEarners:       document.getElementById('np-top-earners').checked,
                levelUps:         document.getElementById('np-level-ups').checked,
                casinoHighlights: document.getElementById('np-casino').checked,
                moderationDigest: document.getElementById('np-mod').checked,
                gameStandouts:    document.getElementById('np-games').checked,
                quoteOfTheWeek:   document.getElementById('np-quote').checked,
                newMembers:       document.getElementById('np-new-members').checked,
            }
        };
    } else if (section === 'heist') {
        const safeInt = (id, fallback) => { const v = parseInt(document.getElementById(id).value, 10); return Number.isFinite(v) ? v : fallback; };
        return {
            'heist.enabled':              document.getElementById('heist-enabled').checked,
            'heist.cooldownHours':         safeInt('heist-cooldown', 6),
            'heist.lobbyDurationSeconds':  safeInt('heist-lobby', 60),
            'heist.minPlayers':            safeInt('heist-min-players', 2),
            'heist.jailDurationMinutes':   safeInt('heist-jail', 30),
            'heist.maxPayout':             safeInt('heist-max-payout', 10000),
        };
    } else if (section === 'dynamicPricing') {
        const bandPct = parseFloat(document.getElementById('dynamic-pricing-band').value);
        const recalc  = parseInt(document.getElementById('dynamic-pricing-recalc').value, 10);
        return {
            'dynamicPricing.enabled':       document.getElementById('dynamic-pricing-enabled').checked,
            'dynamicPricing.volatility':    document.getElementById('dynamic-pricing-volatility').value,
            'dynamicPricing.priceBand':     Number.isFinite(bandPct) ? Math.min(0.9, Math.max(0.05, bandPct / 100)) : 0.5,
            'dynamicPricing.recalcMinutes': Number.isFinite(recalc)  ? Math.min(1440, Math.max(15, recalc))          : 60
        };
    } else if (section === 'exploration') {
        const safeFloat = (id, fallback, min, max) => {
            const v = parseFloat(document.getElementById(id).value);
            return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
        };
        const disabledRegions = Array.from(document.querySelectorAll('.exploration-region'))
            .filter(cb => !cb.checked)
            .map(cb => cb.dataset.regionId);
        return {
            'exploration.enabled':            document.getElementById('exploration-enabled').checked,
            'exploration.dropRateMultiplier': safeFloat('exploration-droprate', 1, 0.1, 5),
            'exploration.rareEventBonus':     safeFloat('exploration-rarebonus', 0, 0, 0.25),
            'exploration.announceSecrets':    document.getElementById('exploration-announce-secrets').checked,
            'exploration.disabledRegions':    disabledRegions,
        };
    }
    // A section with no branch above sends nothing, which is what saveSettings()
    // did with its `let data = {}` before this moved out of it.
    return {};
}

// Loaded as a plain <script> by the dashboard page, and required by the tests.
if (typeof module !== 'undefined' && module.exports) module.exports = { buildSettingsPayload };
