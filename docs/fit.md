# FIT encoding

`src/fit.ts` writes Garmin FIT workout files with the
[FIT JavaScript SDK](https://github.com/garmin/fit-javascript-sdk). Four things
about the format and the SDK drive most of that file.

## 1. The SDK writes parent fields only

It does not resolve subfield names like `durationTime` or
`customTargetSpeedLow`. So the encoder writes `durationValue`,
`customTargetValueLow` and `customTargetValueHigh` directly and applies the
profile's scaling itself:

| Quantity | Encoding |
| --- | --- |
| Time | seconds × 1000 |
| Distance | metres × 100 |
| Speed | m/s × 1000 |
| Heart rate | 0-100 is % of max HR; above 100 is bpm + 100 |
| Power | 0-1000 is % of FTP; above 1000 is watts + 1000 |

Enum fields are typed as `number` by the SDK, but the encoder also accepts the
profile's string names (`'time'`, `'heartRate'`) and resolves them, so the code
uses the names and narrows the encoder's type in one place.

## 2. Repeats are flattened

FIT stores steps as a flat list. A repeat is a step emitted **after** its
children, whose duration value points back at the message index of the first
child — which is why `flattenSteps` recurses first and pushes the repeat
afterwards.

A repeat has no target of its own, but `targetType: 'open'` is written anyway:
Garmin's own exports carry it, and an importer that reads `targetType` on every
step chokes on the one record missing it. With
`durationType: 'repeatUntilStepsCmplt'`, `targetValue` holds the repeat count
(the profile's `repeatSteps` subfield), which resolves off `durationType` and
so is unaffected by the `targetType` above.

## 3. An open range end is filled, not left out

FIT has no shape for half a band — every custom target is a low *and* a high —
and an importer given one of the two may reject the step outright.
intervals.icu does: a cooldown written as `target_heart_rate: ["-", 133]`
came back as *"Missing custom_target_value_low and/or custom_target_value_high"*
and the step was dropped from the calendar entry altogether.

So both ends are always written, and the open one gets a limit no athlete
reaches: 0 to 25 m/s for speed, 0 to 254 rpm for cadence, 1 to 255 bpm for
heart rate, 1 to 2000 W for power.

Heart rate and power pack two units into one field, so the filler is written in
whatever unit the caller used for the end they did give — a raw 0 under a
ceiling in watts reads as 0% of FTP under 120 W, two units in one band, which
is what an importer rejected before. A percentage range is filled with a
percentage: 1-99% of max HR, 1-999% of FTP. Neither filler is ever the offset
itself (100 for heart rate, 1000 for power), the one value where the two units
meet — the SDK's own decoder reads a 100 back as `bpmOffset`, not as 100%.

## 4. The encoder's buffer has to be clamped

The SDK's `OutputStream` asks for a *resizable* `ArrayBuffer` with a 500 MB
`maxByteLength`. V8 reserves that much address space up front, which production
workerd refuses against the isolate's memory cap — so the encoder threw before
writing a byte, while dev workerd let it through. The size is a private field
with no constructor option, so `createEncoder` swaps in a subclass that clamps
`maxByteLength` to 1 MB for the duration of the constructor call. That call is
synchronous with no `await` in it, so no other request can run while the global
is replaced.

## Filenames

Two, for two audiences.

- `fitFilename` — `2026-09-12-a1b2c3d4.fit`, mirroring the export URL, for a
  browser following a link.
- `fitDownloadName` — `2026-09-12-4x10-Tempo.fit`, for a caller that gets the
  bytes rather than a URL. Every MCP client is one of those, and a folder of
  these should read as a plan rather than a list of ids. Anything a filesystem
  would argue about collapses to a dash; a workout whose name survives none of
  that keeps its id.

## Testing

FIT files are asserted by decoding them again with the SDK's own decoder, and
the tests run inside `workerd`, which is where the buffer problem above only
ever showed up. See [testing.md](testing.md).
