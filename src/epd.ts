import { spawn } from 'node:child_process';
import { createCanvas, registerFont } from 'canvas';
import type { Canvas, CanvasRenderingContext2D } from 'canvas';
import fs from 'node:fs';

const UTIL_PATH = '/home/dietpi/e-station/epd_update_util';
const FONT_PATH = '/home/dietpi/.fonts/ubuntu/Ubuntu-B.ttf';

// One frame as epd_update_util reads it off stdin: a 9-byte header followed
// by the packed 1bpp image data for that frame's region.
export interface EpdFrame {
  method: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  buffer: Uint8Array;
}

export interface EpdPushResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  frameCount: number;
}

export class EPaperDisplay {
  readonly width: number;
  readonly height: number;
  readonly canvas: Canvas;
  readonly ctx: CanvasRenderingContext2D;
  private _queue: Promise<unknown>;

  constructor() {
    this.width = 400;
    this.height = 300;
    this.registerFonts();
    this.canvas = createCanvas(this.width, this.height);
    this.ctx = this.canvas.getContext('2d');
    this.ctx.fillStyle = '#FFFFFF';
    this.ctx.fillRect(0, 0, this.width, this.height);

    // The panel is a single shared SPI/GPIO device: two hardware pushes must
    // never run concurrently (competing processes toggling the same pins
    // corrupts the transfer and can leave the panel wedged). Chain every
    // push through this queue so overlapping requests still run serially.
    this._queue = Promise.resolve();
  }

  // The font only exists on the device. Off-device the whole point of
  // running the server is the layout editor, which never touches the panel -
  // so a missing font warns instead of taking the process down. Clock
  // rendering would fall back to the `serif` in its font stack, at the wrong
  // metrics, which is why this warns loudly rather than staying quiet.
  registerFonts(): void {
    const fontPath = process.env['ESTATION_FONT_PATH'] ?? FONT_PATH;
    try {
      registerFont(fontPath, { family: 'Ubuntu' });
    } catch (error) {
      console.warn(`Could not register ${fontPath} - clock glyphs will render with the wrong metrics.`, error);
    }
  }

  displayBW(method: number, x1 = 0, y1 = 0, x2 = 400, y2 = 300): Promise<EpdPushResult> {
    return this.pushFrames([{ method, x1, y1, x2, y2, buffer: this.canvasToBuffer(x1, y1, x2, y2) }]);
  }

  // Streams multiple frames through a single epd_update_util invocation, so
  // the panel is initialized once and put to sleep once for the whole batch
  // instead of per frame. Waking, pushing one frame, and immediately
  // re-sleeping - repeated several times back-to-back across separate
  // processes - destabilizes the panel's RAM differencing state (partial
  // refresh compares against it) and was the cause of the growing latency
  // and inverted/corrupted output seen when clearing+redrawing a region
  // across 3 separate displayBW() calls. All frames in one batch must share
  // the same method (the util initializes once, from the first frame's).
  pushFrames(frames: EpdFrame[]): Promise<EpdPushResult> {
    const run = () => this._pushFramesToPanel(frames);
    const result = this._queue.then(run, run);
    this._queue = result.catch(() => {}); // one failed push must not jam the queue for the next one
    return result;
  }

  _pushFramesToPanel(frames: EpdFrame[]): Promise<EpdPushResult> {
    return new Promise<EpdPushResult>((resolve, reject) => {
      const childProcess = spawn(UTIL_PATH, [], {
        stdio: ['pipe', 'pipe', 'pipe'], // stdin, stdout, stderr
      });

      let stdout = '';
      let stderr = '';

      const { stdin, stdout: out, stderr: err } = childProcess;
      if (!stdin || !out || !err) {
        reject(new Error('epd_update_util was spawned without its stdio pipes'));
        return;
      }

      out.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      err.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      childProcess.on('close', (exitCode) => {
        if (exitCode !== 0) {
          reject(new Error(`epd_update_util exited ${exitCode}. stderr: ${stderr || '(empty)'} stdout: ${stdout || '(empty)'}`));
          return;
        }
        resolve({ stdout, stderr, exitCode, frameCount: frames.length });
      });

      childProcess.on('error', (error) => {
        reject(new Error(`Failed to start process: ${error.message}`));
      });

      /*  Each frame on stdin:
  struct {
    uint8_t method;
    uint16_t x1;
    uint16_t y1;
    uint16_t x2;
    uint16_t y2;
  } params;
  followed by the packed 1bpp image data for that frame's region.
      * */
      for (const { method, x1 = 0, y1 = 0, x2 = 400, y2 = 300, buffer } of frames) {
        const headBuff = Buffer.alloc(9);
        headBuff.writeUInt8(method, 0);
        headBuff.writeUInt16LE(x1, 1);
        headBuff.writeUInt16LE(y1, 3);
        headBuff.writeUInt16LE(x2, 5);
        headBuff.writeUInt16LE(y2, 7);

        stdin.write(headBuff);
        stdin.write(buffer);
      }

      stdin.end();
    });
  }

  canvasToBuffer(x1: number, y1: number, x2: number, y2: number): Uint8Array {
    const width = x2 - x1;
    const height = y2 - y1;
    const widthByte = Math.floor(width % 8 === 0 ? width / 8 : width / 8 + 1);
    const imageData = this.ctx.getImageData(x1, y1, width, height);
    const pixels = imageData.data;

    const bufferSize = widthByte * height;
    const buffer = new Uint8Array(bufferSize).fill(0xFF);

    // The `!` reads below are bounds-guaranteed by the loop and by
    // bufferSize; they are only here because noUncheckedIndexedAccess types
    // every typed-array read as possibly-undefined.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const pixelIndex = (y * width + x) * 4;

        // Set bit based on brightness threshold
        // Dark pixels (below threshold) = 1, bright pixels = 0
        const isBlack = pixels[pixelIndex]! < 128;
        const addr = Math.floor(x / 8) + y * widthByte;
        const bite = buffer[addr]!;
        if (isBlack) {
          buffer[addr] = bite & ~(0x80 >> (x % 8));
        } else
          buffer[addr] = bite | (0x80 >> (x % 8));
      }
    }

    return buffer;
  }

  saveCanvasAsImage(filename: string): void {
    const buffer = this.canvas.toBuffer('image/png');
    fs.writeFileSync(filename, buffer);
  }
}



