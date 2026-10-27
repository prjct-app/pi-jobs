# Contributing

This extension has its own repository and npm release. Keep runtime dependencies in `dependencies` and Pi-provided APIs in `peerDependencies`. Use the public Pi SDK and preserve original user instructions.

Run `npm ci`, `npm run check`, `npm test --if-present`, and `npm run check:package`. To release, bump the version in package.json and push a matching `v<version>` tag; the publish workflow then checks, tests and publishes this package to npm with provenance. Never require a sibling checkout at runtime.
