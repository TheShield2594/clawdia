const express = require('express');
const passport = require('passport');
const { checkCsrfOrigin } = require('../lib/middleware');
const router = express.Router();

router.get('/login', passport.authenticate('discord'));

router.get('/callback', passport.authenticate('discord', {
    failureRedirect: '/'
}), (req, res) => {
    res.redirect('/dashboard');
});

// POST, not GET (#566). Logging out changes session state, and a GET that does
// so is reachable from any page on the internet: `<img src="/auth/logout">` on a
// site an admin happens to visit ends their session. Nuisance rather than
// disclosure, but the fix is the ordinary one — a method browsers do not issue
// for a subresource, behind the same Origin check every other write already
// takes. The dashboard's Logout controls post a form; see views/dashboard.ejs.
router.post('/logout', checkCsrfOrigin, (req, res) => {
    req.logout(() => {
        res.redirect('/');
    });
});

module.exports = router;