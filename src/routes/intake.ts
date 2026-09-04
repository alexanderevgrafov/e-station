import { Router } from 'express';
import type { Request } from 'express';

import { context } from '../context.ts';
import type { TAreaState } from '../types.ts';

// The way the panel gets updated from outside.
//
//   GET  /intake/:areaName?text=14:32
//   POST /intake/:areaName   {"text": "14:32"}
//
// Values land in that area's state; its processor decides whether anything is
// actually repainted. A caller polling every few seconds with an unchanged
// value costs nothing.
export const intakeRouter = Router();

// Query values stay strings, deliberately. Coercing "14" to a number looks
// tidy until "09" becomes 9 and the clock loses its leading zero - which is
// the whole reason this endpoint exists. Anything wanting real JSON types
// sends a POST body instead.
function patchFromQuery(req: Request): TAreaState {
  const patch: TAreaState = {};
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value === 'string') patch[key] = value;
    else if (Array.isArray(value)) patch[key] = value.filter((v): v is string => typeof v === 'string');
  }
  return patch;
}

function patchFromBody(req: Request): TAreaState {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return {};
  return body as TAreaState;
}

async function handle(req: Request, areaName: string, patch: TAreaState) {
  const layout = context.layout;
  if (!layout) {
    return { status: 503, payload: { success: false, message: 'no layout is loaded' } };
  }
  if (!layout.areas[areaName]) {
    const known = Object.keys(layout.areas).join(', ') || '(none)';
    return {
      status: 404,
      payload: { success: false, message: `no area "${areaName}" in layout "${context.layoutName}". Known areas: ${known}` },
    };
  }
  if (Object.keys(patch).length === 0) {
    return { status: 400, payload: { success: false, message: 'no state fields given' } };
  }

  const refresh = await context.setState(areaName, patch);
  return {
    status: 200,
    payload: {
      success: true,
      area: areaName,
      layout: context.layoutName,
      state: context.getAreaState(areaName),
      // null when the processor decided nothing changed - the common case for
      // a poller sending the same value again.
      refreshed: refresh,
    },
  };
}

for (const method of ['get', 'post'] as const) {
  intakeRouter[method]('/:areaName', (req, res) => {
    const areaName = typeof req.params['areaName'] === 'string' ? req.params['areaName'] : '';
    const patch = method === 'get' ? patchFromQuery(req) : { ...patchFromQuery(req), ...patchFromBody(req) };

    handle(req, areaName, patch).then(
      ({ status, payload }) => res.status(status).json(payload),
      (error: unknown) => {
        console.error('Intake error:', error);
        res.status(500).json({ success: false, message: error instanceof Error ? error.message : String(error) });
      },
    );
  });
}
