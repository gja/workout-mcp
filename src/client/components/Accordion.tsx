import type { ReactNode } from 'react';

/**
 * A `<details>` accordion: the shared `name` is what makes the browser close
 * the other sections, so there is no open-section state to hold here.
 */
export function Accordion({ children }: { children: ReactNode }) {
  return <div className="accordion">{children}</div>;
}

export function Section({
  group,
  title,
  hint,
  children,
}: {
  group: string;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <details className="section" name={group}>
      <summary>
        <span className="section-title">{title}</span>
        {hint && <span className="section-hint">{hint}</span>}
      </summary>
      <div className="section-body">{children}</div>
    </details>
  );
}
