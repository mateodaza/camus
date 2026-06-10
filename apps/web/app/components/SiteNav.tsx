import { Mark } from './Mark';

export function SiteNav() {
  return (
    <nav className="nav">
      <div className="wrap nav-in">
        <a className="brand" href="#top" aria-label="Camus, top of page">
          <Mark className="brand-mark" />
          <span className="brand-wm">Camus</span>
        </a>
        <div className="nav-links">
          <a className="nav-sm-hide" href="#watch">how it works</a>
          <a className="nav-sm-hide" href="#philosophy">philosophy</a>
          <a href="https://github.com/mateodaza/camus">GitHub</a>
        </div>
      </div>
    </nav>
  );
}
