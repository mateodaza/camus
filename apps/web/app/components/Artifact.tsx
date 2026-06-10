import type { ReactNode } from 'react';

type Tone = 'light' | 'dark';

// A real receipt from a run: a file path header and its raw contents.
// Concrete evidence, not a feature card.
export function Artifact({
  path,
  tone = 'light',
  label,
  children,
}: {
  path: string;
  tone?: Tone;
  label?: string;
  children: ReactNode;
}) {
  return (
    <figure className={tone === 'dark' ? 'art art--dark' : 'art'} aria-label={label ?? path}>
      <span className="art-path">{path}</span>
      <pre>{children}</pre>
    </figure>
  );
}
