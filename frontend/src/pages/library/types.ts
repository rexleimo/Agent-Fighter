export type DocCategory = 'skill' | 'doc' | 'example' | 'config';

export type DocEntry = {
  path: string;
  url: string;
  title: string;
  description: string;
  category: DocCategory;
  audience: string;
  keywords: string;
  lines: number;
  bytes: number;
};

export type DocsManifest = {
  docs: DocEntry[];
  total: { files: number; lines: number; bytes: number };
};

export const CATEGORY_LABEL: Record<DocCategory, string> = {
  skill: '技能', doc: '手册', example: '示例', config: '配置',
};
