export interface RankingBook {
  id: string;
  rank: number;
  title: string;
  author: string;
  category: string;
  score: string;
  readCount: string;
  wordCount: string;
  status: string;
  description: string;
  coverUrl?: string;
  metadataMissing?: boolean;
}
export interface RankingCatalog {
  male: { id: string; name: string }[];
  female: { id: string; name: string }[];
}
export interface RankingPage {
  books: RankingBook[];
  total: number;
  nextOffset: number;
  hasMore: boolean;
  version: string;
  fetchedAt: number;
  sourceUrl: string;
  warning: string;
}
