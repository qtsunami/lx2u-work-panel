# Development

This package is a local-first DSH work panel. The directory layout separates source, generated delivery files, tests and tooling; it does not change the product, storage contracts or UI framework. Existing product behavior and safety boundaries are described in the [README](../README.md) and [product roadmap](./ROADMAP.md).

## Source of truth

| Area | Edit here | Delivery contract |
| --- | --- | --- |
| Host routes, tools, prompts and validation | [src/host/index.js](../src/host/index.js) | Root [index.js](../index.js) only re-exports this Host entry, preserving the existing package entry. |
| Durable receipt inbox | [src/host/inbox-store.js](../src/host/inbox-store.js) | Loaded by the Host entry; keep bounded idempotency and storage semantics intact. |
| Canonical workspace and context | [src/host/workspace-store.js](../src/host/workspace-store.js) | Loaded by the Host entry; preserve identity/revision checks, migration and recovery. |
| Browser-safe shared logic | [src/shared/](../src/shared/) | Independently importable logic; the client build embeds the required modules. Host code may import shared logic directly. |
| Client loader and UI | [src/client/main.js](../src/client/main.js) | Hand-written template for the existing DSH loader, not a second generated client or a new framework entry. |
| Client build | [scripts/build-client.mjs](../scripts/build-client.mjs) | Embeds shared modules into the template and produces root [client.js](../client.js). Missing required shared modules are errors. |

Root [client.js](../client.js) is a generated delivery artifact with an automatic-generation banner. **Keep it in Git, but never hand-edit it.** Change the template or shared source and rebuild. There is one authoritative source per module; do not maintain duplicate implementations in the template and generated file. Commit the generated output alongside its source changes when preparing a change for review.

The bundle patch [cordis.patch.yml](../cordis.patch.yml), [locale directory](../locale/), [icon](../icon.svg) and [package manifest](../package.json) remain at the package root. Package exports continue to address the root Host and client entries. Development tooling and tests are not runtime dependencies.

## Build

Run these commands from the package root:

```bash
npm run build:client
node scripts/build-client.mjs --check
```

The first command regenerates the client from its template and shared source. The second verifies parity without rewriting the artifact and exits unsuccessfully if output is stale. Rebuild after changing either source input; do not fix parity by editing the generated file.

## Tests

```bash
npm test
```

This checks generated-client parity first, then runs all suites through [scripts/test-all.mjs](../scripts/test-all.mjs). It deliberately does not repair stale output: build first, then test. To run the suites without the parity gate:

```bash
node scripts/test-all.mjs
```

Tests are organized by scope, not by release version:

- [tests/unit/](../tests/unit/): shared logic, parsing and deterministic rules.
- [tests/host/](../tests/host/): Host routes/tools and durable inbox/workspace storage contracts.
- [tests/ui/](../tests/ui/): VM render and interaction regressions, including storage failures and stale responses.
- [tests/integration/](../tests/integration/): synchronization/outbox failure cases and interactions spanning Host and client contracts.
- [tests/helpers/](../tests/helpers/): reusable test adapters and fixtures, not independent suites.

An individual suite can be run with `node` and its path under the corresponding test directory. Tests that inspect the delivered client should use the generated artifact, not a separate hand-maintained copy. Do not remove safety assertions merely to accommodate the directory move.

VM and adapter tests do not prove live DSH navigation, focus behavior, theme rendering or desktop restart behavior. Verify relevant UI changes in the actual application separately; a passing test run or successful package build is not live acceptance.

## Packaging and installation checks

```bash
npm run build:client
npm test
npm pack --dry-run
npm pack
```

The `prepack` lifecycle in the [package manifest](../package.json) runs `npm run build:client`, so packing refreshes the delivery artifact. Run `npm test` independently before packing; tests are not installed as an end-user installation hook. Review the dry-run file list: the compatible root Host entry, its imported Host/shared sources, generated client, bundle patch, locale and icon must all be available. Source imports needed at runtime must not be omitted merely because the client embeds some shared modules.

The package remains installable through the existing DSH bundle mechanism; see [installation instructions](../README.md#install). Host changes require reloading the bundle through the plugin manager, or an app restart if the runtime requests one. A package build does not itself update a running installation. Do not promise automatic client refresh without verifying the active DSH development setup; validate the existing GUI after the appropriate reload or restart.

## Review checklist

1. Edit only the authoritative source for the intended behavior.
2. Build the client and review both source and generated diffs.
3. Run the parity check and all tests with `npm test`.
4. Inspect `npm pack --dry-run`, then create the tarball if needed.
5. Verify affected behavior in the actual DSH application; distinguish automated checks from live acceptance.

This restructuring does not authorize a release, package installation, product behavior changes or a Git commit by itself.
