/**
 * Creates the bot's dedicated MongoDB user (#648).
 *
 * Mounted into the mongodb container at /docker-entrypoint-initdb.d/, where
 * the mongo image runs it with mongosh exactly once — on the first start
 * against an EMPTY data volume, after creating the root user from
 * MONGO_INITDB_ROOT_USERNAME / MONGO_INITDB_ROOT_PASSWORD. It never runs again
 * for an existing volume, so enabling auth on a deployment that already has
 * data means creating this user by hand instead — see "Enabling MongoDB
 * authentication" in SETUP_GUIDE.md for the exact commands.
 *
 * The user gets readWrite on the bot's database and nothing else: no admin
 * role, no access to other databases, enough for the bot, the migrations and
 * mongodump. The database name is still "ultrabot" (pre-rebrand) on purpose —
 * see the note in .env.example.
 */
/* global db, print */
const user = process.env.MONGODB_APP_USERNAME;
const pass = process.env.MONGODB_APP_PASSWORD;

if (!user || !pass) {
    // Not an error: auth may be deliberately off (both root vars unset too),
    // or the operator may intend to connect as root. Say what happened so the
    // first-boot log answers "why does my app user not exist?".
    print('[mongo-init] MONGODB_APP_USERNAME / MONGODB_APP_PASSWORD not set; no application user created');
} else {
    const dbName = 'ultrabot';
    db.getSiblingDB(dbName).createUser({
        user,
        pwd: pass,
        roles: [{ role: 'readWrite', db: dbName }]
    });
    print(`[mongo-init] Created user "${user}" with readWrite on "${dbName}"`);
}
