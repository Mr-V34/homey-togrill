# Third-Party Notices

This Homey app (`com.togrill`) is an independent, clean-room JavaScript
implementation for the Homey platform. It is **not** affiliated with, endorsed
by, or distributed by ToGrill, Home Assistant, or the authors listed below.

The ToGrill AT-02 Bluetooth LE protocol details used by this app — packet
framing, command/notification byte layouts, and the GrillType / Taste / probe
event enumerations — were derived from the open-source projects below. Where
specific constant byte values are reproduced, they are reproduced under the
terms of those projects' licenses.

---

## togrill-bluetooth

- Project: https://github.com/elupus/togrill-bluetooth
- Author: Joakim Plate (elupus)
- License: MIT

Protocol constants, packet structures, the GrillType and Taste enums, and the
A5 probe-event codes in `lib/togrill-protocol.js` are derived from this
project. Its MIT license and copyright notice are reproduced below as required:

```
MIT License

Copyright (c) 2025 Joakim Plate

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Home Assistant — ToGrill integration

- Project: https://www.home-assistant.io/integrations/togrill/
  (part of Home Assistant Core: https://github.com/home-assistant/core)
- License: Apache License 2.0

The feature set of this app (per-probe target/min/max/timer, grill type and
taste presets, alarm interval, ambient monitoring) was informed by the Home
Assistant ToGrill integration as a functional reference. No source code from
the integration was copied; this app is an independent implementation in
JavaScript for the Homey SDK. Acknowledged here under the spirit of the
Apache-2.0 license.
