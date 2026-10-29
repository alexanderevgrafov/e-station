import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { context } from './src/context.ts';
import { editorRouter } from './src/routes/editor.ts';
import { intakeRouter } from './src/routes/intake.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const server = express();
const PORT = Number(process.env['PORT']) || 3333;

const PUBLIC_DIR = path.join(__dirname, 'public');
// Built by `yarn build:client` (webpack) into public/editor/, which is
// deployed as a bundle - the client sources under client/ never run on the
// device. See README, "Layout editor".
const EDITOR_HTML = path.join(PUBLIC_DIR, 'editor', 'index.html');

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

server.use(express.json());
server.use(express.urlencoded({ extended: true }));

// The panel's update path: /intake?name=value sets variables that text areas
// show through {name} placeholders, and /intake/:areaName?field=value writes
// an area's own state. There is no internal timer driving content any more -
// whatever wants the clock on screen calls this.
server.use('/intake', intakeRouter);

// Layout editor: JSON API under /api/editor, single-page app at /editor.
server.use('/api/editor', editorRouter);

// Ahead of express.static on purpose. The bundle lives in public/editor/, so
// static would spot the directory and 301 /editor -> /editor/ before this
// route ever ran. Serving the page here keeps the URL as asked for; the
// bundle's own /editor/<name>.js still falls through to static below.
server.get('/editor', (_req, res) => {
  res.sendFile(EDITOR_HTML, (error) => {
    if (!error) return;
    console.error('Editor bundle missing:', error);
    res.status(500).type('text/plain').send('Editor bundle not built. Run `yarn build:client`.');
  });
});

server.use(express.static(PUBLIC_DIR));

// Whole-panel refresh on demand.
server.get('/api/clear-full', (_req, res) => {
  context.refreshAll('full-manual').then(
    (result) => res.json({ success: true, result }),
    (error: unknown) => {
      console.error('Error:', error);
      res.status(500).json({ success: false, message: errorMessage(error) });
    },
  );
});

// What the panel currently believes it is showing.
server.get('/api/status', (_req, res) => {
  res.json({
    success: true,
    layout: context.layoutName,
    layouts: Object.keys(context.layouts),
    areas: Object.keys(context.layout?.areas ?? {}),
    state: context.getState(),
    variables: context.getVariables(),
    readings: context.sensors.latest,
    sensors: context.sensors.status,
    global: context.global,
  });
});

// The context loads the document, registers fonts and paints the current
// layout before the port opens, so the first request never races startup.
context
  .init()
  .then(() => context.refreshAll())
  .catch((error: unknown) => console.error('Startup render failed:', error))
  .finally(() => {
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Layout: ${context.layoutName ?? '(none)'} - editor at /editor`);
    });
  });
