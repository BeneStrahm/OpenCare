import React from 'react';
import { cn } from '../../lib/utils';

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
    label?: string;
    error?: string;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
    ({ className, label, error, id, ...props }, ref) => {
        const autoId = React.useId();
        const textareaId = id || autoId;
        return (
            <div className="w-full">
                {label && (
                    <label htmlFor={textareaId} className="mb-1.5 block text-caption font-medium text-foreground">
                        {label}
                    </label>
                )}
                <textarea
                    id={textareaId}
                    className={cn(
                        'input-nexus min-h-[96px] resize-y py-2.5',
                        error && 'border-destructive focus-visible:ring-destructive',
                        className
                    )}
                    ref={ref}
                    {...props}
                />
                {error && <p className="mt-1.5 text-micro text-destructive">{error}</p>}
            </div>
        );
    }
);

Textarea.displayName = 'Textarea';
