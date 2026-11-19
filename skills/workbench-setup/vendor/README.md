# Vendored libraries

Pure-ESM npm packages that let the installer parse configuration without `npm install` at installation time. Files are copied from the published tarballs without modification.

## yaml 2.9.1

Parses `workers.yml`. Only the browser (ESM) build is vendored: `browser/` from the package, minus type declarations, plus `LICENSE`.

Tarball: https://registry.npmjs.org/yaml/-/yaml-2.9.1.tgz

Integrity: `sha512-3NxN8+78OdzbT7C/WjGsyfPAtJaN3FNDsWxv7Y7mcDsT/oOmgW8BpyQQFFBnvZE3j9Y2Sdz1ULFLezL7Eb2yFw==`

## smol-toml 1.9.1

Validates `~/.codex/config.toml`. `dist/*.js` (not the `.cjs` or `.d.ts` files) plus `LICENSE`.

Tarball: https://registry.npmjs.org/smol-toml/-/smol-toml-1.9.1.tgz

Integrity: `sha512-j7WyPdf0CJoutMzMoPLF/bVXHtKZIT9Rb4eGeEbWw8X2t5oirjPgpL+OpaENZrILYaXqYwnVH+qgUwVbl+pUJQ==`

## Updating

Get the new tarball URL and integrity from `npm view <name> dist.tarball dist.integrity version`. Download the tarball into a fresh empty temporary directory and verify its integrity (`openssl dgst -sha512 -binary <file> | base64 -w0`, prefixed with `sha512-`). Extract into another empty temporary directory, copy only the files listed above into the matching directory here (each directory carries a `package.json` containing `{"type": "module"}`), update this file, and run `node --test tests/`. Workbench uses only `YAML.parse` and `smol-toml`'s `parse`.
