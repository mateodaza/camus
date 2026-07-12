// The mark is a square crop of `the-climb` cover that keeps its whole character:
// the saddle the boulder rests in, the boulder, and the slope it climbs. The ridge
// runs UNBROKEN to the top-right corner (2026-06-10: the old peak left a white
// triangle above it that read as noise when small — one slope, fully black, closes
// the mark). (The original abstract Slope lives on in Mark.tsx for legacy.)
export function SiteNav() {
  return (
    <nav className="nav">
      <div className="wrap nav-in">
        <a className="brand" href="#top" aria-label="Camus, top of page">
          <svg className="brand-mark" viewBox="0 170 400 400" role="img" aria-label="Camus">
            <polygon points="-24,456 40,520 416,144 416,600 -24,600" fill="currentColor" />
            <circle cx="190" cy="307" r="50" fill="currentColor" />
          </svg>
          <span className="brand-wm">Camus</span>
        </a>
        <div className="nav-links">
          <a className="nav-sm-hide" href="#watch">how it works</a>
          <a className="nav-sm-hide" href="#philosophy">philosophy</a>
          <a href="#studio">studio</a>
          <a href="https://github.com/mateodaza/camus">GitHub</a>
        </div>
      </div>
    </nav>
  );
}
