import type { ReactNode, SVGProps } from 'react';

export type IconName =
  | 'activity'
  | 'arrow-right'
  | 'check'
  | 'chevron-left'
  | 'connections'
  | 'copy'
  | 'key'
  | 'logout'
  | 'play'
  | 'plus'
  | 'sparkles'
  | 'upload';

const PATHS: Record<IconName, ReactNode> = {
  activity: <path d="M4 13h3l2-7 4 12 2-7h5" />,
  'arrow-right': <path d="M5 12h14m-5-5 5 5-5 5" />,
  check: <path d="m5 12 4 4L19 6" />,
  'chevron-left': <path d="m15 18-6-6 6-6" />,
  connections: (
    <>
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M8 7.5 16 16M16 6h2v4M8 18H6v-4" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="10" height="10" rx="2" />
      <path d="M15 9V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 8-8m-3 3 2 2m-5 1 2 2" />
    </>
  ),
  logout: <path d="M10 17l5-5-5-5m5 5H3m12-7h4a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-4" />,
  play: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m10 9 5 3-5 3Z" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  sparkles: <path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2L12 3ZM5 14l.8 2.2L8 17l-2.2.8L5 20l-.8-2.2L2 17l2.2-.8L5 14Zm14-2 .7 1.8 1.8.7-1.8.7L19 17l-.7-1.8-1.8-.7 1.8-.7L19 12Z" />,
  upload: <path d="M12 16V4m-4 4 4-4 4 4M5 14v5h14v-5" />,
};

export function Icon({ name, ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {PATHS[name]}
    </svg>
  );
}
