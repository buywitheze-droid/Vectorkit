"use client";

import { Circle } from "lucide-react";
import { cn } from "@/lib/utils";

export interface HistoryStep {
  label: string;
}

interface HistoryBreadcrumbsProps {
  steps: HistoryStep[];
  currentIndex: number;
  onJump: (index: number) => void;
}

export function HistoryBreadcrumbs({
  steps,
  currentIndex,
  onJump,
}: HistoryBreadcrumbsProps) {
  if (steps.length <= 1) return null;
  return (
    <div className="flex items-center gap-1 overflow-x-auto py-1 px-1">
      {steps.map((step, i) => {
        const isCurrent = i === currentIndex;
        const isPast = i < currentIndex;
        return (
          <div key={i} className="flex items-center gap-1 shrink-0">
            {i > 0 && (
              <div
                className={cn(
                  "h-px w-3",
                  i <= currentIndex ? "bg-primary" : "bg-border"
                )}
              />
            )}
            <button
              onClick={() => onJump(i)}
              className={cn(
                "flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap",
                isCurrent
                  ? "bg-primary text-primary-foreground"
                  : isPast
                    ? "text-foreground hover:bg-muted"
                    : "text-muted-foreground hover:bg-muted opacity-60"
              )}
              title={`Step ${i}: ${step.label}`}
            >
              <Circle
                className={cn(
                  "h-1.5 w-1.5",
                  isCurrent ? "fill-current" : isPast ? "fill-current text-primary" : ""
                )}
              />
              {step.label}
            </button>
          </div>
        );
      })}
    </div>
  );
}
