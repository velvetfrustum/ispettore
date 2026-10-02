# Tests

The unit and package checks use Node.js's built-in test runner. Browser integration tests use Playwright. Requires **Node 18+**.

## Run

From the `ispettore/` folder (where `package.json` lives):

```bash
npm test
```

## Layout

```
tests/
  unit/          # Fast module-level tests
  e2e/           # Generated dist/ extension package checks
  integration/   # Playwright tests against real demos
```

Run individual suites with:

```bash
npm run test:unit
npm run test:e2e
npm run test:integration:install # one-time Playwright Chromium install
npm run test:integration
```

`npm test` intentionally excludes Playwright so the default test command remains fast. Run `test:integration` explicitly when changing capture, replay, panel, or extension messaging behavior.
