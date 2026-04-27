"use client";

import { useCallback, useRef, useState } from "react";
import { UploadCloud, FileImage } from "lucide-react";
import { cn, formatBytes } from "@/lib/utils";

interface UploaderProps {
  onFile: (file: File) => void;
  className?: string;
}

export function Uploader({ onFile, className }: UploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const file = files[0];
      if (!file.type.startsWith("image/")) {
        alert("Please upload an image file (PNG, JPG, WEBP).");
        return;
      }
      onFile(file);
    },
    [onFile]
  );

  return (
    <div
      className={cn(
        "relative w-full max-w-2xl mx-auto rounded-2xl border-2 border-dashed transition-all",
        "p-12 text-center cursor-pointer group",
        dragOver
          ? "border-primary bg-primary/5 scale-[1.01]"
          : "border-border bg-card hover:border-primary/40 hover:bg-muted/50",
        className
      )}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        handleFiles(e.dataTransfer.files);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
      <div
        className={cn(
          "mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full transition-all",
          dragOver
            ? "bg-primary text-primary-foreground scale-110"
            : "bg-muted text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary"
        )}
      >
        <UploadCloud className="h-8 w-8" />
      </div>
      <h3 className="text-lg font-semibold mb-1">
        {dragOver ? "Drop your image here" : "Upload an image to get started"}
      </h3>
      <p className="text-sm text-muted-foreground mb-4">
        Drag and drop or click to browse — PNG, JPG, WEBP up to 50&nbsp;MB
      </p>
      <div className="inline-flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 px-3 py-1.5 rounded-full">
        <FileImage className="h-3.5 w-3.5" />
        Your image stays in your browser — never uploaded to a server
      </div>
    </div>
  );
}

export function FileChip({ file }: { file: File }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full bg-muted px-3 py-1 text-xs">
      <FileImage className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="font-medium truncate max-w-[200px]">{file.name}</span>
      <span className="text-muted-foreground">{formatBytes(file.size)}</span>
    </div>
  );
}
