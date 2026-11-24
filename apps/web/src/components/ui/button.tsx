import React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/cn';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-2xl text-sm font-semibold transition active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50',
  {
    variants: {
      variant: {
        primary: 'bg-blue-600 text-white shadow-lg shadow-blue-600/20 hover:bg-blue-700',
        secondary: 'border border-slate-200 bg-white/80 text-slate-800 shadow-sm hover:bg-white',
        ghost: 'text-slate-600 hover:bg-white/70',
        accent: 'bg-cyan-400 text-slate-950 shadow-lg shadow-cyan-400/20 hover:bg-cyan-300',
      },
      size: {
        sm: 'h-9 px-3',
        md: 'h-11 px-4',
        icon: 'h-11 w-11 rounded-full p-0',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>;

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, ...props }, ref) => (
  <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
));
Button.displayName = 'Button';
