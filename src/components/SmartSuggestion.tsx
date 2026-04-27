"use client";

import { ArrowRight, Lightbulb, X } from "lucide-react";
import { useState } from "react";
import type { DetectionResult } from "@/lib/image/detect";
import { Button } from "@/components/ui/Button";

interface SmartSuggestionProps {
  detection: DetectionResult;
  onActOn: (action: DetectionResult["recommendedAction"]) => void;
}

const ACTION_LABEL: Record<DetectionResult["recommendedAction"], string> = {
  "remove-bg-color": "Remove Background by Color",
  "remove-bg-ai": "Use AI Background Removal",
  "ready-to-resize": "Resize for Print",
  "enhance-photo": "Auto-Enhance Photo",
};

export function SmartSuggestion({ detection, onActOn }: SmartSuggestionProps) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  const typeLabel =
    detection.type === "photo"
      ? "Photograph"
      : detection.type === "graphic-with-transparency"
        ? "Transparent Design"
        : "Logo / Graphic";

  return (
    <div className="border-b border-border bg-gradient-to-r from-primary/5 via-accent/5 to-transparent">
      <div className="px-4 py-2.5 flex items-center gap-3">
        <div className="h-8 w-8 rounded-full brand-gradient flex items-center justify-center text-white shrink-0">
          <Lightbulb className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-semibold">Detected: {typeLabel}</span>
            <span className="text-muted-foreground hidden md:inline">·</span>
            <span className="text-muted-foreground hidden md:inline truncate">
              {detection.recommendedReason}
            </span>
          </div>
        </div>
        <Button
          size="sm"
          variant="primary"
          onClick={() => onActOn(detection.recommendedAction)}
          className="shrink-0"
        >
          {ACTION_LABEL[detection.recommendedAction]}
          <ArrowRight className="h-3.5 w-3.5" />
        </Button>
        <button
          onClick={() => setDismissed(true)}
          className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          aria-label="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
