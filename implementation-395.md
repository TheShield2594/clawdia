# Implementation for #395

See issue #395 for details.

## Problem

The Fishing Tournament system (`FishingTournament` model, `tournamentService.js`, `submitCatch`, `buildLeaderboardEmbed`, `endTournament`) is **the strongest social mechanic in the entire bot** and it is effectively dormant. Tournament discovery depends entirely on users knowing to type `/fish tournament`. There are no automatic announcements. There is no in-channel ping. Most users will never know tournaments exist.

**This is the #1 highest-impact fix in the entire bot.** A timed c