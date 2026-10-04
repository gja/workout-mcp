import { useRef, useState, type DragEvent } from 'react';
import { uploadRecording, type Workout } from './api';

const carriesFiles = (event: DragEvent | globalThis.DragEvent) =>
  Array.from(event.dataTransfer?.types ?? []).includes('Files');

/** Stops a .fit dropped beside a workout from navigating the tab away to the file. */
export function guardPageDrops(): void {
  for (const type of ['dragover', 'drop'] as const) {
    window.addEventListener(type, (event) => {
      if (carriesFiles(event)) event.preventDefault();
    });
  }
}

/** Drop handlers that post a .fit onto one workout: the server reads it, marks it done and keeps the stats. */
export function useFitDrop(workout: Workout, onRecorded: () => void) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Enter and leave fire for every child crossed, so one leave is not the pointer leaving.
  const depth = useRef(0);

  const handlers = {
    onDragEnter: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setOver(true);
    },
    onDragOver: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      depth.current = 0;
      setOver(false);

      const files = Array.from(event.dataTransfer.files);
      const file = files[0];
      if (files.length !== 1 || !file.name.toLowerCase().endsWith('.fit')) {
        setError('Drop a single .fit file');
        return;
      }

      setBusy(true);
      setError(null);
      uploadRecording(workout, file).then(
        () => onRecorded(),
        (failure: Error) => setError(failure.message),
      ).finally(() => setBusy(false));
    },
  };

  return { over, busy, error, handlers };
}
