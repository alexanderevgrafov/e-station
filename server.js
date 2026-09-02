import express from 'express';
import path from 'path';
import { EPaperDisplay } from './src/epd.js';


import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { refresh, clearFull, testTime } from './src/logic.js';
import { CLOCK_POLL_INTERVAL_MS } from './src/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const server = express();
const PORT = process.env.PORT || 3333;
const display = new EPaperDisplay();

// Middleware
server.use(express.json());
server.use(express.urlencoded({ extended: true }));
server.use(express.static(path.join(__dirname, 'public')));

// Routes
server.get('/api/clear-full', async (req, res) => {
  try {
    const result = await clearFull({ display });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Clock scheduler: /api/clock?start=1[&intervalMs=...] or /api/clock?stop=1,
// no params reports status. Polls on a plain timer from whenever it's
// started (not aligned to real minute boundaries), at CLOCK_POLL_INTERVAL_MS
// by default. This is the only thing that drives the display now - refresh()
// figures out on every poll whether HH:MM actually changed and only does
// work then, so polling faster than once a minute improves display accuracy
// without causing extra redraws.
let clockTimer = null;

server.get('/api/clock', async (req, res) => {
  if (req.query.stop === '1') {
    clearInterval(clockTimer);
    clockTimer = null;
    res.json({ success: true, running: false });
    return;
  }

  if (req.query.start === '1') {
    if (clockTimer) {
      res.json({ success: true, running: true, message: 'already running' });
      return;
    }
    const intervalMs = Number(req.query.intervalMs) || CLOCK_POLL_INTERVAL_MS;
    clockTimer = setInterval(() => {
      refresh({ display }).catch((error) => console.error('Auto-refresh error:', error));
    }, intervalMs);
    res.json({ success: true, running: true, intervalMs });
    return;
  }

  res.json({ success: true, running: clockTimer !== null });
});

// Debug: force the clock to instantly show a specific HH:MM (e.g.
// /api/test?time=2359), through the exact same diff/merge/flash logic as a
// real update - then holds that value against /api/clock's polls for
// TEST_TIME_HOLD_MS so there's time to look at it before real time takes
// back over.
server.get('/api/test', async (req, res) => {
  try {
    const result = await testTime({ display, hhmm: String(req.query.time || '') });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

server.post('/api/test2', (req, res) => {
  // POST routine
  const { body } = req;
  const response = {
    message: 'Test2 POST endpoint successful',
    timestamp: new Date().toISOString(),
    method: 'POST',
    receivedData: body,
  };
  res.json(response);
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});


