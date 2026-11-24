import React from 'react';
import { cn } from '../../lib/cn';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, id, ...props }, ref) => {
  const generatedId = React.useId();
  return <input
    id={id ?? generatedId}
    ref={ref}
    className={cn('h-11 w-full rounded-2xl border border-slate-200 bg-white/80 px-4 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10', className)}
    {...props}
  />;
});
Input.displayName = 'Input';
