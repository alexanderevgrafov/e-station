import { Router } from 'express';
import type { Request, Response } from 'express';

import { context } from '../context.ts';
import type { TVariablesPatch } from '../context.ts';
import type { TAreaState } from '../types.ts';
import { isValidVarName } from '../variables.ts';

// The way the panel gets updated from outside.
//
//   GET  /intake?hours=14&minutes=32
//   POST /intake   {"hours": "14", "minutes": "32"}
//
// Sets variables in the pool the sensors also write to. Any text area can
// show any of them through {name} placeholders; only the areas whose text
// actually changes are repainted. A caller polling every few seconds with
// unchanged values costs nothing.
//
//   GET  /intake/:areaName?seed=42
//   POST /intake/:areaName   {"seed": 42}
//
// Writes an area's own state - only fractal has any (its seed). Its processor
// decides whether anything is repainted.
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

function patchFrom(req: Request, method: 'get' | 'post'): TAreaState {
  return method === 'get' ? patchFromQuery(req) : { ...patchFromQuery(req), ...patchFromBody(req) };
}

class IntakeError extends Error {}

// Strings and numbers go into the pool as they are, booleans as their text;
// null removes a variable. Anything else has no sensible way to be shown.
function toVariables(input: TAreaState): TVariablesPatch {
  const patch: TVariablesPatch = {};
  for (const [name, value] of Object.entries(input)) {
    if (!isValidVarName(name)) {
      throw new IntakeError(`bad variable name "${name}": letters, digits and _, not starting with a digit`);
    }
    if (value === null) patch[name] = undefined;
    else if (typeof value === 'string') patch[name] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) patch[name] = value;
    else if (typeof value === 'boolean') patch[name] = String(value);
    else throw new IntakeError(`variable "${name}" must be a string, a number, a boolean or null`);
  }
  return patch;
}

async function handleVariables(input: TAreaState) {
  if (Object.keys(input).length === 0) {
    return { status: 400, payload: { success: false, message: 'no variables given' } };
  }

  let patch: TVariablesPatch;
  try {
    patch = toVariables(input);
  } catch (error) {
    if (error instanceof IntakeError) return { status: 400, payload: { success: false, message: error.message } };
    throw error;
  }

  const refresh = await context.setVariables(patch);
  return {
    status: 200,
    payload: {
      success: true,
      layout: context.layoutName,
      variables: context.getVariables(),
      // null when no text area's rendered string changed - the common case
      // for a poller sending the same values again.
      refreshed: refresh,
    },
  };
}

async function handleArea(areaName: string, patch: TAreaState) {
  const layout = context.layout;
  if (!layout) {
    return { status: 503, payload: { success: false, message: 'no layout is loaded' } };
  }
  const area = layout.areas[areaName];
  if (!area) {
    const known = Object.keys(layout.areas).join(', ') || '(none)';
    return {
      status: 404,
      payload: { success: false, message: `no area "${areaName}" in layout "${context.layoutName}". Known areas: ${known}` },
    };
  }
  // The old way to drive a text area. Its text is now a template, so the
  // value has to go into a variable it refers to instead.
  if (area.type === 'text') {
    return {
      status: 400,
      payload: {
        success: false,
        message: `"${areaName}" is a text area, and text areas take no state: put {name} placeholders in its text and set them with /intake?name=value`,
      },
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
      // null when the processor decided nothing changed.
      refreshed: refresh,
    },
  };
}

type Outcome = { status: number; payload: object };

function respond(res: Response, work: Promise<Outcome>): void {
  work.then(
    ({ status, payload }) => res.status(status).json(payload),
    (error: unknown) => {
      console.error('Intake error:', error);
      res.status(500).json({ success: false, message: error instanceof Error ? error.message : String(error) });
    },
  );
}

for (const method of ['get', 'post'] as const) {
  intakeRouter[method]('/', (req, res) => {
    respond(res, handleVariables(patchFrom(req, method)));
  });

  intakeRouter[method]('/:areaName', (req, res) => {
    const areaName = typeof req.params['areaName'] === 'string' ? req.params['areaName'] : '';
    respond(res, handleArea(areaName, patchFrom(req, method)));
  });
}
