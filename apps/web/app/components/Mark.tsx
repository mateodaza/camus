// The Slope: the mountain (half-square triangle) and the boulder, mid-ascent.
// Uses currentColor so it inverts cleanly on dark grounds.
export function Mark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 120 120" role="img" aria-label="Camus">
      <polygon points="0,120 120,120 120,0" fill="currentColor" />
      <circle cx="63" cy="33" r="19" fill="currentColor" />
    </svg>
  );
}
