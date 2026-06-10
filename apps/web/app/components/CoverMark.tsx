// A composition of half-square triangles in the Vintage International Camus cover
// tradition: the big Slope, with its peak dissolving into a recursive run of nested
// triangles toward the corner (the loop, frozen), balanced by a smaller triangle
// in the opposite corner. Every shape is a half-square, every angle 45 degrees.
export function CoverMark() {
  return (
    <svg
      className="cover-art"
      viewBox="0 0 300 300"
      role="img"
      aria-label="Half-square triangles in the Camus cover tradition: the slope nesting recursively into its peak"
    >
      <rect width="300" height="300" fill="#FFFFFF" />
      <polygon points="0,0 96,0 0,96" fill="#0A0A0A" />
      <polygon points="0,300 300,300 300,0" fill="#0A0A0A" />
      <polygon points="150,150 300,150 300,0" fill="#FFFFFF" />
      <polygon points="225,75 300,75 300,0" fill="#0A0A0A" />
      <polygon points="262.5,37.5 300,37.5 300,0" fill="#FFFFFF" />
      <polygon points="281.25,18.75 300,18.75 300,0" fill="#0A0A0A" />
    </svg>
  );
}
