export function Logo({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="vk-grad" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#ec4899" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="28" height="28" rx="7" fill="url(#vk-grad)" />
      <path
        d="M9 10 L16 22 L23 10"
        stroke="white"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <circle cx="9" cy="10" r="1.6" fill="white" />
      <circle cx="23" cy="10" r="1.6" fill="white" />
      <circle cx="16" cy="22" r="1.6" fill="white" />
    </svg>
  );
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={className}>
      <span className="font-bold">The</span>
      <span className="brand-gradient-text font-bold">VectorKit</span>
    </span>
  );
}
