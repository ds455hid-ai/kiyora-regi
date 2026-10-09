const PATHS: Record<string, string> = {
  register: 'M6 3h12v18l-3-2-3 2-3-2-3 2V3zm3 5h6m-6 4h6',
  handover: 'M4 11h16a8 8 0 0 1-16 0zm5-7c-1 1.2 1 2.2 0 3.4m5-3.4c-1 1.2 1 2.2 0 3.4',
  cash: 'M4 7h16v10H4zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM7 10v4m10-4v4',
  sales: 'M5 20V10m5 10V4m5 16v-7m5 7H3',
  admin: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm8 3-2 .8-.4 1 1 1.9-1.4 1.4-1.9-1-1 .4L12.7 20h-2l-.8-2-1-.4-1.9 1L5.6 17.2l1-1.9-.4-1L4 13.5v-2l2-.8.4-1-1-1.9L6.8 6.4l1.9 1 1-.4L10.5 5h2l.8 2 1 .4 1.9-1 1.4 1.4-1 1.9.4 1 2 .8z',
}

export function Icon({ name }: { name: keyof typeof PATHS }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  )
}
