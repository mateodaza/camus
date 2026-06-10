// The Camus mark in perpetual ascent: a constant-velocity conveyor on a steep saw
// (80 up, 16 down per tooth). The boulder climbs the 45 degree slope while the
// mountain range streams endlessly downward beneath it, so the scene reads as
// relentless upward motion. The motion lives in globals.css (CSS keyframes) so it
// honors prefers-reduced-motion, which freezes the boulder balanced on the summit.
// Decorative beside the headline, so aria-hidden.
export function ClimbLoop() {
  return (
    <svg className="climb" viewBox="26 22 134 108" aria-hidden="true">
      <clipPath id="climbClip">
        <rect x="26" y="22" width="134" height="108" />
      </clipPath>
      <g clipPath="url(#climbClip)">
        <g className="climb-scene">
          <polygon
            fill="#0A0A0A"
            points="-142,250 -62,170 -46,186 34,106 50,122 130,42 146,58 226,-22 242,-6 322,-86 322,340 -142,340"
          />
          <g className="climb-rock">
            <circle cx="50" cy="105.6" r="13" fill="#0A0A0A" />
          </g>
        </g>
      </g>
    </svg>
  );
}
