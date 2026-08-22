const OAuth2Strategy = require('passport-oauth2');
const InternalOAuthError = require('passport-oauth2/lib/errors/internaloautherror');

// Discord OAuth2 for passport, on top of passport-oauth2 rather than a
// third-party strategy package.
//
// This replaces `discord-strategy`, which sat directly on the dashboard's login
// path: a single-maintainer package that reimplemented passport-oauth2's entire
// `authenticate()` — several hundred lines of copied control flow, PKCE and
// state handling included — purely so it could pass a "consumable" helper
// object as a sixth argument to the verify callback. The dashboard used exactly
// one method on that object, `guilds()`, and paid for it with a private fork of
// the security-critical part of OAuth.
//
// Everything below is the part that is genuinely Discord-specific: the two
// endpoints and the profile fetch. `authenticate()`, the session-backed state
// store that defends the callback against login CSRF, token exchange and
// refresh all come from passport-oauth2 itself, unforked.

const API_BASE = 'https://discord.com/api/v10';
const AUTHORIZATION_URL = 'https://discord.com/api/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/oauth2/token';

/** The scopes this dashboard knows how to ask for. */
const DiscordScope = {
    Identify: 'identify',
    Guilds: 'guilds',
    Email: 'email',
};

class Strategy extends OAuth2Strategy {
    constructor(options = {}, verify) {
        super({
            authorizationURL: AUTHORIZATION_URL,
            tokenURL: TOKEN_URL,
            scopeSeparator: ' ',
            ...options,
        }, verify);

        this.name = 'discord';
        // Discord rejects the access token as a query parameter; it has to be a
        // Bearer header.
        this._oauth2.useAuthorizationHeaderforGET(true);
    }

    /**
     * Fetches the profile passport hands to the verify callback.
     *
     * The guild list is fetched here rather than left to the caller. The
     * dashboard authorizes every request against it — which servers this user
     * may configure — so a login that completed with the list missing would be
     * a login with no permissions rather than a login that failed, and the
     * difference is not visible from the callback. A failure fails the login.
     */
    userProfile(accessToken, done) {
        this._fetch('/users/@me', accessToken)
            .then(async profile => {
                profile.guilds = this._wants(DiscordScope.Guilds)
                    ? await this._fetch('/users/@me/guilds', accessToken)
                    : [];
                done(null, profile);
            })
            .catch(err => done(err instanceof InternalOAuthError
                ? err
                : new InternalOAuthError('Failed to fetch the Discord user profile', err)));
    }

    _wants(scope) {
        const configured = this._scope;
        if (!configured) return false;
        if (Array.isArray(configured)) return configured.includes(scope);
        // passport-oauth2 accepts `scope` as a pre-joined string as readily as
        // an array. Comparing the whole string against one scope would miss
        // "identify guilds" and quietly skip the guild fetch — which the
        // dashboard reads as "this user administers nothing" rather than as a
        // misconfiguration.
        return String(configured).split(this._scopeSeparator).includes(scope);
    }

    _fetch(endpoint, accessToken) {
        return new Promise((resolve, reject) => {
            this._oauth2.get(`${API_BASE}${endpoint}`, accessToken, (err, body) => {
                if (err) return reject(new InternalOAuthError(`Failed to fetch ${endpoint}`, err));
                try {
                    resolve(JSON.parse(body));
                } catch {
                    // A non-JSON body here means Discord returned an error page
                    // or a gateway did; either way there is no profile to build.
                    reject(new InternalOAuthError(`Discord returned an unparseable response for ${endpoint}`));
                }
            });
        });
    }
}

module.exports = { Strategy, DiscordScope, API_BASE, AUTHORIZATION_URL, TOKEN_URL };
