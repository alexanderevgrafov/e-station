import { Router, raw } from 'express';
import type { Request, Response } from 'express';
import { createCanvas } from 'canvas';

import * as images from '../images.ts';
import { preload as preloadImages } from '../images.ts';
import * as store from '../store.ts';
import { DocumentError, normalizeStore } from '../document.ts';
import { context } from '../context.ts';
import { loadFonts, findFace } from '../fonts.ts';
import { drawLayout } from '../render.ts';
import { defaultLayoutState } from '../area.ts';
import { SAMPLE_READINGS, sensorVariables } from '../variables.ts';
import type { TVariables } from '../variables.ts';

// The editor is a draft editor: it keeps the whole document in the browser
// and only sends it here on Sync&Save. So there are no granular mutation
// endpoints - an edit in progress must never reach the panel, which is
// exactly what per-field writes used to cause via the next /intake.
export const editorRouter = Router();

// What placeholders expand to in the editor: the live pool, with sample
// sensor values standing in while no sensor has answered, so a box can be
// sized against a realistic string either way.
function previewVariables(): TVariables {
  const live = context.getVariables();
  return context.sensors.latest.at === null ? { ...live, ...sensorVariables(SAMPLE_READINGS) } : live;
}

function fail(res: Response, error: unknown, what: string): void {
  const status = error instanceof DocumentError ? error.status : 500;
  const message = error instanceof Error ? error.message : String(error);
  if (status >= 500) console.error(`${what}:`, error);
  res.status(status).json({ success: false, message });
}

function param(req: Request, key: string): string {
  const value = req.params[key];
  return typeof value === 'string' ? value : '';
}

editorRouter.get('/store', (_req, res) => {
  store.load().then(
    (value) => res.json({ success: true, store: value, currentLayout: context.layoutName }),
    (error: unknown) => fail(res, error, 'Store load failed'),
  );
});

// Sync & Save: persist the whole document, then bring the panel up to it with
// a full clear and redraw. The single point where the editor touches either
// the file or the glass.
editorRouter.post('/sync', (req, res) => {
  Promise.resolve()
    .then(async () => {
      const body = req.body as { store?: unknown } | undefined;
      const saved = await store.save(body?.store);

      // The save has already happened and is durable. A panel that refuses to
      // repaint - unplugged, busy, missing binary - must not be reported as a
      // failed save, or the editor keeps showing unsaved edits for a document
      // that is on disk and would offer to write it again.
      let result = null;
      let warning: string | undefined;
      try {
        result = await context.sync();
      } catch (error) {
        warning = `Saved, but the panel did not repaint: ${error instanceof Error ? error.message : String(error)}`;
        console.error('Repaint after save failed:', error);
      }

      return { saved, result, warning };
    })
    .then(
      ({ saved, result, warning }) =>
        res.json({ success: true, store: saved, currentLayout: context.layoutName, result, warning }),
      (error: unknown) => fail(res, error, 'Save failed'),
    );
});

// The true render of a document that has not been saved. Takes the draft in
// the body and renders it without persisting anything, so the preview can
// follow the editor keystroke by keystroke while the panel stays on the last
// synced version.
editorRouter.post('/preview.png', (req, res) => {
  Promise.resolve()
    .then(async () => {
      const body = req.body as { store?: unknown; layout?: unknown } | undefined;
      const draft = normalizeStore(body?.store);
      const layoutName = typeof body?.layout === 'string' ? body.layout : '';
      const layout = draft.layouts[layoutName];
      if (!layout) throw new DocumentError(`no layout named "${layoutName}"`, 404);

      const preloaded = await preloadImages(layout);
      const canvas = createCanvas(draft.global.screenWidth, draft.global.screenHeight);
      // Area state is always the layout's defaults, never live state - the
      // preview is a design surface. Placeholders do expand, against the
      // live variable pool (see previewVariables).
      drawLayout(canvas.getContext('2d'), layout, defaultLayoutState(layout.areas), draft.global, preloaded, previewVariables());
      return canvas.toBuffer('image/png');
    })
    .then(
      (png) => {
        res.setHeader('Cache-Control', 'no-store');
        res.type('image/png').send(png);
      },
      (error: unknown) => fail(res, error, 'Preview render failed'),
    );
});

// What the sensors last said, why one is not saying anything, and the
// variable pool placeholders expand against in the editor.
editorRouter.get('/sensors', (_req, res) => {
  const { latest, status, pollSecs } = context.sensors;
  res.json({ success: true, readings: latest, status, pollSecs, variables: previewVariables() });
});

// Fonts the panel can actually render, so the editor offers a list rather
// than a free-text family box.
editorRouter.get('/fonts', (_req, res) => {
  loadFonts().then(
    (families) =>
      res.json({
        success: true,
        // The file paths are of no use to the browser; it fetches faces by id.
        fonts: families.map(({ family, weights, faces }) => ({
          family,
          weights,
          faces: faces.map(({ id, weight, style }) => ({ id, weight, style })),
        })),
      }),
    (error: unknown) => fail(res, error, 'Font scan failed'),
  );
});

// Serves a font file so the browser preview can @font-face the real family
// instead of approximating with whatever the dev machine happens to have.
editorRouter.get('/fonts/:id/file', (req, res) => {
  findFace(param(req, 'id')).then(
    (face) => {
      if (!face) {
        res.status(404).json({ success: false, message: 'unknown font face' });
        return;
      }
      res.sendFile(face.file, (error) => {
        if (error) res.status(404).end();
      });
    },
    (error: unknown) => fail(res, error, 'Font lookup failed'),
  );
});

// Images are content, not layout, so they upload immediately - an area's
// `src` referring to them is what stays in the draft until Sync&Save.
//
// Sent as a raw body rather than multipart: the browser can post a File
// straight through with its own Content-Type, which needs no parser and
// therefore no extra dependency on the device.
editorRouter.post('/images', raw({ type: ['image/png', 'image/jpeg'], limit: '25mb' }), (req, res) => {
  Promise.resolve()
    .then(() => {
      const body: unknown = req.body;
      if (!Buffer.isBuffer(body)) {
        throw new DocumentError('send the file as a raw body with Content-Type image/png or image/jpeg');
      }
      return images.saveUpload(body, context.global);
    })
    .then(
      (image) => res.json({ success: true, image }),
      (error: unknown) => fail(res, error, 'Image upload failed'),
    );
});

editorRouter.get('/images', (_req, res) => {
  images.list().then(
    (list) => res.json({ success: true, images: list }),
    (error: unknown) => fail(res, error, 'Image list failed'),
  );
});

editorRouter.get('/images/:id', (req, res) => {
  const file = images.pathFor(param(req, 'id'));
  if (!file) {
    res.status(400).json({ success: false, message: 'bad image id' });
    return;
  }
  // Content-addressed, so a given id's bytes never change.
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(file, (error) => {
    if (error) res.status(404).end();
  });
});

editorRouter.delete('/images/:id', (req, res) => {
  images.remove(param(req, 'id')).then(
    () => res.json({ success: true }),
    (error: unknown) => fail(res, error, 'Image delete failed'),
  );
});
