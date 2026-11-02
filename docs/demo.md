# Reproducible progress demo

This demo uses the real filesystem bridge to display public progress updates. It does not simulate a language model or display invented model output.

1. Install the VSIX from GitHub Releases and open an empty local test folder in VS Code.
2. Run **AI Side Comments: Start Watching**.
3. In a terminal, clone this repository and run:

   ```sh
   npm ci --ignore-scripts
   npm run compile
   node examples/agent-demo.cjs /absolute/path/to/test-folder
   ```

4. The extension displays planning, editing, testing, and completion updates. Click the editing update to open `ai-side-comments-demo.cjs` and see its inline explanation.

The example writes a new `ai-side-comments-demo.cjs` file and refuses to overwrite an existing file with that name. It also creates `.ai-side-comments/progress.json` in the test folder. Run it in a fresh folder when repeating the demo.

The sample function trims each name, removes empty values, drops duplicate names, and preserves the input array. The demo runs three actual assertions before reporting success.

To demonstrate model-generated explanations, enable a model in the extension panel, edit the sample, and wait for edits to settle. A separate **Code explained** entry streams the model's response. Provider access and usage limits apply.

For a short screen recording, show the editor on the left and the activity panel on the right, run the example, click the editing update, and expand its gutter comment. Keep any unrelated projects, account details, and terminal history outside the recording.
