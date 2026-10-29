import type { SensorInfo } from '../api.ts';
import { SAMPLE_READINGS, TOKENS, TOKEN_NAMES, expandTokens } from '../../src/readings.ts';
import type { TReadings } from '../../src/readings.ts';

// The readings placeholders expand to in the editor - the same choice the
// server's preview render makes: live values once the sensor has answered,
// made-up ones before that, so a box can still be sized.
export function previewReadings(sensors: SensorInfo | null): TReadings {
  return sensors && sensors.readings.at !== null ? sensors.readings : SAMPLE_READINGS;
}

function age(at: number): string {
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
  return secs < 90 ? `${secs}s ago` : `${Math.round(secs / 60)} min ago`;
}

export function SensorPanel({ sensors, error }: { sensors: SensorInfo | null; error: string | null }) {
  const readings = previewReadings(sensors);
  const live = sensors !== null && sensors.readings.at !== null;

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Sensors</h2>
        <span className="badge">AHT20 + BMP280</span>
        {sensors && sensors.readings.at !== null && <span className="badge">read {age(sensors.readings.at)}</span>}
      </header>
      <p className="hint">
        Read every <code>sensorPollSecs</code> seconds (0 = off) from I2C bus <code>i2cBus</code> - both in Globals
        above. Put a placeholder in any text area&apos;s text and the panel repaints that area whenever the shown value
        changes. <code>{'{temp:0}'}</code> overrides the decimals; units are just text around it, e.g.{' '}
        <code>{'{temp}°'}</code>.
      </p>

      {error && <p className="error">{error}</p>}
      {sensors && (
        <ul className="sensor-status">
          {(['aht20', 'bmp280'] as const).map((name) => (
            <li key={name}>
              <strong>{name}</strong>{' '}
              <span className={sensors.status[name].startsWith('ok') ? 'sensor-ok' : 'error'}>{sensors.status[name]}</span>
            </li>
          ))}
        </ul>
      )}

      <table className="token-table">
        <thead>
          <tr>
            <th>Placeholder</th>
            <th>Reading</th>
            <th>{live ? 'Now' : 'Sample (no sensor yet)'}</th>
          </tr>
        </thead>
        <tbody>
          {TOKEN_NAMES.map((name) => (
            <tr key={name}>
              <td>
                <code>{`{${name}}`}</code>
              </td>
              <td>{TOKENS[name].label}</td>
              <td>{expandTokens(`{${name}}`, readings)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// Clickable placeholders under a text field: each one appends itself to the
// text, so nobody has to remember the names.
export function TokenChips({ onInsert }: { onInsert: (token: string) => void }) {
  return (
    <span className="token-chips">
      {TOKEN_NAMES.map((name) => (
        <button key={name} type="button" className="ghost tiny" title={TOKENS[name].label} onClick={() => onInsert(`{${name}}`)}>
          {`{${name}}`}
        </button>
      ))}
    </span>
  );
}
