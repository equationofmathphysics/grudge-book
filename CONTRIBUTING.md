# Contributing

Read `LICENSE` before using or contributing to the project. Contributions must
be yours to publish and compatible with that license. Preserve third-party
notices and include attribution for any new external assets or dependencies.

Use Node.js 24 or later:

```sh
npm ci
npm run check
```

The runtime uses Node's built-in SQLite. Tests use temporary databases and
fictional fixtures. Keep new fixtures synthetic and new installations empty.

For schema changes, edit `db/schema.ts`, run `npm run db:generate`, and commit
new migration and metadata files. Never rewrite a migration already released.
Include tests for authorization, stale identity/revision handling, imports and
aggregate privacy when touching those paths.

Open a pull request explaining the behavior change and checks run. Do not submit
database files, exports, original private project history, credentials, deployment
IDs, production domains or generated build directories.
