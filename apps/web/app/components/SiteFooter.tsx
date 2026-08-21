import { Reveal } from './Reveal';

export function SiteFooter() {
  return (
    <footer className="foot">
      <div className="wrap">
        <Reveal>
          <p className="ep">
            The struggle itself toward the heights is enough to fill a man&apos;s heart. One must
            imagine Sisyphus happy.
          </p>
          <p className="att">Albert Camus, The Myth of Sisyphus (tr. Justin O&apos;Brien)</p>
          <p className="riff">One must imagine the agents happy.</p>
        </Reveal>
        <p className="foot-note">
          The pieces through the page are original cover studies, after the Vintage International
          Camus paperbacks. The boulder is the thread that runs through them.
        </p>
        <div className="foot-links">
          <span>
            Camus. Formerly{' '}
            <a href="https://github.com/mateodaza/nightcrawler">Nightcrawler v2</a>. Open source,
            trusted-code tool.
          </span>
          <span>
            <a href="https://github.com/mateodaza/camus">github</a>
            {'  ·  '}
            <a href="https://www.npmjs.com/package/camus-cli">npm</a>
            {'  ·  '}
            <a href="https://github.com/mateodaza/camus/releases/tag/v0.4.1">v0.4.1</a>
            {'  ·  '}
            <a href="/studio/">loop studio</a>
          </span>
        </div>
      </div>
    </footer>
  );
}
