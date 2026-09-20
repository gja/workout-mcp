import type { ReactNode } from 'react';

/**
 * A `<details>` accordion: the shared `name` is what makes the browser close
 * the other sections, so there is no open-section state to hold here.
 */
export function Accordion({ children }: { children: ReactNode }) {
  return <div className="accordion">{children}</div>;
}

/** A section opened from elsewhere on the page; the browser closes its siblings itself. */
export function openSection(id: string) {
  const section = document.getElementById(id);
  if (!(section instanceof HTMLDetailsElement)) return;
  section.open = true;
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function Section({
  group,
  id,
  title,
  hint,
  children,
}: {
  group: string;
  /** Only where something links to it; `openSection` is how it is reached. */
  id?: string;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <details className="section" id={id} name={group}>
      <summary>
        <span className="section-title">{title}</span>
        {hint && <span className="section-hint">{hint}</span>}
      </summary>
      <div className="section-body">{children}</div>
    </details>
  );
}
