
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>
#include "epaper.h"
//#include "bmp.h"
#include <signal.h>
#include <wiringPi.h>

#define HEADER_SIZE 8
#define BUFFER_SIZE 15000

#define METHOD_FAST 1
#define METHOD_PARTIAL 2
#define METHOD_PARTIAL2 3

// Reads and applies zero or more frames from stdin in a single process run,
// initializing the panel once (from the first frame's method) and entering
// deep sleep once at the end - not per frame. Cycling the panel through a
// full wake/init/sleep power transition several times back-to-back (as a
// separate process per frame used to do) destabilizes the RAM differencing
// partial refresh relies on and made things get slower and visually corrupt
// with each successive push.
int main() {
  epd_io_init();

  uint8_t initialized = 0;
  int frame_count = 0;

  while (1) {
    uint8_t method;
    uint16_t x1 = 0, y1 = 0, x2 = 400, y2 = 300;

    if (fread(&method, 1, 1, stdin) != 1) {
      break; // EOF: no more frames
    }
    fread(&x1, 1, 2, stdin);
    fread(&y1, 1, 2, stdin);
    fread(&x2, 1, 2, stdin);
    fread(&y2, 1, 2, stdin);

    printf("Frame %d method [%d]\n", frame_count, method);

    uint16_t expected_bytes = method == METHOD_PARTIAL2 ? ((x2 - x1) * (y2 - y1) / 8) : (400 * 300 / 8);

    uint8_t buffer[BUFFER_SIZE];
    size_t total_bytes_read = 0;
    size_t bytes_read;

    while (total_bytes_read < expected_bytes) {
      bytes_read = fread(buffer + total_bytes_read, 1,
                        expected_bytes - total_bytes_read, stdin);

      if (bytes_read == 0) {
        if (feof(stdin)) {
          break; // End of file reached
        } else if (ferror(stdin)) {
          fprintf(stderr, "Error reading from stdin\n");
          return 1;
        }
      }

      total_bytes_read += bytes_read;
    }

    if (total_bytes_read != expected_bytes) {
      fprintf(stderr, "Warning: frame %d expected %d bytes, got %zu\n",
              frame_count, expected_bytes, total_bytes_read);
      break;
    }

    if (!initialized) {
      switch (method) {
        case METHOD_FAST:
          epd_init_fast();
          break;
        case METHOD_PARTIAL:
        case METHOD_PARTIAL2:
          epd_init_partial();
          break;
        default:
          epd_init();
      }
      initialized = 1;
    }

    switch (method) {
      case METHOD_FAST:
        epd_displayBW_fast(buffer);
        break;
      case METHOD_PARTIAL:
        epd_displayBW_partial(buffer);
        break;
      case METHOD_PARTIAL2:
        printf("Partial update: x(%d, %d), y(%d, %d)\n", x1, x2, y1, y2);
        epd_displayBW_partial2(buffer, x1, y1, x2, y2);
        break;
      default:
        epd_displayBW(buffer);
    }

    frame_count++;
  }

  epd_enter_deepsleepmode(EPD_DEEPSLEEP_MODE1);
  epd_io_deinit();
  return 0;
}
