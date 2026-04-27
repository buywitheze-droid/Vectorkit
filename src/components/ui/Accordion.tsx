"use client";

import { ChevronDown } from "lucide-react";
import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface AccordionSectionProps {
  open: boolean;
  onToggle: () => void;
  title: string;
  icon?: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
}

/**
 * Single accordion section. Uses CSS grid 1fr → 0fr trick for smooth height
 * animation without measuring children.
 */
export function AccordionSection({
  open,
  onToggle,
  title,
  icon,
  badge,
  children,
}: AccordionSectionProps) {
  return (
    <div className={cn("border-b border-border", open && "bg-card/40")}>
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "w-full flex items-center gap-3 px-4 py-3 text-left transition-colors cursor-pointer",
          open ? "text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
        )}
      >
        {icon && (
          <div
            className={cn(
              "h-7 w-7 rounded-md flex items-center justify-center transition-colors shrink-0",
              open ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
            )}
          >
            {icon}
          </div>
        )}
        <span className="font-semibold text-sm flex-1">{title}</span>
        {badge}
        <ChevronDown
          className={cn(
            "h-4 w-4 transition-transform shrink-0",
            open ? "rotate-180 text-primary" : "text-muted-foreground"
          )}
        />
      </button>

      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div className="px-4 pb-4">{children}</div>
        </div>
      </div>
    </div>
  );
}
