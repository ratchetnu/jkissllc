'use client';

import { useEffect, useRef, useState, type ElementType, type CSSProperties, type ReactNode } from 'react';

/**
 * Scroll-reveal wrapper. Adds `.in` when the element enters the viewport so the
 * `.reveal` transition in globals.css plays. Supports a stagger `delay` (ms) via
 * the `--d` CSS var. Respects prefers-reduced-motion (handled in CSS).
 */
export default function Reveal({
  children,
  as,
  delay = 0,
  className = '',
  style,
  once = true,
}: {
  children: ReactNode;
  as?: ElementType;
  delay?: number;
  className?: string;
  style?: CSSProperties;
  once?: boolean;
}) {
  const Tag = (as || 'div') as ElementType;
  const ref = useRef<HTMLElement | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          if (once) io.disconnect();
        } else if (!once) {
          setInView(false);
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [once]);

  return (
    <Tag
      ref={ref as never}
      className={`reveal ${inView ? 'in' : ''} ${className}`.trim()}
      style={{ ...(delay ? ({ ['--d']: `${delay}ms` } as CSSProperties) : null), ...style }}
    >
      {children}
    </Tag>
  );
}
