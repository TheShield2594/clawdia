// Base profanity/slur list used by the auto-moderation filter.
// Stored separately from the event handler so the source is easier to review
// and the list can be updated without touching business logic.
// Servers can extend this via Guild.moderation.customBadWords.
module.exports = [
    'nigger', 'nigga', 'faggot', 'fag', 'retard', 'chink', 'spic', 'kike',
    'cunt', 'whore', 'slut', 'bitch', 'bastard', 'asshole', 'dick', 'cock',
    'pussy', 'fuck', 'shit', 'piss', 'crap', 'damn', 'hell', 'ass',
    'motherfucker', 'motherfucking', 'fucker', 'fucking', 'bullshit',
    'twat', 'wanker', 'prick', 'arsehole', 'bollocks', 'shithead',
    'jackass', 'dumbass', 'smartass', 'dipshit', 'douchebag',
    'tranny', 'dyke', 'wetback', 'beaner', 'cracker', 'gook', 'towelhead',
    'raghead', 'sandnigger', 'zipperhead', 'nig', 'coon', 'jigaboo',
    'spook', 'porch monkey', 'jungle bunny', 'tar baby'
];
