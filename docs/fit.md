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

## 3. An open range end is an absent field

Not a stand-in value. FIT has no value that reads as "no limit" — a 0 floor on
a power range is read as 0% of FTP, not as "no floor" — so each bound is
written only if it exists.

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
