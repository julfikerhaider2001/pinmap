# PinMap board data format

Every board or module lives in its own file: `data/boards/<id>.json`.
To add a board, create the file and add its id to `data/boards/index.json`.
Run `node tests/validate-data.mjs` to check it.

**Accuracy rule:** every pin table must be built from the official datasheet or
pinout document listed in `sources`. If a fact can't be confirmed from a
source, set `"verified": false` on that pin (or on that single function). The
UI then shows an "unverified" badge. Never guess.

## Top-level fields

| field | type | required | meaning |
|---|---|---|---|
| `id` | string | yes | Same as the file name, lowercase-kebab. |
| `name` | string | yes | Display name, e.g. `"ESP32-S3-DevKitC-1"`. |
| `category` | `"board"` \| `"shield"` \| `"module"` | yes | |
| `family` | string | yes | Grouping in the board picker: `"ESP32"`, `"ESP8266"`, `"Arduino"`, `"Raspberry Pi"`, `"Stepper driver"`, `"Sensor"`. |
| `mcu` | string | yes | Chip name, e.g. `"ESP32-S3"`, `"ATmega328P"`, `"RP2040"`, `"A4988"`. |
| `aliases` | string[] | yes | Search words, e.g. `["s3", "esp32s3", "devkitc"]`. |
| `logicVoltage` | number | yes | I/O voltage, e.g. 3.3 or 5. |
| `wireless` | string[] | yes | e.g. `["wifi","ble"]`, or `[]`. |
| `routing` | object | yes | Which peripherals can go to (almost) any GPIO through a pin matrix. Keys: `I2C`, `SPI`, `UART`, `PWM`. Values: `"any"` (any GPIO that can output) or `"fixed"` (only the pins whose `functions` list them). Example ESP32: `{"I2C":"any","SPI":"any","UART":"any","PWM":"any"}`. Uno: all `"fixed"`. |
| `codeStyle` | string | yes | How pins are named in code: `"arduino"` (2, A0), `"gpio"` (GPIO number), or `"bcm"` (Raspberry Pi BCM number). |
| `sources` | `{title, url, rev?, note?}`[] | yes, ≥1 | Official documents used. Put the main datasheet first. |
| `datasheet` | string (url) | yes | Primary official link, shown on the board page. |
| `verified` | boolean | yes | `true` only if the **whole** table was checked against `sources`. |
| `summary` | string | yes | One or two lines shown under the board name. |
| `warnings` | `{level, text, pins?}`[] | yes | Board-level warnings. `level` is `"info"`, `"warn"` or `"danger"`. `pins` lists pin `id`s. |
| `connectsTo` | string | shields only | id of the host board, e.g. `"arduino-uno-r3"`. |
| `i2cAddress` | string[] | I2C modules | e.g. `["0x36"]` (fixed address). |
| `layout` | object | yes | Drawing, see below. |
| `pins` | Pin[] | yes | |

## `layout` (units: 0.1 inch = 2.54 mm, which is one header pitch)

```json
"layout": {
  "width": 28, "height": 64,
  "features": [
    {"type": "chip",  "x": 6, "y": 4,  "w": 16, "h": 18, "label": "ESP32-S3-WROOM-1"},
    {"type": "usb",   "x": 9, "y": 60, "w": 4,  "h": 4,  "label": "USB"},
    {"type": "button","x": 2, "y": 58, "w": 3,  "h": 2,  "label": "BOOT"},
    {"type": "terminal", "x": 0, "y": 0, "w": 4, "h": 20, "label": "Motor"},
    {"type": "label", "x": 14, "y": 30, "label": "Free text"}
  ],
  "headers": [
    {"id": "J1", "x": 1, "y": 3, "dir": "down", "count": 22, "labelSide": "left"},
    {"id": "J3", "x": 27, "y": 3, "dir": "down", "count": 22, "labelSide": "right"}
  ]
}
```
- `x, y` is the centre of the header's **position 1**. Each next position is 1 unit further along `dir` (`"down"`, `"up"`, `"right"`, `"left"`). Optional `pitch` (default 1; use 2 for 5.08 mm screw terminals).
- `labelSide`: the side where pin labels are drawn: `"left"`, `"right"`, `"top"` or `"bottom"`.
- `color` (optional): solder-mask colour as `#rrggbb`, used to make the drawing look like the real board.
- Feature types: `chip`, `usb`, `button`, `led`, `terminal`, `jack`, `label`. These are only drawn for orientation and don't need to be exact.
- A 2-row header (like the Pi 40-pin) is written as **two** headers, one per row.
- Approximate geometry is fine. The pin **order** on each header must match the official pinout.

## Pin

```json
{
  "id": "J1-4",
  "header": "J1", "pos": 4,
  "label": "4",
  "gpio": 4,
  "code": "4",
  "functions": [
    {"type": "GPIO", "name": "GPIO4"},
    {"type": "ADC", "name": "ADC1_CH3"},
    {"type": "TOUCH", "name": "TOUCH4"},
    {"type": "RTC", "name": "RTC_GPIO4"}
  ],
  "flags": [],
  "notes": "",
  "verified": true
}
```
| field | meaning |
|---|---|
| `id` | Unique in the file. Suggested format: `<header>-<pos>`. |
| `header`, `pos` | Location (pos starts at 1). |
| `label` | Text printed on the silkscreen (e.g. `"D2"`, `"GPIO4"`, `"3V3"`, `"GND"`). |
| `gpio` | GPIO / port number as the MCU numbers it, or `null` for power, ground and control pins. For AVR boards, use the Arduino digital pin number (A0 on an Uno = 14). For the Pi, use the BCM number. |
| `code` | The exact token used in code, e.g. `"2"`, `"A0"`, `"4"` (ESP GPIO), `"17"` (BCM). `null` if not usable as I/O. |
| `functions` | Every function the official doc lists for this pin (see types below). `name` is the doc's signal name. Add `"verified": false` to a single function if only that one is unconfirmed. I2C functions should name the role: `"SDA"`/`"SCL"` appears in `name` (e.g. `"I2C0_SDA"`, `"SDA"`). Same for SPI (`MOSI`/`MISO`/`SCK`/`SS`/`CS`, or `COPI`/`CIPO`) and UART (`TX`/`RX`). |
| `flags` | From the list below. |
| `notes` | Short plain-English warning or explanation shown in the pin panel. |
| `verified` | `true` only when this pin's functions **and** flags were checked against `sources`. |

### Function `type` values
`GPIO, ADC, DAC, PWM, I2C, SPI, UART, TOUCH, RTC, USB, CAN, I2S, JTAG, INT, TIMER, SDIO, ANALOG_CMP, LED, POWER, GND, CTRL, CLOCK, MOTOR, CONFIG, OTHER`
- `INT`: external interrupt (e.g. AVR INT0).
- `CTRL`: reset, enable, boot, run.
- `MOTOR`: stepper driver step, dir, enable and coil outputs.
- `CONFIG`: microstep select and similar.
- `POWER` pins also need `flags: ["power"]`, and `GND` pins need `flags: ["ground"]`.

### `flags` values
| flag | meaning (shown as a warning) |
|---|---|
| `strapping` | Read at reset to pick the boot mode. External pull-ups or pull-downs can stop the board from booting. |
| `input-only` | Can't drive an output. |
| `flash` | Wired to the SPI flash. **Do not use.** |
| `psram` | Wired to the PSRAM on some module variants. Do not use if PSRAM is fitted. |
| `reserved` | Used on the board for something else. Do not use. Explain in `notes`. |
| `boot-glitch` | Pin toggles or outputs PWM/logs during boot. |
| `5v-tolerant` | The datasheet says the pin accepts 5 V. |
| `not-5v-tolerant` | 3.3 V maximum. Use only where the doc says so explicitly, or for any pin on a 3.3 V-only MCU. |
| `adc2-wifi` | ADC2 channel that can't be used while Wi-Fi is on. |
| `usb` | Used by the native USB or the USB-serial bridge. |
| `console-uart` | Default serial console / programming UART. |
| `onboard-led` | An LED is connected on the board. |
| `no-pullup` | Has no internal pull-up or pull-down. |
| `power`, `ground`, `nc` | Power pin, ground pin, not connected. |
