'use client';

import { useEffect, useRef, type ReactNode } from 'react';

// Reveals its children with a rise-and-fade the first time they scroll into view,
// so moving down the page reads as climbing. IntersectionObserver keeps it cheap
// and universal; CSS handles the motion (and honors prefers-reduced-motion).
export function Reveal({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !('IntersectionObserver' in window)) return;
    // The server-rendered default is visible. Enhance only content below the
    // current viewport, so a script or hydration failure never blanks the page.
    if (el.getBoundingClientRect().top < window.innerHeight) {
      el.classList.add('is-in');
      return;
    }
    el.classList.add('is-pending');
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            el.classList.add('is-in');
            el.classList.remove('is-pending');
            io.disconnect();
          }
        }
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.12 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} className={className ? `reveal ${className}` : 'reveal'}>
      {children}
    </div>
  );
}
