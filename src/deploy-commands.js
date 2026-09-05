require('dotenv').config();
// Resolves any <NAME>_FILE variable into <NAME>, so secrets can be mounted as
// files (docker secrets) instead of being readable via `docker inspect`. Runs
// straight after dotenv so .env can set the *_FILE paths too, and before
// anything reads process.env.
require('./config/fileSecrets').loadFileSecrets();
const { runDeployCli } = require('./utils/commandDeployer');

// Everything this used to do is in `runDeployCli`, where it is tested — this
// file is on the `neverExecuted` list, and the guard it holds is the difference
// between a deploy and an error message (#951). What is left is the exit.
//
// Only a failure exits explicitly. On success the process falls off the end of
// the event loop, which is what lets the last `console.log` finish draining to
// a pipe; `process.exit(0)` here would sometimes cut it off.
runDeployCli().then(code => {
    if (code !== 0) process.exit(code);
});
