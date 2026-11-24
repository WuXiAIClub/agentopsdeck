import React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/cn';

const badgeVariants = cva('inline-flex items-center rounded-full border px-2.5 py-1 text-[0.72rem] font-semibold leading-none', {
  variants: {
    variant: {
      default: 'border-slate-200 bg-white/80 text-slate-600',
      active: 'border-emerald-200 bg-emerald-50 text-emerald-700',
      running: 'border-emerald-300 bg-emerald-500 text-white shadow-sm shadow-emerald-500/30 ring-2 ring-emerald-300/35',
      accent: 'border-cyan-200 bg-cyan-50 text-cyan-700',
      muted: 'border-slate-200 bg-slate-100/80 text-slate-500',
    },
  },
  defaultVariants: { variant: 'default' },
});

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
