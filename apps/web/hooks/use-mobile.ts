import * as React from 'react';

/** UI guide §8: mobile is below 768px. */
const MOBILE_BREAKPOINT = 768;

/** Whether the viewport is narrower than `breakpoint` px (undefined until mounted). */
export function useIsBelow(breakpoint: number) {
  const [below, setBelow] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const onChange = () => setBelow(window.innerWidth < breakpoint);
    mql.addEventListener('change', onChange);
    setBelow(window.innerWidth < breakpoint);
    return () => mql.removeEventListener('change', onChange);
  }, [breakpoint]);

  return !!below;
}

export function useIsMobile() {
  return useIsBelow(MOBILE_BREAKPOINT);
}
