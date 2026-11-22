# Components

The library has **80 components** in 11 categories. The palette on the left lists them by
category; DSpec names them by the **type** in the tables below (and accepts a few aliases such as
`input`, `output`, `dff`, `inv`, `led` and `7seg`).

## Parts follow their properties

Every component draws its pins from its properties. Changing a property in the properties panel
adds or removes **real pins**, each one connectable on its own:

- a gate's `inputs` (2 to 16) sets its number of inputs;
- a multiplexer's `selectBits` sets both its data inputs (2^N) and its select pins;
- a register's `width` (1 to 32) sets its number of bits;
- many parts have a `pinMode`: `bus` gives one multi-bit pin (drawn as a thick bus wire), `bits`
  gives one 1-bit pin per bit.

Pin ids come from the properties (`in0`, `in1`, ..., `d0`, `d1`, ..., `s0`, ...), so they stay
the same when other properties change. All pins sit on the 10-unit grid, and the pins on one side
of a part always share one spacing, even after resizing.

## Resizing

Parts marked resizable can be made larger by dragging the handle on their corner. The size is a
minimum: the part grows if its pins need more room, and the pins spread evenly over the body.

## Generic block

`generic-block` is a box with any number of named inputs and outputs and a title. Use it for a
module you do not want to draw in detail: a controller, a previously designed sub-circuit, or a
block whose inside is described elsewhere. Pin names are given as comma-separated lists
(`inputNames="clk,rst,d"`); a name that already carries a bit range, like `SW[15:13]`, is shown as
written.

## The library

Ranges are the allowed values of a numeric property; lists are the options of a choice.

### I/O

| Type | Name | Description | Properties |
|---|---|---|---|
| `input-pin` | Input Pin | Primary circuit input terminal with configurable name and bus width | name, width (1..32) |
| `output-pin` | Output Pin | Primary circuit output terminal with configurable name and bus width | name, width (1..32) |
| `clock` | Clock | Periodic clock signal generator | name |
| `constant` | Constant | Constant logic level (0, 1, or multi-bit constant value) | value, width (1..32) |
| `ground` | Ground (GND) | Ground / logic 0 reference rail | none |
| `vcc` | VCC / Power | Power supply / logic 1 rail | label |
| `probe` | Probe / LED | Logic level indicator / LED probe | name |
| `tunnel` | Tunnel / Net Label | Named net connection tag (connects matching tunnel names across a schematic) | name, width (1..32) |
| `splitter` | Bus Splitter / Merger | Splits a multi-bit bus into individual bits or slices (or merges them into a bus) | width (2..32), fanOut (2..32) |
| `keypad` | Hex Keypad (4×4) | 16-key keypad: K is the code of the pressed key and VALID is 1 while a key is held | pinMode (bus, bits) |
| `push-button` | Push Button | Momentary push button: outputs 1 while pressed (or 0 when set to active low) | name, activeLow |
| `dip-switch` | DIP Switch | Bank of on/off switches, one output each, for setting input values by hand | count (1..16) |

### Displays

| Type | Name | Description | Properties |
|---|---|---|---|
| `seven-segment` | 7-Segment Display | Seven-segment display with one input per segment (a to g) and an optional decimal point. Common cathode lights a segment at 1, common anode at 0 | decimalPoint, common (cathode, anode) |
| `hex-display` | Hex Digit Display | Shows a 4-bit value as one hexadecimal digit (0 to F), with an optional decimal point | pinMode (bus, bits), decimalPoint |
| `led-bar` | LED Bar | Row of LEDs, one per input, for watching several signals at once | count (2..16) |

### Gates

| Type | Name | Description | Properties |
|---|---|---|---|
| `and` | AND | AND gate with configurable number of inputs | inputs (2..16) |
| `nand` | NAND | NAND gate with configurable number of inputs | inputs (2..16) |
| `or` | OR | OR gate with configurable number of inputs | inputs (2..16) |
| `nor` | NOR | NOR gate with configurable number of inputs | inputs (2..16) |
| `xor` | XOR | XOR gate with configurable number of inputs | inputs (2..16) |
| `xnor` | XNOR | XNOR gate with configurable number of inputs | inputs (2..16) |
| `buf` | Buffer | Buffer gate | none |
| `not` | NOT | NOT gate | none |
| `schmitt-buffer` | Schmitt-Trigger Buffer | Schmitt-Trigger Buffer: switches cleanly on slow or noisy inputs (input hysteresis) | none |
| `schmitt-inverter` | Schmitt-Trigger Inverter | Schmitt-Trigger Inverter: switches cleanly on slow or noisy inputs (input hysteresis) | none |
| `aoi` | AND-OR-Invert / OR-AND-Invert | Compound CMOS gates in one stage: AOI21 Y = (AB + C)', AOI22 Y = (AB + CD)', OAI21 Y = ((A + B)C)', OAI22 Y = ((A + B)(C + D))' | kind (aoi21, aoi22, oai21, oai22) |

### Plexers

| Type | Name | Description | Properties |
|---|---|---|---|
| `mux` | Multiplexer (MUX) | 2^N-to-1 multiplexer with configurable select bits, bus width, and optional enable | selectBits (1..5), dataWidth (1..32), enable, selectMode (bits, bus) |
| `demux` | Demultiplexer (DEMUX) | 1-to-2^N demultiplexer with configurable select bits, bus width, and optional enable | selectBits (1..5), dataWidth (1..32), enable, selectMode (bits, bus) |
| `decoder` | Decoder | N-to-2^N binary decoder with optional enable and active-low outputs | inputs (1..5), enable, activeLowOutputs |
| `encoder` | Priority Encoder | 2^N-to-N binary or priority encoder with optional valid output and enable | outputBits (1..5), priority, validOut, enable |
| `tristate` | Tri-State Buffer | Tri-state buffer with active-high or active-low enable and configurable bus width | width (1..32), activeLowEnable, invertedOut |
| `bcd-7seg` | BCD to 7-Segment Decoder | Turns a BCD digit (0 to 9) into segment signals a to g for a 7-segment display (like the 7447 / 7448). Active-low outputs drive a common-anode display; LT' lights every segment, BI' blanks them | pinMode (bus, bits), activeLow, controls |
| `bit-selector` | Bit Selector | Picks one bit of a bus: Y = D[S] | width (2..32) |
| `gray-converter` | Gray Code Converter | Converts binary to Gray code (G = B xor B>>1), or Gray code back to binary | width (2..32), pinMode (bus, bits), direction (toGray, toBinary) |
| `bus-transceiver` | Bus Transceiver | Bidirectional bus buffer (like the 74245): DIR = 1 drives B from A, DIR = 0 drives A from B; OE' = 1 disconnects both | width (1..32) |

### Arithmetic

| Type | Name | Description | Properties |
|---|---|---|---|
| `half-adder` | Half Adder | 1-bit half adder with Sum and Carry-out | none |
| `full-adder` | Full Adder | 1-bit full adder with Carry-in on top and Carry-out on bottom | none |
| `adder` | N-bit Adder | Parametric N-bit binary adder with optional carry-in and carry-out | width (1..32), pinMode (bus, bits), carryIn, carryOut |
| `subtractor` | N-bit Subtractor | Parametric N-bit binary subtractor with optional borrow-in and borrow-out | width (1..32), pinMode (bus, bits), borrowIn, borrowOut |
| `comparator` | Comparator | N-bit magnitude comparator with toggleable A>B, A=B, A<B outputs | width (1..32), pinMode (bus, bits), signed, showGt, showEq, showLt |
| `alu` | ALU | Textbook V-notched Arithmetic Logic Unit with configurable width, op-select bits, and N/Z/C/V flags | width (1..32), opBits (1..6), opPinMode (bits, bus), flagN, flagZ, flagC, flagV |
| `shifter` | Shifter | Barrel shifter supporting logical/arithmetic/rotate or universal mode | width (2..32), shiftBits (1..5), pinMode (bus, bits), mode (universal, lsl, lsr, asr, ror) |
| `multiplier` | Multiplier | N×N binary multiplier with full 2N-bit or truncated N-bit product output | width (2..32), pinMode (bus, bits), signed, fullProduct |
| `incrementer` | Incrementer | Adds 1 to an N-bit value (Y = A + 1), with an optional carry-out | width (1..32), pinMode (bus, bits), carryOut |
| `decrementer` | Decrementer | Subtracts 1 from an N-bit value (Y = A - 1), with an optional borrow-out | width (1..32), pinMode (bus, bits), borrowOut |
| `negator` | Negator | Two's complement negation of an N-bit value (Y = -A) | width (1..32), pinMode (bus, bits) |
| `divider` | Divider | Unsigned N-bit divider: quotient Q = A / B and remainder R = A mod B | width (1..32), pinMode (bus, bits) |
| `bit-extender` | Bit Extender | Widens (or truncates) a bus: sign extension copies the top bit, zero extension adds 0s, or fill with ones | inWidth (1..32), outWidth (1..32), mode (sign, zero, one) |
| `parity` | Parity Generator / Checker | ODD is 1 when an odd number of inputs are 1 (the XOR of all inputs); EVEN is its inverse | inputs (2..16) |
| `bit-counter` | Bit Counter (Popcount) | Counts how many input bits are 1 | width (2..32), pinMode (bus, bits) |
| `carry-lookahead` | Carry-Lookahead Generator | 4-bit carry-lookahead unit (like the 74182): carries C1 to C3 from propagate/generate inputs, plus block P and G | none |

### Latches

| Type | Name | Description | Properties |
|---|---|---|---|
| `sr-latch` | SR Latch | Set-Reset latch with optional active-low S'/R' inputs and inverted Q output | activeLow, showQBar |
| `d-latch` | D Latch | Level-sensitive transparent D latch with enable and optional Q' output | width (1..32), activeLowEnable, showQBar |
| `gated-sr-latch` | Gated SR Latch | Level-enabled SR latch with enable pin and optional Q' output | activeLowEnable, showQBar |

### Flip-Flops

| Type | Name | Description | Properties |
|---|---|---|---|
| `d-ff` | D Flip-Flop | D Flip-Flop with configurable clock edge, async set/reset, enable, and Q' output | edge (rising, falling), asyncReset (none, active-high, active-low), asyncSet (none, active-high, active-low), enable, showQBar |
| `jk-ff` | JK Flip-Flop | JK Flip-Flop with configurable clock edge, async set/reset, enable, and Q' output | edge (rising, falling), asyncReset (none, active-high, active-low), asyncSet (none, active-high, active-low), enable, showQBar |
| `t-ff` | T Flip-Flop | T Flip-Flop with configurable clock edge, async set/reset, enable, and Q' output | edge (rising, falling), asyncReset (none, active-high, active-low), asyncSet (none, active-high, active-low), enable, showQBar |
| `sr-ff` | SR Flip-Flop | SR Flip-Flop with configurable clock edge, async set/reset, enable, and Q' output | edge (rising, falling), asyncReset (none, active-high, active-low), asyncSet (none, active-high, active-low), enable, showQBar |

### Registers

| Type | Name | Description | Properties |
|---|---|---|---|
| `register` | N-bit Register | Parametric N-bit synchronous register with bus or per-bit pins, enable, and reset | width (1..32), pinMode (bus, bits), enable, reset, edge (rising, falling) |
| `shift-register` | Shift Register | N-bit serial/parallel shift register with configurable shift direction and parallel load | width (2..32), direction (right, left, bidirectional), parallelLoad, parallelOut, pinMode (bus, bits), reset |
| `counter` | Counter | Parametric N-bit binary counter with optional up/down, parallel load, enable, reset, and carry-out | bits (1..32), pinMode (bus, bits), upDown, load, enable, reset, carryOut |
| `register-file` | Register File | Multi-port register file (MIPS/RISC-V style) with configurable read/write ports, address bits, and width | addressBits (1..6), dataWidth (1..32), readPorts (1..4), writePorts (1..2), pinMode (bus, bits) |
| `ring-counter` | Ring / Johnson Counter | Shift-register counter: a ring counter moves a single 1 around (N states, one-hot); a Johnson counter feeds back the inverted last bit (2N states) | bits (2..16), mode (ring, johnson), enable |
| `lfsr` | LFSR (Pseudo-Random) | Linear-feedback shift register: steps through a pseudo-random sequence on each clock | bits (2..32), pinMode (bus, bits), enable, edge (rising, falling) |
| `clock-divider` | Clock Divider | Output clock runs N times slower than the input clock | divisor (2..1000000), reset |
| `synchronizer` | Synchronizer | Chain of flip-flops that brings an asynchronous input safely into a clock domain (avoids metastability) | stages (2..4), edge (rising, falling) |
| `edge-detector` | Edge Detector | Outputs a one-clock pulse P when input D changes: on a rising edge, a falling edge, or both | detect (rising, falling, both) |
| `decade-counter` | Decade Counter (BCD) | Counts 0 to 9 in BCD and wraps; TC is 1 at 9 so digits can be chained (like the 74160) | pinMode (bus, bits), enable, load, edge (rising, falling) |
| `debouncer` | Debouncer | Cleans up a bouncing push-button or switch signal: OUT changes only after IN has been steady for a while | edge (rising, falling) |

### Memory

| Type | Name | Description | Properties |
|---|---|---|---|
| `ram` | RAM | Synchronous Random-Access Memory with separate or shared bidirectional data port | addressBits (1..16), dataWidth (1..32), dataPortMode (separate, shared), pinMode (bus, bits), chipSelect |
| `rom` | ROM | Read-Only Memory block with configurable address width and data width; its contents are a list of hex words from address 0 | addressBits (1..16), dataWidth (1..32), pinMode (bus, bits), chipSelect, contents |
| `fifo` | FIFO Queue | First-in first-out buffer: WR stores DIN, RD removes the oldest word; FULL and EMPTY flags | depth (2..4096), width (1..32), edge (rising, falling) |
| `dual-port-ram` | Dual-Port RAM | Memory with two independent ports: port A reads and writes, port B reads at the same time | addressBits (1..24), dataWidth (1..32), edge (rising, falling) |
| `stack` | Stack (LIFO) | Last-in first-out memory: PUSH stores DIN on top, POP removes the top word; TOP shows it | depth (2..4096), width (1..32), edge (rising, falling) |

### Transistors

| Type | Name | Description | Properties |
|---|---|---|---|
| `nmos` | nMOS Transistor | n-channel MOSFET switch: conducts between D and S when the gate G is 1 | none |
| `pmos` | pMOS Transistor | p-channel MOSFET switch: conducts between S and D when the gate G is 0 | none |
| `transmission-gate` | Transmission Gate | nMOS and pMOS in parallel: passes A to B in both directions when EN = 1 (and EN' = 0) | none |

### Misc

| Type | Name | Description | Properties |
|---|---|---|---|
| `generic-block` | Generic Block | Fully user-definable subcircuit / black-box block with custom title and named inputs/outputs | title, inputs (0..32), outputs (0..32), inputNames, outputNames |
| `pull-up` | Pull-Up Resistor | Pull-up resistor connected to VCC/VDD | label |
| `pull-down` | Pull-Down Resistor | Pull-down resistor connected to Ground | label |

