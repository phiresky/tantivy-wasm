export type ToWorker =
  | {
      type: "search";
      indexUrl: string;
      fields?: string[];
      searchText: string;
    }
  | {
      type: "getReadStats";
    };

export type Doc = {
  score: number;
  doc: { authors: string; title: string; filename: string };
};
export type Stat = { reason: string; amount: number; count: number };
export type ToMain =
  | {
      type: "searchResult";
      result: Doc[];
    }
  | {
      type: "stats";
      stats: Stat[];
    };
