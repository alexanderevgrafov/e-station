import { setTimeout as sleep } from 'node:timers/promises';

import { NO_READINGS } from './readings.ts';
import type { TReadings } from './readings.ts';

// The AHT20 + BMP280 combo board on the Pi's I2C1 (SDA pin 3, SCL pin 5).
// Polled on a timer; whoever started the poller gets every fresh reading and
// decides what it means for the panel.
//
// i2c-bus is an optional native dependency, imported lazily: on the dev
// machine (or a Pi without I2C enabled) the poller just reports the sensors
// as missing and the rest of the server carries on.

// The slice of i2c-bus's PromisifiedBus used here, so the package's types
// are not needed.
interface I2cBus {
  i2cRead(addr: number, length: number, buffer: Buffer): Promise<{ bytesRead: number; buffer: Buffer }>;
  i2cWrite(addr: number, length: number, buffer: Buffer): Promise<{ bytesWritten: number; buffer: Buffer }>;
  readByte(addr: number, cmd: number): Promise<number>;
  writeByte(addr: number, cmd: number, byte: number): Promise<void>;
  readI2cBlock(addr: number, cmd: number, length: number, buffer: Buffer): Promise<{ bytesRead: number; buffer: Buffer }>;
  close(): Promise<void>;
}

interface I2cBusModule {
  openPromisified(busNumber: number): Promise<I2cBus>;
}

async function openBus(busNumber: number): Promise<I2cBus> {
  // @ts-ignore - optional dependency without type declarations.
  const module = (await import('i2c-bus')) as { default?: I2cBusModule } & I2cBusModule;
  return (module.default ?? module).openPromisified(busNumber);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- AHT20: temperature + humidity, fixed address 0x38 ----------------------

const AHT20_ADDR = 0x38;

// CRC-8, polynomial 0x31, init 0xFF - over the status byte and five data bytes.
function aht20Crc(bytes: Buffer): number {
  let crc = 0xff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 0x80 ? ((crc << 1) ^ 0x31) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

class Aht20 {
  private readonly bus: I2cBus;

  constructor(bus: I2cBus) {
    this.bus = bus;
  }

  // Loads the calibration if the chip says it is not calibrated yet (it is
  // after a clean power-up, but a brown-out can leave it unset).
  async init(): Promise<void> {
    const status = Buffer.alloc(1);
    await this.bus.i2cRead(AHT20_ADDR, 1, status);
    if ((status[0]! & 0x08) === 0) {
      await this.bus.i2cWrite(AHT20_ADDR, 3, Buffer.from([0xbe, 0x08, 0x00]));
      await sleep(10);
    }
  }

  async read(): Promise<{ temperature: number; humidity: number }> {
    await this.bus.i2cWrite(AHT20_ADDR, 3, Buffer.from([0xac, 0x33, 0x00]));
    await sleep(80);

    const data = Buffer.alloc(7);
    for (let attempt = 0; ; attempt += 1) {
      await this.bus.i2cRead(AHT20_ADDR, 7, data);
      if ((data[0]! & 0x80) === 0) break;
      if (attempt >= 5) throw new Error('AHT20 stayed busy');
      await sleep(20);
    }
    if (aht20Crc(data.subarray(0, 6)) !== data[6]) throw new Error('AHT20 CRC mismatch');

    // Two 20-bit values packed into bytes 1..5, humidity first.
    const rawHumidity = (data[1]! << 12) | (data[2]! << 4) | (data[3]! >> 4);
    const rawTemperature = ((data[3]! & 0x0f) << 16) | (data[4]! << 8) | data[5]!;
    return {
      humidity: (rawHumidity / 2 ** 20) * 100,
      temperature: (rawTemperature / 2 ** 20) * 200 - 50,
    };
  }
}

// --- BMP280: pressure + temperature, 0x77 or 0x76 by the SDO strap ----------

const BMP280_ADDRS = [0x77, 0x76];
// 0x56/0x57 are engineering samples, 0x58 production BMP280, 0x60 a BME280 -
// whose pressure and temperature path is identical.
const BMP280_CHIP_IDS = [0x56, 0x57, 0x58, 0x60];

interface Bmp280Calibration {
  t1: number;
  t2: number;
  t3: number;
  p: number[]; // dig_P1..dig_P9, P1 at index 0
}

class Bmp280 {
  private readonly bus: I2cBus;
  readonly address: number;
  private readonly cal: Bmp280Calibration;

  private constructor(bus: I2cBus, address: number, cal: Bmp280Calibration) {
    this.bus = bus;
    this.address = address;
    this.cal = cal;
  }

  static async probe(bus: I2cBus): Promise<Bmp280 | null> {
    for (const address of BMP280_ADDRS) {
      const id = await bus.readByte(address, 0xd0).catch(() => null);
      if (id === null || !BMP280_CHIP_IDS.includes(id)) continue;

      const raw = Buffer.alloc(24);
      await bus.readI2cBlock(address, 0x88, 24, raw);
      const cal: Bmp280Calibration = {
        t1: raw.readUInt16LE(0),
        t2: raw.readInt16LE(2),
        t3: raw.readInt16LE(4),
        p: [raw.readUInt16LE(6), ...Array.from({ length: 8 }, (_, i) => raw.readInt16LE(8 + i * 2))],
      };
      // No IIR filter: one forced-mode sample a minute has nothing to filter.
      await bus.writeByte(address, 0xf5, 0x00);
      return new Bmp280(bus, address, cal);
    }
    return null;
  }

  async read(): Promise<{ temperature: number; pressure: number }> {
    // Forced mode, temperature x2, pressure x16 oversampling: one measurement,
    // then the chip goes back to sleep on its own. ~44ms worst case.
    await this.bus.writeByte(this.address, 0xf4, (0b010 << 5) | (0b101 << 2) | 0b01);
    await sleep(50);
    for (let attempt = 0; (await this.bus.readByte(this.address, 0xf3)) & 0x08; attempt += 1) {
      if (attempt >= 5) throw new Error('BMP280 stayed busy');
      await sleep(10);
    }

    const data = Buffer.alloc(6);
    await this.bus.readI2cBlock(this.address, 0xf7, 6, data);
    const adcP = (data[0]! << 12) | (data[1]! << 4) | (data[2]! >> 4);
    const adcT = (data[3]! << 12) | (data[4]! << 4) | (data[5]! >> 4);

    // The datasheet's floating-point compensation formulas, verbatim.
    const { t1, t2, t3, p } = this.cal;
    const [p1, p2, p3, p4, p5, p6, p7, p8, p9] = p as [number, number, number, number, number, number, number, number, number];

    const tv1 = (adcT / 16384 - t1 / 1024) * t2;
    const tv2 = (adcT / 131072 - t1 / 8192) ** 2 * t3;
    const tFine = tv1 + tv2;
    const temperature = tFine / 5120;

    let v1 = tFine / 2 - 64000;
    let v2 = (v1 * v1 * p6) / 32768;
    v2 = v2 + v1 * p5 * 2;
    v2 = v2 / 4 + p4 * 65536;
    v1 = ((p3 * v1 * v1) / 524288 + p2 * v1) / 524288;
    v1 = (1 + v1 / 32768) * p1;
    if (v1 === 0) throw new Error('BMP280 calibration is zero');
    let pa = 1048576 - adcP;
    pa = ((pa - v2 / 4096) * 6250) / v1;
    v1 = (p9 * pa * pa) / 2147483648;
    v2 = (pa * p8) / 32768;
    pa = pa + (v1 + v2 + p7) / 16;

    return { temperature, pressure: pa / 100 };
  }
}

// --- The poller -------------------------------------------------------------

export type TSensorName = 'aht20' | 'bmp280';

// 'ok', or why the sensor is not producing readings.
export type TSensorStatus = Record<TSensorName, string>;

export class Sensors {
  private bus: I2cBus | null = null;
  private busNumber = 1;
  private aht20: Aht20 | null = null;
  private bmp280: Bmp280 | null = null;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  latest: TReadings = NO_READINGS;
  status: TSensorStatus = { aht20: 'not polled yet', bmp280: 'not polled yet' };
  pollSecs = 0;

  // Restarts the poller with the given settings and polls once right away, so
  // a sync or a boot does not wait a whole interval for the first values.
  // Resolves once that first poll has been handed to onReadings.
  start(busNumber: number, pollSecs: number, onReadings: (readings: TReadings) => void): Promise<void> {
    this.stop();
    if (busNumber !== this.busNumber) void this.closeBus();
    this.busNumber = busNumber;
    this.pollSecs = pollSecs;
    if (pollSecs <= 0) {
      this.latest = NO_READINGS;
      this.status = { aht20: 'polling off', bmp280: 'polling off' };
      onReadings(this.latest);
      return Promise.resolve();
    }

    const tick = () => this.poll().then(onReadings, (error: unknown) => console.error('Sensor poll failed:', error));
    this.timer = setInterval(tick, pollSecs * 1000);
    return tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async closeBus(): Promise<void> {
    const bus = this.bus;
    this.bus = null;
    this.aht20 = null;
    this.bmp280 = null;
    await bus?.close().catch(() => {});
  }

  // Logged on change only: a sensor that is unplugged would otherwise put a
  // line in the journal every poll, forever.
  private setStatus(name: TSensorName, status: string): void {
    if (this.status[name] !== status) console.log(`Sensor ${name}: ${status}`);
    this.status[name] = status;
  }

  // One round over both sensors. A sensor that fails is dropped and probed
  // again on the next poll, so replugging the board needs no restart.
  private async poll(): Promise<TReadings> {
    if (this.polling) return this.latest;
    this.polling = true;
    try {
      if (!this.bus) {
        try {
          this.bus = await openBus(this.busNumber);
        } catch (error) {
          const why = `no I2C bus ${this.busNumber}: ${errorMessage(error)}`;
          this.setStatus('aht20', why);
          this.setStatus('bmp280', why);
          return this.latest;
        }
      }
      const bus = this.bus;

      let fromAht: { temperature: number; humidity: number } | null = null;
      try {
        if (!this.aht20) {
          const aht20 = new Aht20(bus);
          await aht20.init();
          this.aht20 = aht20;
        }
        fromAht = await this.aht20.read();
        this.setStatus('aht20', 'ok');
      } catch (error) {
        this.aht20 = null;
        this.setStatus('aht20', `not answering at 0x38: ${errorMessage(error)}`);
      }

      let fromBmp: { temperature: number; pressure: number } | null = null;
      try {
        this.bmp280 ??= await Bmp280.probe(bus);
        if (this.bmp280) {
          fromBmp = await this.bmp280.read();
          this.setStatus('bmp280', `ok at 0x${this.bmp280.address.toString(16)}`);
        } else {
          this.setStatus('bmp280', 'not found at 0x76 or 0x77');
        }
      } catch (error) {
        this.bmp280 = null;
        this.setStatus('bmp280', `read failed: ${errorMessage(error)}`);
      }

      // The AHT20's temperature is preferred; the BMP280's is the fallback.
      this.latest = {
        temperature: fromAht?.temperature ?? fromBmp?.temperature ?? null,
        humidity: fromAht?.humidity ?? null,
        pressure: fromBmp?.pressure ?? null,
        at: fromAht || fromBmp ? Date.now() : this.latest.at,
      };
      return this.latest;
    } finally {
      this.polling = false;
    }
  }
}
