"use client";

import { createContext, useContext, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const TabsContext = createContext<{
  value: string;
  onChange: (v: string) => void;
} | null>(null);

interface TabsProps {
  value: string;
  onValueChange: (v: string) => void;
  children: ReactNode;
  className?: string;
}

export function Tabs({ value, onValueChange, children, className }: TabsProps) {
  return (
    <TabsContext.Provider value={{ value, onChange: onValueChange }}>
      <div className={cn("w-full", className)}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabsList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "inline-flex w-full items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground gap-1",
        className
      )}
    >
      {children}
    </div>
  );
}

export function TabsTrigger({
  value: tabValue,
  children,
  disabled,
}: {
  value: string;
  children: ReactNode;
  disabled?: boolean;
}) {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error("TabsTrigger outside Tabs");
  const isActive = ctx.value === tabValue;
  return (
    <button
      type="button"
      onClick={() => ctx.onChange(tabValue)}
      disabled={disabled}
      className={cn(
        "flex-1 inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-all cursor-pointer",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:opacity-50",
        isActive
          ? "bg-card text-foreground shadow-sm"
          : "hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

export function TabsContent({
  value: tabValue,
  children,
  className,
}: {
  value: string;
  children: ReactNode;
  className?: string;
}) {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error("TabsContent outside Tabs");
  if (ctx.value !== tabValue) return null;
  return <div className={cn("animate-fade-in", className)}>{children}</div>;
}
