10-bytes
byte 0 Header '$'
byte 1 Command check below
byte 2~6 Payload check below
byte 7 Checksum 8-bit sum of bytes 0~6
byte 8 Footer '#'

Commands and Payloads:
'D' = Developer options

- The host requests developer data for a specific shot in a shooting session
- byte[2] = 1~100: the desired shot detected
- The device responds with the behaviour of the sensors corresponding to that shot
- byte[2] = L4 L3 L2 L1 R4 R3 R2 R1: bitwise indicator of which sensors detected the shot
- byte

'H' = Heartbeat

- The device will send a heartbeat at startup
- The device will echo back when receiving heartbeat message
- There is no payload as of now (all zeros)

## 'M' = Mode (not implemented)

-
-

'P' = Play

- The device will start the detection when it receives this command
- The device will echo back to confirm receipt
- There is no payload as of now (all zeros)

'S' = Stop

- The device will stop the detection when it receives this command
- The device will echo back to confirm receipt
- There is no payload as of now (all zeros)

'O' = Offset (not implemented)

- The host sends an offset correction for the x and y values
- The device echos back for confirmation
- byte[3] and byte[4]: big-endian int16 x-offset in mm
- byte[5] and byte[6]: big-endian int16 y-offset in mm

'T' = Test

- The device will conduct a self test when it receives this command
- The host sends this command with no payload (all zeros)
- The device will respond with three different scenarios
- byte[2] = 255 (0xff): this means that the device is in stop mode (remaining bytes are zeros)
- byte[2] = 0 (0x00): this means that the device is in play mode but it failed the test
- byte[2] = 1 (0x01): this means that the device is in play mode and the test is successful
- byte[3] and byte[4]: big-endian int16 x-position in mm
- byte[5] and byte[6]: big-endian int16 y-position in mm
- If the test is successful, then x should be around -150 and y should be around 600
- If the test fails that means the timer is not working properly

'L' = Location of shot

- The device will send this if a shot is detected during play mode
- byte[2] = shot count
- byte[3] and byte[4]: big-endian int16 x-position in mm
- byte[5] and byte[6]: big-endian int16 y-position in mm
- If the (x, y) position received is (0, 0) it means not all the sensors are detecting

'G' = Get Wiper Position - 0x47 - 71

- The host will send this to request the wiper positions
- The host sends byte[2] = 'A' or 'B' for page A or page B
- The device will respond with 5 wiper positions with respect to the requested page

'W' = Write Wiper Position - 0x57 - 87

- The host will send this to write new wiper positions
- byte[2] = 'A' or 'B' for page A or page B
- byte[3] = 1~5 for wiper selection in each page
- byte[4] = 0~255 new wiper position
- Remaining payload is zeros
- The device will respond with updated positions for the requested page

## 'R' = Read Params (not implemented)

-
-

Examples:
'A' - 65
'B' - 66
Tx: 0x24 'G' 'A' 0 0 0 0 crc 0x23
Rx: 0x24 'G' 10 10 10 10 251 crc 0x23
Tx: 0x24 'G' 'B' 0 0 0 0 crc 0x23
Rx: 0x24 'G' 10 10 10 10 11 crc 0x23

Tx: 0x24 'W' 'A' 2 20 0 0 crc 0x23
Rx: 0x24 'W' 'A' 2 20 0 0 crc 0x23

Tx: 0x24 'G' 'A' 0 0 0 0 crc 0x23
Rx: 0x24 'G' 10 20 10 10 251 crc 0x23

Tx: 0x24 'D' 5 0 0 0 0 crc 0x23
Rx: 0x24 'D' sensors 0 0 0 0 crc 0x23
sensors : L4 L3 L2 L1 R4 R3 R2 R1
0xBC=XXX= 1 0 1 1 1 1 0 0

sensors : L4 L3 L2 L1 R4 R3 R2 R1
0xFF=255= 1 1 1 1 1 1 1 1

reading a specific shot:
Tx: 0x24 'L' 5 0 0 0 0 crc 0x23
