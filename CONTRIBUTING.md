# Contributing

Use Node.js 22 or newer and VS Code 1.95 or newer.

```sh
npm ci --ignore-scripts
npm test
npm run package
```

Press F5 in VS Code to open a development host. To run native integration checks against an installed VS Code binary, use `npm run test:host`; set `VSCODE_EXECUTABLE` if `code` is not on PATH. This creates watched fixtures under `.test-work/` and an isolated profile in the OS temporary directory. Both are retained for diagnostics.

Keep changes focused. Add tests for changes to scheduling, cancellation, model requests, progress validation, or file filtering. For UI changes, check both light and dark themes, keyboard navigation, and long explanations. Model text and progress messages must remain untrusted content, rendered as text.

Bug reports should include the extension version, VS Code version, OS, steps to reproduce, and expected versus actual behavior. Include only minimal example code you can share publicly. A model-provider error can be useful, but remove tokens and private source code before posting it.

The automated tests do not require a model subscription. Native smoke tests do not exercise provider billing, account consent, or a live model. Describe additional manual validation in your pull request.
