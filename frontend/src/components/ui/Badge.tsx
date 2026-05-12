import { forwardRef } from 'react'
import { cn } from '../../lib/utils'

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'outline'
}

export const Badge = forwardRef<HTMLDivElement, BadgeProps>(
  ({ className, variant = 'default', ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
          {
            'border-transparent bg-surface text-text hover:bg-border': variant === 'default',
            'border-transparent bg-success/20 text-success': variant === 'success',
            'border-transparent bg-warning/20 text-warning': variant === 'warning',
            'border-transparent bg-danger/20 text-danger': variant === 'danger',
            'border-transparent bg-info/20 text-info': variant === 'info',
            'border-border text-text': variant === 'outline',
          },
          className
        )}
        {...props}
      />
    )
  }
)
Badge.displayName = 'Badge'
