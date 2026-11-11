import { cn } from '@/lib/utils';
import {
  File,
  FileArchive,
  FileBraces,
  FileCode,
  FileImage,
  FileMusic,
  FileSpreadsheet,
  FileText,
  FileVideoCamera,
} from 'lucide-react';

const KINDS = {
  image: { icon: FileImage, color: 'text-rose-500' },
  video: { icon: FileVideoCamera, color: 'text-violet-500' },
  audio: { icon: FileMusic, color: 'text-pink-500' },
  pdf: { icon: FileText, color: 'text-red-600' },
  sheet: { icon: FileSpreadsheet, color: 'text-emerald-600' },
  archive: { icon: FileArchive, color: 'text-amber-600' },
  data: { icon: FileBraces, color: 'text-sky-600' },
  code: { icon: FileCode, color: 'text-indigo-500' },
  text: { icon: FileText, color: 'text-blue-500' },
  other: { icon: File, color: 'text-muted-foreground' },
};

const BY_EXTENSION: Record<string, keyof typeof KINDS> = {
  pdf: 'pdf',
  csv: 'sheet',
  tsv: 'sheet',
  xls: 'sheet',
  xlsx: 'sheet',
  zip: 'archive',
  gz: 'archive',
  tgz: 'archive',
  tar: 'archive',
  '7z': 'archive',
  rar: 'archive',
  json: 'data',
  jsonl: 'data',
  yaml: 'data',
  yml: 'data',
  xml: 'data',
  toml: 'data',
  js: 'code',
  ts: 'code',
  py: 'code',
  go: 'code',
  sh: 'code',
  html: 'code',
  css: 'code',
  sql: 'code',
  md: 'text',
  txt: 'text',
  log: 'text',
  doc: 'text',
  docx: 'text',
};

function fileKind(name: string, mimeType: string) {
  const dot = name.lastIndexOf('.');
  const extension = dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
  if (Object.hasOwn(BY_EXTENSION, extension)) {
    return KINDS[BY_EXTENSION[extension]];
  }

  const [type] = mimeType.toLowerCase().split('/');
  if (
    type === 'image' ||
    type === 'video' ||
    type === 'audio' ||
    type === 'text'
  ) {
    return KINDS[type];
  }
  return KINDS.other;
}

/** Use the filename first so files stored as generic text still get a useful icon. */
export function FileIcon({
  name,
  mimeType,
  className,
}: {
  name: string;
  mimeType: string;
  className?: string;
}) {
  const { icon: Icon, color } = fileKind(name, mimeType);
  return (
    <Icon
      aria-hidden="true"
      className={cn('size-4 shrink-0', color, className)}
    />
  );
}
