import type { SensorInfo } from '../api.ts';
import { SAMPLE_READINGS, SENSOR_VARS, expandTokens, isSensorVar, sensorVariables } from '../../src/variables.ts';
import type { TVariables } from '../../src/variables.ts';

// The pool placeholders expand to in the editor - the same choice the
// server's preview render makes: the live pool, with sample sensor values
// until the sensor has answered, so a box can still be sized.
export function previewVariables(sensors: SensorInfo | null): TVariables {
  return sensors ? sensors.variables : sensorVariables(SAMPLE_READINGS);
}

// Sensor variables first, in their fixed order, then whatever /intake has set.
function orderedNames(names: string[]): string[] {
  return [...names.filter(isSensorVar), ...names.filter((n) => !isSensorVar(n)).sort()];
}

// Everything in the pool, with where it comes from and what it shows now.
export function VariablesPanel({ sensors, error }: { sensors: SensorInfo | null; error: string | null }) {
  const variables = previewVariables(sensors);
  const sample = sensors === null || sensors.readings.at === null;

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Variables</h2>
      </header>
      <p className="hint">
        Put <code>{'{name}'}</code> in any text area&apos;s text; <code>{'{name:.1}'}</code> rounds to one decimal. Set
        variables with <code>/intake?name=value</code>.
      </p>

      {error && <p className="error">{error}</p>}
      <table className="token-table">
        <thead>
          <tr>
            <th>Placeholder</th>
            <th>Source</th>
            <th>Now</th>
          </tr>
        </thead>
        <tbody>
          {orderedNames(Object.keys(variables)).map((name) => (
            <tr key={name}>
              <td>
                <code>{`{${name}}`}</code>
              </td>
              <td>{isSensorVar(name) ? `sensor: ${SENSOR_VARS[name].label}${sample ? ' (sample)' : ''}` : '/intake'}</td>
              <td>{expandTokens(`{${name}}`, variables)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// Clickable placeholders under a text field: each one appends itself to the
// text, so nobody has to remember the names.
export function TokenChips({ names, onInsert }: { names: string[]; onInsert: (token: string) => void }) {
  return (
    <span className="token-chips">
      {orderedNames(names).map((name) => (
        <button
          key={name}
          type="button"
          className="ghost tiny"
          title={isSensorVar(name) ? SENSOR_VARS[name].label : 'set via /intake'}
          onClick={() => onInsert(`{${name}}`)}
        >
          {`{${name}}`}
        </button>
      ))}
    </span>
  );
}
