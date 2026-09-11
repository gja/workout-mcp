import { useState } from 'react';

/** Copying can fail outside a secure context, so say so rather than doing nothing. */
export function CopyButton({ label, text }: { label: string; text: string }) {
  const [state, setState] = useState<string | null>(null);

  const copy = async () => {
    const ok = await navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    );
    setState(ok ? 'Copied' : 'Copy failed');
    setTimeout(() => setState(null), 1500);
  };

  return (
    <button className="link" onClick={copy}>
      {state ?? label}
    </button>
  );
}
