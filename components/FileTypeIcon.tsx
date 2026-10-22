"use client";

import {
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  File as FileGeneric,
  type LucideIcon,
} from "lucide-react";

interface ExtConfig {
  icon: LucideIcon;
  colorClass: string;
}

const EXT_MAP: Record<string, ExtConfig> = {
  // Images
  png: { icon: FileImage, colorClass: "text-secondary" },
  jpg: { icon: FileImage, colorClass: "text-secondary" },
  jpeg: { icon: FileImage, colorClass: "text-secondary" },
  gif: { icon: FileImage, colorClass: "text-secondary" },
  webp: { icon: FileImage, colorClass: "text-secondary" },
  svg: { icon: FileImage, colorClass: "text-secondary" },
  heic: { icon: FileImage, colorClass: "text-secondary" },

  // Video
  mp4: { icon: FileVideo, colorClass: "text-primary" },
  mov: { icon: FileVideo, colorClass: "text-primary" },
  mkv: { icon: FileVideo, colorClass: "text-primary" },
  avi: { icon: FileVideo, colorClass: "text-primary" },
  webm: { icon: FileVideo, colorClass: "text-primary" },

  // Audio
  mp3: { icon: FileAudio, colorClass: "text-tertiary" },
  wav: { icon: FileAudio, colorClass: "text-tertiary" },
  m4a: { icon: FileAudio, colorClass: "text-tertiary" },
  flac: { icon: FileAudio, colorClass: "text-tertiary" },
  aac: { icon: FileAudio, colorClass: "text-tertiary" },

  // Archives
  zip: { icon: FileArchive, colorClass: "text-secondary" },
  rar: { icon: FileArchive, colorClass: "text-secondary" },
  "7z": { icon: FileArchive, colorClass: "text-secondary" },
  tar: { icon: FileArchive, colorClass: "text-secondary" },
  gz: { icon: FileArchive, colorClass: "text-secondary" },

  // Documents
  pdf: { icon: FileText, colorClass: "text-error" },
  doc: { icon: FileText, colorClass: "text-primary" },
  docx: { icon: FileText, colorClass: "text-primary" },
  txt: { icon: FileText, colorClass: "text-on-surface-variant" },
  md: { icon: FileText, colorClass: "text-on-surface-variant" },

  // Spreadsheets
  xls: { icon: FileSpreadsheet, colorClass: "text-tertiary" },
  xlsx: { icon: FileSpreadsheet, colorClass: "text-tertiary" },
  csv: { icon: FileSpreadsheet, colorClass: "text-tertiary" },

  // Code / Data
  json: { icon: FileCode, colorClass: "text-secondary" },
  js: { icon: FileCode, colorClass: "text-primary" },
  ts: { icon: FileCode, colorClass: "text-primary" },
  tsx: { icon: FileCode, colorClass: "text-primary" },
  html: { icon: FileCode, colorClass: "text-secondary" },
  css: { icon: FileCode, colorClass: "text-secondary" },
};

export function FileTypeIcon({
  name,
  className = "",
  size = 20,
}: {
  name: string;
  className?: string;
  size?: number;
}) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const config = EXT_MAP[ext] ?? { icon: FileGeneric, colorClass: "text-on-surface-variant" };
  const Icon = config.icon;

  return <Icon className={`${config.colorClass} ${className}`} size={size} strokeWidth={1.75} />;
}
