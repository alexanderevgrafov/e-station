/*---------------------------------------
- WeAct Studio Official Link
- taobao: weactstudio.taobao.com
- aliexpress: weactstudio.aliexpress.com
- github: github.com/WeActTC
- gitee: gitee.com/WeAct-TC
- blog: www.weact-tc.cn
---------------------------------------*/

#include "epaper.h"
#include "epdfont.h"

#include <wiringPi.h>
#include <wiringPiSPI.h>

#define RES_PIN 22    // Pin 11
#define DC_PIN 25     // Pin 22
#define CS_PIN 8      // Pin 14
#define BUSY_PIN 24   // Pin 18
#define SPI_CHANNEL 0 // SPI Channel

uint16_t EPD_H = 300;
uint16_t EPD_W = 400;

EPD_PAINT EPD_Paint;

static uint8_t _hibernating = 1;


void epd_delay(uint16_t ms)
{
  delay(ms);
}

void epd_res_set()
{
  digitalWrite(RES_PIN, HIGH);
}

void epd_res_reset()
{
  digitalWrite(RES_PIN, LOW);
}

void epd_dc_set()
{
  digitalWrite(DC_PIN, HIGH);
}

void epd_dc_reset()
{
  digitalWrite(DC_PIN, LOW);
}

void epd_cs_set()
{
//   digitalWrite(CS_PIN, HIGH);
}

void epd_cs_reset()
{
//   digitalWrite(CS_PIN, LOW);
}

uint8_t epd_is_busy()
{
    return digitalRead(BUSY_PIN) ? 1 : 0;

}

void epd_io_init(void)
{
  // wiringPiSetup();
  if (wiringPiSetupGpio() < 0)
  { // use BCM2835 Pin number table
    printf("set wiringPi lib failed!\r\n");
    return;
  }
//  else
//  {
//    printf("set wiringPi lib success!\r\n");
//  }

  int mode =  3;
  if (wiringPiSPISetupMode(SPI_CHANNEL, 1000000, mode) < 0)
  {
    printf("spi setup failed!\r\n");
    return;
  }
//  else
//  {
//    printf("spi setup success!\r\n");
//  }

  // epd_cs_set();
  epd_dc_set();
  epd_res_set();

  pinMode(RES_PIN, OUTPUT);
  pinMode(DC_PIN, OUTPUT);
  // pinMode(CS_PIN, OUTPUT);
  pinMode(BUSY_PIN, INPUT);
}

void epd_io_deinit(void)
{
  pinMode(RES_PIN, PM_OFF);
  pinMode(DC_PIN, PM_OFF);
  // pinMode(CS_PIN, PM_OFF);
  pinMode(BUSY_PIN, PM_OFF);
  wiringPiSPIClose(SPI_CHANNEL);
}

void epd_write_reg(uint8_t reg)
{
  epd_dc_reset();
  epd_cs_reset();

  wiringPiSPIDataRW(SPI_CHANNEL, &reg, 1);

  epd_cs_set();
  epd_dc_set();
}

void epd_write_data(uint8_t data)
{
  epd_cs_reset();

  wiringPiSPIDataRW(SPI_CHANNEL, &data, 1);

  epd_cs_set();
}

void _epd_write_data(uint8_t *data, uint32_t len)
{
  uint8_t *dummy = malloc(len);
//  uint i;
  memcpy(dummy, data, len);
  if(dummy) {
//     printf("Buffer contents (%u bytes):\n ", len);
//      for(i = 0; i < len; i++) {
//        printf("0x%02X", dummy[i]);
//        if(i < len - 1) {
//          printf(", ");
//        }
//      }
//      printf("\n");


    uint32_t chunk_size = 4096;
    if(chunk_size == 0 || chunk_size > len) {
      chunk_size = len; // 如果块大小为0或大于总长度，则一次性传输
    }
    
    uint32_t remaining = len;
    uint32_t offset = 0;
    
    while(remaining > 0) {
      uint32_t current_chunk = (remaining > chunk_size) ? chunk_size : remaining;
      wiringPiSPIDataRW(SPI_CHANNEL, dummy + offset, current_chunk);
      offset += current_chunk;
      remaining -= current_chunk;
    } 

    free(dummy);
  }
}

uint8_t epd_wait_busy()
{
  uint32_t timeout = 0;
  while (epd_is_busy())
  {
    timeout++;
    if (timeout > 40000)
    {
      return 1;
    }
    epd_delay(1);
  }
  return 0;
}

void epd_reset(void)
{
  epd_res_reset();
  epd_delay(50);
  epd_res_set();
  epd_delay(50);
  _hibernating = 0;
}


// Common register setup shared by full and partial init - everything except
// the final power-on trigger, which epd_init_partial() skips (see below).
static uint8_t epd_init_registers(void)
{
  if (_hibernating) {
    epd_reset();
}
  if (epd_wait_busy()) {
    return 1;
    }

  epd_write_reg(0x12); // SWRESET

  epd_delay(100);

  if (epd_wait_busy()) {
    return 1;
}

    epd_write_reg(0x21); // Display Update Controll
    epd_write_data(0x40);
    epd_write_data(0x00);
    epd_write_reg(0x01); // Set MUX as 300
    epd_write_data(0x2B);
    epd_write_data(0x01);
    epd_write_data(0x00);
    epd_write_reg(0x3C); // BorderWavefrom
    epd_write_data(0x01);
    epd_write_reg(0x11);  // data  entry  mode
    epd_write_data(0x03); // X-mode
    epd_address_set(0, 0, EPD_W - 1, EPD_H - 1);


  epd_write_reg(0x18); // Read built-in temperature sensor
  epd_write_data(0x80);

  epd_setpos(0, 0);

  return 0;
}

uint8_t epd_init(void)
{
  if (epd_init_registers()) {
    return 1;
  }

  if (epd_power_on()) {
    return 1;
    }

  return 0;
}

uint8_t epd_init_fast(void)
{
  if (epd_init())
      return 1;


    epd_write_reg(0x22); // Load temperature value
    epd_write_data(0xB1);		
    epd_write_reg(0x20);	
    if (epd_wait_busy())
      return 1;

    epd_write_reg(0x1A); // Write to temperature register
    epd_write_data(0x6E);
              
    epd_write_reg(0x22); // Load temperature value
    epd_write_data(0x91);		
    epd_write_reg(0x20);	
    if (epd_wait_busy())
      return 1;


  return 0;
}

uint8_t epd_init_partial(void)
{
  // Deliberately epd_init_registers(), not epd_init(): epd_power_on() writes
  // 0x22=0xE0 (enable clock+analog) and activates. Every subsequent partial
  // push's epd_update_partial() writes 0x22=0xFF, which per the SSD16xx bit
  // layout already enables clock+analog itself as part of that trigger - a
  // separate power-on immediately beforehand is redundant, and matches a
  // documented SSD1680-family bug (GxEPD2, GDEY029T94) where exactly this
  // redundant power-on before a partial update caused an unintended internal
  // buffer switch even with no refresh actually requested. Skipping it here.
  if (epd_init_registers()) {
    return 1;
    }

    epd_write_reg(0x3C); // BorderWavefrom
    epd_write_data(0x80);
    epd_write_reg(0x21);  // Display Update Controll
    epd_write_data(0x00); // RED normal
    epd_write_data(0x00); // single chip application


// !!!!!!
//  epd_write_reg(0x22);
//  epd_write_data(0xfc);
//  epd_write_reg(0x20);

  return 0;
}

void epd_enter_deepsleepmode(uint8_t mode)
{
  epd_power_off();

    epd_write_reg(0x10);
    epd_write_data(mode);


  _hibernating = 1;
}

uint8_t epd_power_on(void)
{

    epd_write_reg(0x22); // Display Update Control
    epd_write_data(0xe0);

  epd_write_reg(0x20); // Activate Display Update Sequence

  return epd_wait_busy();
}

uint8_t epd_power_off(void)
{

    epd_write_reg(0x22); // Display Update Control
    epd_write_data(0x83);
    epd_write_reg(0x20); // Activate Display Update Sequence


  return epd_wait_busy();
}

void epd_init_internalTempSensor(void)
{

    epd_write_reg(0x18);
    epd_write_data(0x80);

    epd_write_reg(0x1A);
    epd_write_data(0x7F);

}

void epd_update(void)
{

    epd_write_reg(0x22); // Display Update Control
    epd_write_data(0xF7);

  epd_write_reg(0x20); // Activate Display Update Sequence

  epd_wait_busy();
}

void epd_update_fast(void)
{

    epd_write_reg(0x22); // Display Update Control
    epd_write_data(0xC7);

  epd_write_reg(0x20); // Activate Display Update Sequence

  epd_wait_busy();
}

void epd_update_partial(void)
{

    epd_write_reg(0x22); // Display Update Control
    epd_write_data(0xFF);

  epd_write_reg(0x20); // Activate Display Update Sequence

  epd_wait_busy();
}

void epd_address_set(uint16_t x_start, uint16_t y_start, uint16_t x_end, uint16_t y_end)
{

    epd_write_reg(0x44); // SET_RAM_X_ADDRESS_START_END_POSITION
    epd_write_data((x_start >> 3) & 0xFF);
    epd_write_data((x_end >> 3) & 0xFF);

    epd_write_reg(0x45); // SET_RAM_Y_ADDRESS_START_END_POSITION
    epd_write_data(y_start & 0xFF);
    epd_write_data((y_start >> 8) & 0xFF);
    epd_write_data(y_end & 0xFF);
    epd_write_data((y_end >> 8) & 0xFF);

//!!!!!!!
//    epd_write_reg(0x4e);
//    epd_write_data((x_start >> 3) & 0xFF);
//    epd_write_reg(0x4f);
//    epd_write_data(y_start & 0xFF);
//    epd_write_data((y_start >> 8) & 0xFF);
//!!!----------------

}

void epd_setpos(uint16_t x, uint16_t y)
{
  uint8_t _x;
  uint16_t _y = 0;

  _x = x / 8;


    _y = y;


    epd_write_reg(0x4E); // set RAM x address count to 0;
    epd_write_data(_x);
    epd_write_reg(0x4F); // set RAM y address count to 0x127;
    epd_write_data(_y & 0xff);
    epd_write_data(_y >> 8 & 0x01);

}

void epd_write_imagedata(uint8_t *Image1, uint32_t length)
{
  epd_cs_reset();
  _epd_write_data(Image1,length);
  epd_cs_set();
}

void epd_write_imagedata_invert(uint8_t *Image1, uint32_t length)
{
  uint8_t *dummy = malloc(length);
  for (uint32_t j = 0; j < length; j++)
  {
    dummy[j] = ~Image1[j];
  }

  epd_cs_reset();
  _epd_write_data(dummy, length);
  epd_cs_set();

  free(dummy);
}

void epd_write_zero_imagedata(uint32_t length)
{
  uint8_t *dummy = malloc(length);
  for (uint32_t j = 0; j < length; j++)
  {
    dummy[j] = 0;
  }

  epd_cs_reset();
  _epd_write_data(dummy, length);
  epd_cs_set();

  free(dummy);
}

void epd_displayBW(uint8_t *Image)
{
  uint32_t Width, Height;

  Width = EPD_H;
  Height = EPD_W_BUFF_SIZE;
  uint32_t length = Width * Height;


  epd_setpos(0, 0);
  epd_write_reg(0x26);
  epd_write_imagedata(Image, length);

  epd_setpos(0, 0);
  epd_write_reg(0x24);
  epd_write_imagedata(Image, length);

  epd_update();
}

void epd_displayBW_fast(uint8_t *Image)
{
  uint32_t Width, Height;

  Width = EPD_H;
  Height = EPD_W_BUFF_SIZE;
  uint32_t length = Width * Height;

  epd_setpos(0, 0);
  epd_write_reg(0x26);
  epd_write_imagedata(Image, length);

  epd_setpos(0, 0);
  epd_write_reg(0x24);
  epd_write_imagedata(Image, length);

  epd_update_fast();
}

void epd_displayBW_partial(uint8_t *Image)
{
  uint32_t Width, Height;

  Width = EPD_H;
  Height = EPD_W_BUFF_SIZE;

  epd_setpos(0, 0);
  epd_write_reg(0x24);
  epd_write_imagedata(Image, Width * Height);

  epd_update_partial();

  epd_setpos(0, 0);
  epd_write_reg(0x26);
//  epd_write_imagedata_invert(Image, Width * Height);
//    epd_write_zero_imagedata(Width * Height);
  epd_write_imagedata(Image, Width * Height);
//    epd_update_partial();
}

void epd_displayBW_partial2(uint8_t *Image, uint16_t x1, uint16_t y1, uint16_t x2, uint16_t y2)
{
  uint32_t Width, Height, WidthByte, bufLen;

  Width = x2 - x1;
  Height = y2 - y1;
  WidthByte = (Width % 8 == 0) ? (Width / 8) : (Width / 8 + 1);
  bufLen = WidthByte * Height;

  epd_setpos(x1, y1);
  epd_address_set(x1, y1, x2 - 1, y2 - 1);

  epd_write_reg(0x24);
  epd_write_imagedata(Image, bufLen);

  epd_update_partial();

  epd_setpos(x1, y1);
  epd_address_set(x1, y1, x2 - 1, y2 - 1);

  epd_write_reg(0x26);
  epd_write_imagedata(Image, bufLen);
}
