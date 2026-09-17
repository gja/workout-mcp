# FIT encoding

`src/fit.ts` writes Garmin FIT workout files with the
[FIT JavaScript SDK](https://github.com/garmin/fit-javascript-sdk). Five things about
the format and the SDK drive most of that file.

## 1. The SDK writes parent fields only

It does not resolve subfields like `durationTime` or `customTargetSpeedLow`, so the
encoder writes `durationValue`, `customTargetValueLow` and `customTargetValueHigh`
directly and applies the profile's scaling itself:

| Quantity | Encoding |
| --- | --- |
| Time | seconds × 1000 |
| Distance | metres × 100 |
| Speed | m/s × 1000 |
| Heart rate | 0-100 is % of max HR; above 100 is bpm + 100 |
| Power | 0-1000 is % of FTP; above 1000 is watts + 1000 |

Enum fields are typed `number` by the SDK, but the encoder also accepts the profile's
string names (`'time'`, `'heartRate'`) and narrows the type in one place.

## 2. Repeats are flattened

FIT stores steps flat. A repeat is emitted **after** its children, with its duration
value pointing back at the first child's message index — hence `flattenSteps` recursing
first and pushing the repeat afterwards.

A repeat has no target, but `targetType: 'open'` is written anyway: Garmin's own exports
carry it and an importer reading `targetType` on every step chokes on the one record
missing it. With `durationType: 'repeatUntilStepsCmplt'`, `targetValue` holds the repeat
count, which resolves off `durationType` and is unaffected.

## 3. An open range end is filled, not left out

FIT has no shape for half a band, and an importer given one end may reject the step —
intervals.icu does, dropping it from the calendar entry altogether.

So both ends are always written, the open one at a limit no athlete reaches: 0.1-25 m/s,
1-254 rpm, 1-255 bpm, 1-2000 W. **Never zero** — a zero bound reads as unset and takes
the target with it.

Heart rate and power pack two units into one field, so the filler uses whatever unit the
caller used for the end they did give: a raw 0 under a ceiling in watts reads as 0% of
FTP under 120 W. A percentage range is filled with a percentage (1-99% of max HR,
1-999% of FTP). Neither filler is ever the offset itself (100, 1000), the one value where
the two units meet.

## 4. The encoder's buffer has to be clamped

The SDK's `OutputStream` asks for a resizable `ArrayBuffer` with a 500 MB
`maxByteLength`. V8 reserves that address space up front, which production workerd
refuses — so the encoder threw before writing a byte, while dev workerd let it through.
The size is a private field, so `createEncoder` swaps in a subclass clamping it to 1 MB
for the duration of the constructor call. That call is synchronous, so no other request
can run while the global is replaced.

## 5. A string field holds 255 bytes

Terminator included, and the SDK throws rather than truncating — so a workout with long
notes was a 500 on `/export/...fit` and a push that never landed.

The limits this app validates against are in characters and deliberately more generous
(1000 for a workout's notes, 200 for a step's), because they belong to the plan rather
than the file; a character is also up to four bytes. `fitString` cuts every string field
to 254 bytes on a whole character — walked by code point, so a surrogate pair is never
halved — and ends what it cut with an ellipsis.

## Filenames

- `fitFilename` — `2026-09-12-a1b2c3d4.fit`, mirroring the export URL, for a browser
  following a link.
- `fitDownloadName` — `2026-09-12-4x10-Tempo.fit`, for a caller that gets the bytes
  rather than a URL, so a folder of them reads as a plan. Anything a filesystem would
  argue about collapses to a dash; a name that survives none of it keeps its id.
