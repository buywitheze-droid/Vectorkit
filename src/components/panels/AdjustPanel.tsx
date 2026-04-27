"use client";

import { Crop, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";

interface AdjustPanelProps {
  onAutoCrop: () => Promise<void> | void;
  isProcessing: boolean;
  disabled?: boolean;
}

export function AdjustPanel({ onAutoCrop, isProcessing, disabled }: AdjustPanelProps) {
  return (
    <div className="space-y-3 pt-2">
      <p className="text-sm text-muted-foreground">
        Trim transparent edges so the design is tightly bound — useful before sizing for print.
      </p>

      <Button
        variant="gradient"
        className="w-full"
        onClick={onAutoCrop}
        disabled={disabled || isProcessing}
      >
        {isProcessing ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Cropping…
          </>
        ) : (
          <>
            <Crop className="h-4 w-4" /> Auto-Crop Transparent Edges
          </>
        )}
      </Button>
    </div>
  );
}
