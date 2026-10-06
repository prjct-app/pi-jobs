# Contributing

This extension has its own repository and npm release. Keep runtime dependencies in `dependencies` and Pi-provided APIs in `peerDependencies`. Use the public Pi SDK and preserve original user instructions.

Run `npm ci`, `npm run check`, `npm test --if-present`, and `npm run check:package`. Create a version tag matching package.json and publish this package individually. Never require a sibling checkout at runtime.
