# Third-party notices

The project's own source, documentation, examples and assets are distributed
under the complete custom license in `LICENSE`. Third-party software retains
its own copyright and license terms; this project does not relicense it.

The Node server uses only Node.js built-in modules at runtime. Node.js and its
bundled components (including SQLite and OpenSSL) retain their upstream terms.
The Docker image is based on the official `node:24-bookworm-slim` image and also
contains operating-system packages under their respective licenses. Preserve
the notices already distributed in that image when redistributing it.

## Development and build dependencies

`package-lock.json` records exact package versions and integrity hashes. No
`node_modules` files or third-party package source are vendored in this repository.
Package managers retrieve upstream packages and their notices during installation.

| Package / family | Locked version | Declared license |
| --- | --- | --- |
| drizzle-kit | 0.31.4 | MIT |
| drizzle-orm | 0.44.5 | Apache-2.0 |
| esbuild and its platform packages | 0.25.10, transitive 0.18.20 | MIT |
| @drizzle-team/brocli | 0.10.2 | Apache-2.0 |
| @esbuild-kit/core-utils | 3.3.2 | MIT |
| @esbuild-kit/esm-loader | 2.6.5 | MIT |
| buffer-from | 1.1.2 | MIT |
| debug | 4.4.3 | MIT |
| esbuild-register | 3.6.0 | MIT |
| get-tsconfig | 4.14.3 | MIT |
| ms | 2.1.3 | MIT |
| resolve-pkg-maps | 1.0.0 | MIT |
| source-map | 0.6.1 | BSD-3-Clause |
| source-map-support | 0.5.21 | MIT |

The generic Worker bundle imports project modules only, not the Drizzle or
esbuild packages. The build preserves legal comments if dependencies are later
added. If you redistribute dependencies, copy their complete applicable license,
copyright and NOTICE files as required by each package; this inventory does not
replace those notices.

## Browser assets

The repository contains inline SVG/CSS illustrations and icons, system-font
fallback declarations, and synthesized Web Audio effects. It includes no external
font files, downloaded image or sound files, analytics SDK, or CDN scripts.
Names and marks of external projects remain the property of their owners;
references do not imply affiliation or endorsement.
