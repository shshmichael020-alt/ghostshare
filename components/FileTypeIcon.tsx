import {
  FileArchive,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  File as FileGeneric,
  type LucideIcon,
} from "lucide-react";

const EXT_MAP: Record<string, LucideIcon> = {
  // images
  png: FileImage, jpg: FileImage, jpeg: FileImage, gif: FileImage, webp: FileImage, svg: FileImage, heic: FileImage,
  // video
  mp4: FileVideo, mov: FileVideo, mkv: FileVideo, avi: FileVideo, webm: FileVideo,
  // audio
  mp3: FileAudio, wav: FileAudio, m4a: FileAudio, flac: FileAudio, aac: FileAudio,
  // archives
  zip: FileArchive, rar: FileArchive, "7z": FileArchive, tar: FileArchive, gz: FileArchive,
  // docs
  pdf: FileText, doc: FileText, docx: FileText, txt: FileText, md: FileText,
  // spreadsheets
  xls: FileSpreadsheet, xlsx: FileSpreadsheet, csv: FileSpreadsheet,
};

export function FileTypeIcon({ name, className, size = 18 }: { name: string; className?: string; size?: number }) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const Icon = EXT_MAP[ext] ?? FileGeneric;
  return <Icon className={className} size={size} strokeWidth={1.75} />;
}
