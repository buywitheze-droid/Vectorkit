"use client";

import { useState } from "react";
import { Editor } from "@/components/Editor";
import { WizardEditor } from "@/components/WizardEditor";

export default function Home() {
  const [mode, setMode] = useState<"wizard" | "advanced">("wizard");
  if (mode === "advanced") return <Editor />;
  return <WizardEditor onSwitchToAdvanced={() => setMode("advanced")} />;
}
