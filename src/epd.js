import { spawn } from 'child_process';
import { createCanvas, registerFont } from 'canvas';
import fs from 'fs';

const EPD_COLOR_WHITE = 0xFF;
const EPD_COLOR_BLACK = 0x00;

const UTIL_PATH = '/home/dietpi/e-station/epd_update_util';

export class EPaperDisplay {
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

  registerFonts() {
    registerFont('/home/dietpi/.fonts/ubuntu/Ubuntu-B.ttf', { family: 'Ubuntu' });
  }

  // Clear canvas
  paint_clear(color) {
    this.ctx.fillStyle = color === EPD_COLOR_BLACK ? '#000000' : '#FFFFFF';
    this.ctx.fillRect(0, 0, this.width, this.height);
  }

  paint_drawLine(xstart, ystart, xend, yend, color) {
    this.ctx.strokeStyle = color === EPD_COLOR_BLACK ? '#000000' : '#FFFFFF';
    this.ctx.linewidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(xstart, ystart);
    this.ctx.lineTo(xend, yend);
    this.ctx.stroke();
  }

  paint_drawRectangle(xstart, ystart, xend, yend, color = 0, mode = true) {
    const width = xend - xstart;
    const height = yend - ystart;

    if (mode) {
      // Filled rectangle
      this.ctx.fillStyle = color === EPD_COLOR_BLACK ? '#000000' : '#FFFFFF';
      this.ctx.fillRect(xstart, ystart, width, height);
    } else {
      // Outline rectangle
      this.ctx.strokeStyle = color === EPD_COLOR_BLACK ? '#000000' : '#FFFFFF';
      this.ctx.linewidth = 1;
      this.ctx.strokeRect(xstart, ystart, width, height);
    }
  }

  paint_drawCircle(xCenter, yCenter, radius, color, mode) {
    this.ctx.beginPath();
    this.ctx.arc(xCenter, yCenter, radius, 0, 2 * Math.PI);

    if (mode) {
      this.ctx.fillStyle = color === EPD_COLOR_BLACK ? '#000000' : '#FFFFFF';
      this.ctx.fill();
    } else {
      this.ctx.strokeStyle = color === EPD_COLOR_BLACK ? '#000000' : '#FFFFFF';
      this.ctx.linewidth = 1;
      this.ctx.stroke();
    }
  }

  paint_showString(x, y, text, size, color) {
    this.ctx.fillStyle = color === EPD_COLOR_BLACK ? '#000000' : '#FFFFFF';
    this.ctx.font = `${size}px Ubuntu, serif`;
    this.ctx.fillText(text, x, y + size); // Adjust y for baseline
  }

  displayBW(method, x1=0, y1=0, x2=400, y2=300) {
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
  pushFrames(frames) {
    const run = () => this._pushFramesToPanel(frames);
    const result = this._queue.then(run, run);
    this._queue = result.catch(() => {}); // one failed push must not jam the queue for the next one
    return result;
  }

  _pushFramesToPanel(frames) {
    return new Promise((resolve, reject) => {
      const childProcess = spawn(UTIL_PATH, [], {
        stdio: ['pipe', 'pipe', 'pipe'], // stdin, stdout, stderr
      });

      let stdout = '';
      let stderr = '';

      childProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      childProcess.stderr.on('data', (data) => {
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

        childProcess.stdin.write(headBuff);
        childProcess.stdin.write(buffer);
      }

      childProcess.stdin.end();
    });
  }

  canvasToBuffer(x1,y1,x2,y2) {
    const width = x2 - x1;
    const height = y2 - y1;
    const widthByte = Math.floor(width % 8 === 0 ? width / 8 : width / 8 + 1);
    const imageData = this.ctx.getImageData(x1, y1, width, height);
    const pixels = imageData.data;

    const bufferSize = widthByte * height;
    const buffer = new Uint8Array(bufferSize).fill(0xFF);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const pixelIndex = (y * width + x) * 4;

        // Set bit based on brightness threshold
        // Dark pixels (below threshold) = 1, bright pixels = 0
        const isBlack = pixels[pixelIndex] < 128;
        const addr = Math.floor(x / 8) + y * widthByte;
        const bite = buffer[addr];
        if (isBlack) {
          buffer[addr] = bite & ~(0x80 >> (x % 8));
        } else
          buffer[addr] = bite | (0x80 >> (x % 8));
      }
    }

    return buffer;
  }

  saveCanvasAsImage(filename) {
    const buffer = this.canvas.toBuffer('image/png');
    fs.writeFileSync(filename, buffer);
  }
}



