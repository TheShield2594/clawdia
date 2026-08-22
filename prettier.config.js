'use strict';

// Prettier settings chosen to match what this codebase already does, so a file
// you format is not also reindented: four spaces, single quotes, semicolons,
// no parentheses round a lone arrow parameter.
//
// Deliberately NOT applied to the tree wholesale. Running it over all 278 files
// rewrites about 45,000 lines — every `git blame` line in the repo, every open
// branch put into conflict, and the column alignment the data tables and option
// lists are written with (`{ key: 'levels',    sort: ... }`) collapsed. None of
// that is worth buying here. `npm run format` takes explicit paths so it is
// applied to the files a change already touches, and ESLint — which is what CI
// enforces — is configured with eslint-config-prettier so the two never
// disagree about the same line.
module.exports = {
    printWidth: 120,
    tabWidth: 4,
    useTabs: false,
    semi: true,
    singleQuote: true,
    quoteProps: 'as-needed',
    trailingComma: 'es5',
    bracketSpacing: true,
    arrowParens: 'avoid',
    endOfLine: 'lf',

    // package.json, the compose files and the workflows are all two-space and
    // always have been, and .editorconfig tells editors the same. Without this
    // override `npm run format` would reindent any of them to four.
    overrides: [
        {
            files: ['*.json', '*.yml', '*.yaml'],
            options: { tabWidth: 2 },
        },
    ],
};
